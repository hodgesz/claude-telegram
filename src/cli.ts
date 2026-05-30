#!/usr/bin/env node

import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import * as readline from "node:readline";
import { spawn, execSync } from "node:child_process";
import { Bot } from "grammy";

const DATA_DIR = path.join(os.homedir(), ".clautel");
const CONFIG_FILE = path.join(DATA_DIR, "config.json");
const PID_FILE = path.join(DATA_DIR, "daemon.pid");
const LOG_FILE = path.join(DATA_DIR, "app.log");
const MAX_LOG_SIZE = 5 * 1024 * 1024; // 5MB
const LOG_BACKUPS = 3;
const PLIST_PATH = path.join(
  os.homedir(),
  "Library",
  "LaunchAgents",
  "com.claude-telegram.daemon.plist"
);
const SYSTEMD_PATH = path.join(
  os.homedir(),
  ".config",
  "systemd",
  "user",
  "claude-telegram.service"
);

function ensureDataDir(): void {
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { mode: 0o700 });
  }
}

function resolveDaemonCmd(): string[] {
  const distPath = path.join(
    path.dirname(new URL(import.meta.url).pathname),
    "..",
    "dist",
    "daemon.js"
  );

  if (fs.existsSync(distPath)) {
    return ["node", distPath];
  }

  // Dev fallback
  const srcPath = path.join(
    path.dirname(new URL(import.meta.url).pathname),
    "daemon.ts"
  );
  return ["npx", "tsx", srcPath];
}

function getDaemonPid(): number | null {
  try {
    const pid = parseInt(fs.readFileSync(PID_FILE, "utf-8").trim());
    // Check if process is alive
    process.kill(pid, 0);
    return pid;
  } catch {
    return null;
  }
}

function rotateLog(): void {
  try {
    const stat = fs.statSync(LOG_FILE);
    if (stat.size < MAX_LOG_SIZE) return;
  } catch {
    return;
  }

  for (let i = LOG_BACKUPS; i >= 1; i--) {
    const from = i === 1 ? LOG_FILE : `${LOG_FILE}.${i - 1}`;
    const to = `${LOG_FILE}.${i}`;
    try {
      if (fs.existsSync(from)) {
        fs.renameSync(from, to);
      }
    } catch {
      // Rotation failed, continue
    }
  }
}

function readTailLines(
  filePath: string,
  n: number,
  maxBytes = 32768
): string[] {
  try {
    const stat = fs.statSync(filePath);
    const fd = fs.openSync(filePath, "r");
    const readSize = Math.min(maxBytes, stat.size);
    const buf = Buffer.alloc(readSize);
    fs.readSync(fd, buf, 0, readSize, Math.max(0, stat.size - readSize));
    fs.closeSync(fd);

    const lines = buf.toString("utf-8").split("\n");
    // Drop first line if it might be truncated
    if (stat.size > readSize) lines.shift();
    return lines.filter((l) => l.trim()).slice(-n);
  } catch {
    return [];
  }
}

// --- CLI Commands ---

async function cmdSetup(): Promise<void> {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  const ask = (q: string): Promise<string> =>
    new Promise((resolve) => rl.question(q, resolve));

  console.log("\n🔧 Claude Telegram Setup\n");

  // Step 1: Bot token
  const token = await ask("Manager bot token (from @BotFather): ");
  if (!token.match(/^\d+:[A-Za-z0-9_-]+$/)) {
    console.error("Invalid bot token format.");
    rl.close();
    process.exit(1);
  }

  // Validate token
  console.log("Validating token...");
  try {
    const bot = new Bot(token);
    const me = await bot.api.getMe();
    console.log(`✓ Bot: @${me.username}`);
  } catch (err) {
    console.error(`Invalid token: ${err}`);
    rl.close();
    process.exit(1);
  }

  // Step 2: Owner ID
  const ownerId = await ask(
    "Your Telegram user ID (send /start to @userinfobot): "
  );
  if (!ownerId.match(/^\d+$/)) {
    console.error("Invalid user ID.");
    rl.close();
    process.exit(1);
  }

  // Step 3: ngrok token (optional)
  const ngrokToken = await ask(
    "ngrok auth token (optional, for /preview - press Enter to skip): "
  );

  // Step 4: Anthropic API key (optional)
  const apiKey = await ask(
    "Anthropic API key (optional - press Enter to use system default): "
  );

  rl.close();

  // Save config
  ensureDataDir();
  const cfg: Record<string, string> = {
    TELEGRAM_BOT_TOKEN: token,
    TELEGRAM_OWNER_ID: ownerId,
  };
  if (ngrokToken) cfg.NGROK_AUTH_TOKEN = ngrokToken;
  if (apiKey) cfg.ANTHROPIC_API_KEY = apiKey;

  fs.writeFileSync(CONFIG_FILE, JSON.stringify(cfg, null, 2), {
    mode: 0o600,
  });

  console.log(`\n✓ Config saved to ${CONFIG_FILE}`);
  console.log("\nNext steps:");
  console.log("  claude-telegram start     Start the daemon");
  console.log("  claude-telegram status    Check status");
  console.log("  claude-telegram logs      View logs\n");

  // Offer to install service
  if (process.platform === "darwin") {
    const installService = await new Promise<string>((resolve) => {
      const rl2 = readline.createInterface({
        input: process.stdin,
        output: process.stdout,
      });
      rl2.question(
        "Install as macOS service (auto-start on login)? [y/N] ",
        (answer) => {
          rl2.close();
          resolve(answer);
        }
      );
    });
    if (installService.toLowerCase() === "y") {
      cmdInstallService();
    }
  }
}

function cmdStart(): void {
  const pid = getDaemonPid();
  if (pid) {
    console.log(`Daemon already running (PID ${pid}).`);
    return;
  }

  ensureDataDir();

  // Check config exists
  if (!fs.existsSync(CONFIG_FILE)) {
    console.error("Not configured. Run: claude-telegram setup");
    process.exit(1);
  }

  // Try launchctl first on macOS
  if (process.platform === "darwin" && fs.existsSync(PLIST_PATH)) {
    try {
      execSync(`launchctl load ${PLIST_PATH}`, { stdio: "pipe" });
      console.log("✓ Daemon started via launchd.");
      return;
    } catch {
      // Fall through to direct start
    }
  }

  // Try systemctl on Linux
  if (process.platform === "linux" && fs.existsSync(SYSTEMD_PATH)) {
    try {
      execSync("systemctl --user start claude-telegram", { stdio: "pipe" });
      console.log("✓ Daemon started via systemd.");
      return;
    } catch {
      // Fall through to direct start
    }
  }

  // Direct start
  startDirect();
}

function startDirect(): void {
  rotateLog();

  const daemonCmd = resolveDaemonCmd();
  const fd = fs.openSync(LOG_FILE, "a");

  const child = spawn(daemonCmd[0], daemonCmd.slice(1), {
    detached: true,
    stdio: ["ignore", fd, fd],
    env: process.env,
  });

  child.unref();
  fs.closeSync(fd);

  console.log(`✓ Daemon started (PID ${child.pid}).`);
  console.log(`  Logs: ${LOG_FILE}`);
}

function cmdStop(): void {
  // Try launchctl first on macOS
  if (process.platform === "darwin" && fs.existsSync(PLIST_PATH)) {
    try {
      execSync(`launchctl unload ${PLIST_PATH}`, { stdio: "pipe" });
      console.log("✓ Daemon stopped via launchd.");
      // Clean up PID file (ignore if it's already gone)
      try {
        fs.rmSync(PID_FILE);
      } catch {
        // no-op
      }
      return;
    } catch {
      // Fall through
    }
  }

  // Try systemctl on Linux
  if (process.platform === "linux" && fs.existsSync(SYSTEMD_PATH)) {
    try {
      execSync("systemctl --user stop claude-telegram", { stdio: "pipe" });
      console.log("✓ Daemon stopped via systemd.");
      return;
    } catch {
      // Fall through
    }
  }

  // Direct stop
  const pid = getDaemonPid();
  if (!pid) {
    console.log("Daemon is not running.");
    return;
  }

  try {
    process.kill(pid, "SIGTERM");
    console.log(`✓ Sent SIGTERM to PID ${pid}.`);
  } catch (err) {
    console.error(`Failed to stop daemon: ${err}`);
  }
}

function cmdStatus(): void {
  const pid = getDaemonPid();
  if (pid) {
    console.log(`✓ Daemon is running (PID ${pid}).`);
  } else {
    console.log("✗ Daemon is not running.");
  }
}

function cmdLogs(): void {
  if (!fs.existsSync(LOG_FILE)) {
    console.log("No log file found.");
    return;
  }

  // Print last 50 lines
  const lines = readTailLines(LOG_FILE, 50);
  for (const line of lines) {
    console.log(line);
  }

  // Watch for new lines
  console.log("\n--- Live tail (Ctrl+C to stop) ---\n");

  let lastSize = fs.statSync(LOG_FILE).size;

  const watcher = fs.watch(LOG_FILE, () => {
    try {
      const stat = fs.statSync(LOG_FILE);
      if (stat.size > lastSize) {
        const fd = fs.openSync(LOG_FILE, "r");
        const buf = Buffer.alloc(stat.size - lastSize);
        fs.readSync(fd, buf, 0, buf.length, lastSize);
        fs.closeSync(fd);
        process.stdout.write(buf.toString("utf-8"));
        lastSize = stat.size;
      } else if (stat.size < lastSize) {
        // File was rotated
        lastSize = 0;
      }
    } catch {
      // File may have been rotated
    }
  });

  process.on("SIGINT", () => {
    watcher.close();
    process.exit(0);
  });
}

function cmdInstallService(): void {
  ensureDataDir();
  const daemonCmd = resolveDaemonCmd();

  if (process.platform === "darwin") {
    const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>com.claude-telegram.daemon</string>
  <key>ProgramArguments</key>
  <array>
    ${daemonCmd.map((arg) => `<string>${arg}</string>`).join("\n    ")}
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>ThrottleInterval</key>
  <integer>35</integer>
  <key>StandardOutPath</key>
  <string>${LOG_FILE}</string>
  <key>StandardErrorPath</key>
  <string>${LOG_FILE}</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>${process.env.PATH}</string>
    <key>HOME</key>
    <string>${os.homedir()}</string>
  </dict>
</dict>
</plist>`;

    const dir = path.dirname(PLIST_PATH);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(PLIST_PATH, plist);
    console.log(`✓ Installed macOS service: ${PLIST_PATH}`);
    console.log("  Start with: launchctl load " + PLIST_PATH);
    return;
  }

  if (process.platform === "linux") {
    const unit = `[Unit]
Description=Claude Telegram Daemon
After=network.target

[Service]
Type=simple
ExecStart=${daemonCmd.join(" ")}
Restart=always
RestartSec=10
StandardOutput=append:${LOG_FILE}
StandardError=append:${LOG_FILE}
Environment=PATH=${process.env.PATH}
Environment=HOME=${os.homedir()}

[Install]
WantedBy=default.target
`;

    const dir = path.dirname(SYSTEMD_PATH);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(SYSTEMD_PATH, unit);
    execSync("systemctl --user daemon-reload", { stdio: "pipe" });
    console.log(`✓ Installed systemd service: ${SYSTEMD_PATH}`);
    console.log("  Start with: systemctl --user start claude-telegram");
    console.log("  Enable auto-start: systemctl --user enable claude-telegram");
    return;
  }

  console.error("Service install not supported on this platform.");
}

function cmdUninstallService(): void {
  if (process.platform === "darwin") {
    if (fs.existsSync(PLIST_PATH)) {
      try {
        execSync(`launchctl unload ${PLIST_PATH}`, { stdio: "pipe" });
      } catch {
        // May not be loaded
      }
      fs.rmSync(PLIST_PATH);
      console.log("✓ macOS service removed.");
    } else {
      console.log("No macOS service installed.");
    }
    return;
  }

  if (process.platform === "linux") {
    if (fs.existsSync(SYSTEMD_PATH)) {
      try {
        execSync("systemctl --user stop claude-telegram", { stdio: "pipe" });
        execSync("systemctl --user disable claude-telegram", { stdio: "pipe" });
      } catch {
        // May not be running
      }
      fs.rmSync(SYSTEMD_PATH);
      execSync("systemctl --user daemon-reload", { stdio: "pipe" });
      console.log("✓ systemd service removed.");
    } else {
      console.log("No systemd service installed.");
    }
    return;
  }

  console.error("Service uninstall not supported on this platform.");
}

// --- Main ---

const command = process.argv[2];

switch (command) {
  case "setup":
    cmdSetup();
    break;
  case "start":
    cmdStart();
    break;
  case "stop":
    cmdStop();
    break;
  case "status":
    cmdStatus();
    break;
  case "logs":
    cmdLogs();
    break;
  case "install-service":
    cmdInstallService();
    break;
  case "uninstall-service":
    cmdUninstallService();
    break;
  default:
    console.log(`Claude Telegram — Control Claude Code from Telegram

Usage: claude-telegram <command>

Commands:
  setup              Configure bot token, owner ID, and options
  start              Start the background daemon
  stop               Stop the daemon
  status             Check if daemon is running
  logs               Tail daemon logs
  install-service    Install as system service (macOS launchd / Linux systemd)
  uninstall-service  Remove system service
`);
    if (
      command &&
      command !== "help" &&
      command !== "--help" &&
      command !== "-h"
    ) {
      console.error(`Unknown command: ${command}`);
      process.exit(1);
    }
}
