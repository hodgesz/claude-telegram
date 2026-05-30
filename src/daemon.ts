import * as fs from "node:fs";
import * as path from "node:path";
import { DATA_DIR, config, ensureDataDir } from "./config.js";
import { loadBots, addBot, removeBot, type BotConfig } from "./store.js";
import { ClaudeBridge } from "./claude.js";
import { TunnelManager } from "./tunnel.js";
import { ScheduleManager, loadSchedules } from "./scheduler.js";
import { createManager, MANAGER_COMMANDS } from "./manager.js";
import { createWorker, WORKER_COMMANDS } from "./worker.js";
import { claudeToTelegram, splitMessage } from "./formatter.js";
import { logStatus, logError } from "./log.js";

const PID_FILE = path.join(DATA_DIR, "daemon.pid");
const HEALTH_CHECK_INTERVAL_MS = 300_000; // 5 min
const RESTART_COOLDOWN_MS = 120_000; // 2 min

interface WorkerEntry {
  config: BotConfig;
  bot: any;
  bridge: ClaudeBridge;
  tunnelManager: TunnelManager;
}

const activeWorkers = new Map<number, WorkerEntry>();
const workerErrors = new Map<number, number>(); // botId → last error timestamp

let scheduleManager: ScheduleManager;
let healthCheckTimer: ReturnType<typeof setInterval>;

async function startWorker(botConfig: BotConfig): Promise<void> {
  logStatus(`Starting worker @${botConfig.username} → ${botConfig.workingDir}`);

  const bridge = new ClaudeBridge(
    botConfig.id,
    botConfig.workingDir,
    botConfig.username
  );
  const tunnelManager = new TunnelManager(config.NGROK_AUTH_TOKEN);
  const bot = createWorker(botConfig, bridge, tunnelManager, scheduleManager);

  // Set commands for this bot
  try {
    await bot.api.setMyCommands(WORKER_COMMANDS);
  } catch (err) {
    logError(`Failed to set commands for @${botConfig.username}: ${err}`);
  }

  // Persist and register
  addBot(botConfig);
  activeWorkers.set(botConfig.id, {
    config: botConfig,
    bot,
    bridge,
    tunnelManager,
  });

  // Start polling with retry
  startPolling(botConfig.id, bot, 1);
}

async function startPolling(
  botId: number,
  bot: any,
  attempt: number
): Promise<void> {
  const maxAttempts = 3;

  try {
    bot.start({
      onStart: () => {
        const worker = activeWorkers.get(botId);
        logStatus(
          `Worker @${worker?.config.username ?? botId} polling started`
        );
      },
    });
  } catch (err: any) {
    if (err.message?.includes("409") && attempt < maxAttempts) {
      const delay = 15_000 * attempt;
      logStatus(
        `Worker ${botId}: 409 conflict, retry ${attempt}/${maxAttempts} in ${delay / 1000}s`
      );
      await new Promise((r) => setTimeout(r, delay));
      await startPolling(botId, bot, attempt + 1);
    } else {
      logError(`Worker ${botId} failed to start polling: ${err.message}`);
      const worker = activeWorkers.get(botId);
      if (worker) {
        worker.bridge.abortAll();
        activeWorkers.delete(botId);
      }
      workerErrors.set(botId, Date.now());
    }
  }
}

async function stopWorker(botId: number): Promise<void> {
  const worker = activeWorkers.get(botId);
  if (!worker) return;

  logStatus(`Stopping worker @${worker.config.username}`);

  worker.bridge.abortAll();
  scheduleManager.removeAllForBot(botId);
  await worker.tunnelManager.closeAll();

  try {
    await worker.bot.stop();
  } catch {
    // Bot may already be stopped
  }

  activeWorkers.delete(botId);
  removeBot(botId);
}

function getActiveWorkers(): Map<number, WorkerEntry> {
  return activeWorkers;
}

async function healthCheck(): Promise<void> {
  logStatus(`Health check: ${activeWorkers.size} active workers`);

  // Phase 1: Check each worker by calling getMe
  const deadConfigs: BotConfig[] = [];
  for (const [botId, worker] of activeWorkers) {
    try {
      await worker.bot.api.getMe();
    } catch (err) {
      logError(`Worker @${worker.config.username} health check failed: ${err}`);
      deadConfigs.push(worker.config);

      // Clean up dead worker
      worker.bridge.abortAll();
      await worker.tunnelManager.closeAll();
      try {
        await worker.bot.stop();
      } catch {
        // Already stopped
      }
      activeWorkers.delete(botId);
    }
  }

  // Phase 2: Restart dead workers
  for (const cfg of deadConfigs) {
    logStatus(`Restarting dead worker @${cfg.username}`);
    try {
      await startWorker(cfg);
    } catch (err) {
      logError(`Failed to restart @${cfg.username}: ${err}`);
    }
  }

  // Phase 3: Check for unloaded bots from config
  const savedBots = loadBots();
  for (const cfg of savedBots) {
    if (activeWorkers.has(cfg.id)) continue;

    const lastError = workerErrors.get(cfg.id) ?? 0;
    if (Date.now() - lastError < RESTART_COOLDOWN_MS) continue;

    logStatus(`Loading unregistered bot @${cfg.username}`);
    try {
      await startWorker(cfg);
    } catch (err) {
      logError(`Failed to load @${cfg.username}: ${err}`);
    }
  }
}

async function shutdown(): Promise<void> {
  logStatus("Shutting down...");

  clearInterval(healthCheckTimer);
  scheduleManager.stop();

  for (const [, worker] of activeWorkers) {
    worker.bridge.abortAll();
    await worker.tunnelManager.closeAll();
    try {
      await worker.bot.stop();
    } catch {
      // Already stopped
    }
    worker.bridge.saveState();
  }

  try {
    fs.rmSync(PID_FILE);
  } catch {
    // PID file already gone
  }

  logStatus("Shutdown complete");
  process.exit(0);
}

async function main(): Promise<void> {
  logStatus("Starting Claude Telegram daemon...");

  // Step 1: Ensure data directory
  ensureDataDir();

  // Step 2: Write PID file
  fs.writeFileSync(PID_FILE, String(process.pid), { mode: 0o600 });

  // Step 3: Create schedule manager
  scheduleManager = new ScheduleManager(
    async (botId, chatId, prompt, schedId) => {
      const worker = activeWorkers.get(botId);
      if (!worker) {
        logError(`Schedule ${schedId}: worker ${botId} not found`);
        return;
      }

      worker.bridge.clearSession(chatId);

      try {
        await worker.bridge.sendMessage(
          chatId,
          prompt,
          {
            onResult: async (result) => {
              const html = claudeToTelegram(result.text);
              const chunks = splitMessage(html);
              for (const chunk of chunks) {
                try {
                  await worker.bot.api.sendMessage(chatId, chunk, {
                    parse_mode: "HTML",
                  });
                } catch {
                  await worker.bot.api
                    .sendMessage(chatId, chunk)
                    .catch(() => {});
                }
              }
            },
            onError: async (error) => {
              await worker.bot.api
                .sendMessage(chatId, `⚠️ Scheduled task error: ${error}`)
                .catch(() => {});
            },
          },
          "bypassPermissions",
          25
        );
      } catch (err) {
        logError(`Schedule ${schedId} execution failed: ${err}`);
      }
    }
  );

  // Step 4: Create manager bot
  const managerBot = createManager(
    { startWorker, stopWorker, getActiveWorkers },
    scheduleManager
  );

  try {
    await managerBot.api.setMyCommands(MANAGER_COMMANDS);
  } catch (err) {
    logError(`Failed to set manager commands: ${err}`);
  }

  // Step 5: Load and start worker bots
  const savedBots = loadBots();
  logStatus(`Loading ${savedBots.length} saved worker bots...`);

  for (const botConfig of savedBots) {
    try {
      await startWorker(botConfig);
    } catch (err) {
      logError(`Failed to start worker @${botConfig.username}: ${err}`);
    }
  }

  // Step 6: Start schedule manager
  const savedSchedules = loadSchedules();
  scheduleManager.start(savedSchedules);

  // Step 7: Start health check
  healthCheckTimer = setInterval(healthCheck, HEALTH_CHECK_INTERVAL_MS);

  // Step 8: Register shutdown handlers
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  // Step 9: Start manager bot polling
  logStatus("Starting manager bot polling...");
  await startManagerPolling(managerBot);
}

async function startManagerPolling(managerBot: any): Promise<void> {
  // Set up error boundary for middleware errors
  managerBot.catch((err: any) => {
    logError(`Manager bot middleware error: ${err.message ?? err}`);
  });

  // Handle unhandled rejections from the polling loop
  process.on("unhandledRejection", (err: any) => {
    const is409 = String(err).includes("409");
    if (is409) {
      logError("Manager bot 409 conflict — will recover automatically.");
    } else {
      logError(`Unhandled rejection: ${err}`);
    }
  });

  // bot.start() handles init + polling in one call.
  // It returns a promise that runs the polling loop.
  // drop_pending_updates avoids processing stale messages.
  managerBot.start({
    drop_pending_updates: true,
    onStart: () => {
      logStatus(
        `Manager bot ready (@${managerBot.botInfo.username}). Send /help in Telegram.`
      );
    },
  });
}

main().catch((err) => {
  logError(`Daemon fatal error: ${err}`);
  process.exit(1);
});
