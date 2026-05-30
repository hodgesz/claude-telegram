import { Bot, type Context } from "grammy";
import * as fs from "node:fs";
import { config } from "./config.js";
import type { BotConfig } from "./store.js";
import type { ScheduleManager } from "./scheduler.js";
import { logStatus, logError } from "./log.js";

interface ManagerCallbacks {
  startWorker: (botConfig: BotConfig) => Promise<void>;
  stopWorker: (botId: number) => Promise<void>;
  getActiveWorkers: () => Map<
    number,
    { config: BotConfig; bot: any; bridge: any; tunnelManager: any }
  >;
}

interface ConversationState {
  step: "token" | "path";
  token?: string;
  timer: ReturnType<typeof setTimeout>;
}

const MANAGER_COMMANDS = [
  { command: "start", description: "Show help" },
  { command: "help", description: "Show help" },
  { command: "bots", description: "List active worker bots" },
  { command: "add", description: "Add a worker bot" },
  { command: "remove", description: "Remove a worker bot" },
  { command: "schedules", description: "List all scheduled tasks" },
  { command: "cancel", description: "Cancel current operation" },
];

const CONVERSATION_TIMEOUT_MS = 300_000; // 5 min
const BOT_TOKEN_REGEX = /^\d+:[A-Za-z0-9_-]+$/;

export function createManager(
  callbacks: ManagerCallbacks,
  scheduleManager: ScheduleManager
): Bot {
  const bot = new Bot(config.TELEGRAM_BOT_TOKEN);
  const conversations = new Map<number, ConversationState>();

  // Owner-only auth middleware
  bot.use(async (ctx, next) => {
    if (ctx.from?.id !== config.TELEGRAM_OWNER_ID) {
      return; // Silently ignore non-owner
    }
    await next();
  });

  bot.command(["start", "help"], async (ctx) => {
    const workers = callbacks.getActiveWorkers();
    const lines = [
      "<b>Claude Telegram Manager</b>",
      "",
      "<b>Commands:</b>",
      "/add TOKEN /path — Add a worker bot",
      "/add — Add a worker bot (interactive)",
      "/bots — List active worker bots",
      "/remove @bot — Remove a worker bot",
      "/schedules — List all scheduled tasks",
      "/cancel — Cancel current operation",
      "",
      `<b>Active bots:</b> ${workers.size}`,
    ];

    if (workers.size > 0) {
      for (const [, w] of workers) {
        lines.push(
          `• @${w.config.username} — <code>${w.config.workingDir}</code>`
        );
      }
    }

    await ctx.reply(lines.join("\n"), { parse_mode: "HTML" });
  });

  bot.command("bots", async (ctx) => {
    const workers = callbacks.getActiveWorkers();

    if (workers.size === 0) {
      await ctx.reply("No active bots. Use /add to add one.");
      return;
    }

    const lines = [`<b>Active Worker Bots (${workers.size})</b>`, ""];
    for (const [id, w] of workers) {
      lines.push(
        `• @${w.config.username}`,
        `  Path: <code>${w.config.workingDir}</code>`,
        `  ID: ${id}`,
        ""
      );
    }

    await ctx.reply(lines.join("\n"), { parse_mode: "HTML" });
  });

  bot.command("add", async (ctx) => {
    const args = ctx.match?.trim();

    if (args) {
      // Inline: /add TOKEN /path
      const parts = args.split(/\s+/);
      if (parts.length >= 2) {
        const token = parts[0];
        const dir = parts.slice(1).join(" ");
        await addWorkerBot(ctx, token, dir);
        return;
      }
    }

    // Start interactive conversation
    clearConversation(ctx.from!.id);

    conversations.set(ctx.from!.id, {
      step: "token",
      timer: setTimeout(() => {
        conversations.delete(ctx.from!.id);
      }, CONVERSATION_TIMEOUT_MS),
    });

    await ctx.reply(
      "Step 1/2: Send me the Telegram bot token.\n\n" +
        "Get one from @BotFather if you haven't already."
    );
  });

  bot.command("remove", async (ctx) => {
    const args = ctx.match?.trim();
    if (!args) {
      await ctx.reply("Usage: /remove @botname or /remove <botId>");
      return;
    }

    const workers = callbacks.getActiveWorkers();

    // Try by username
    const username = args.replace("@", "");
    let targetId: number | undefined;

    for (const [id, w] of workers) {
      if (w.config.username === username || String(id) === args) {
        targetId = id;
        break;
      }
    }

    if (!targetId) {
      await ctx.reply(`Bot not found: ${args}`);
      return;
    }

    const worker = workers.get(targetId);
    try {
      await callbacks.stopWorker(targetId);
      await ctx.reply(`Removed @${worker?.config.username ?? targetId}`);
    } catch (err: any) {
      await ctx.reply(`Error removing bot: ${err.message}`);
    }
  });

  bot.command("schedules", async (ctx) => {
    const schedules = scheduleManager.getSchedules();
    if (schedules.length === 0) {
      await ctx.reply("No scheduled tasks across any bots.");
      return;
    }

    const workers = callbacks.getActiveWorkers();
    const grouped = new Map<number, typeof schedules>();
    for (const s of schedules) {
      const list = grouped.get(s.botId) ?? [];
      list.push(s);
      grouped.set(s.botId, list);
    }

    const lines = ["<b>All Scheduled Tasks</b>", ""];
    for (const [botId, scheds] of grouped) {
      const worker = workers.get(botId);
      const label = worker ? `@${worker.config.username}` : `Bot ${botId}`;
      lines.push(`<b>${label}</b>`);
      for (const s of scheds) {
        lines.push(
          `  • ${s.humanLabel} (<code>${s.cronExpr}</code>)`,
          `    Task: ${s.prompt.slice(0, 60)}`,
          ""
        );
      }
    }

    await ctx.reply(lines.join("\n"), { parse_mode: "HTML" });
  });

  bot.command("cancel", async (ctx) => {
    if (conversations.has(ctx.from!.id)) {
      clearConversation(ctx.from!.id);
      await ctx.reply("Operation cancelled.");
    } else {
      await ctx.reply("Nothing to cancel.");
    }
  });

  // Handle text messages for multi-step /add conversation
  bot.on("message:text", async (ctx) => {
    const userId = ctx.from!.id;
    const conv = conversations.get(userId);
    if (!conv) return; // Not in a conversation

    const text = ctx.message.text.trim();

    if (conv.step === "token") {
      if (!BOT_TOKEN_REGEX.test(text)) {
        await ctx.reply(
          "That doesn't look like a valid bot token. It should look like:\n<code>123456789:ABCdefGHIjklMNOpqrsTUVwxyz</code>\n\nTry again or /cancel",
          { parse_mode: "HTML" }
        );
        return;
      }

      conv.token = text;
      conv.step = "path";

      await ctx.reply(
        "Step 2/2: Send me the absolute path to the project directory.\n\nExample: /home/user/projects/myapp"
      );
      return;
    }

    if (conv.step === "path") {
      clearConversation(userId);
      await addWorkerBot(ctx, conv.token!, text);
      return;
    }
  });

  async function addWorkerBot(
    ctx: Context,
    token: string,
    dir: string
  ): Promise<void> {
    // Validate token
    if (!BOT_TOKEN_REGEX.test(token)) {
      await ctx.reply("Invalid bot token format.");
      return;
    }

    // Validate directory
    if (!fs.existsSync(dir)) {
      await ctx.reply(`Directory not found: ${dir}`);
      return;
    }

    const stat = fs.statSync(dir);
    if (!stat.isDirectory()) {
      await ctx.reply(`Not a directory: ${dir}`);
      return;
    }

    // Validate token by calling Telegram API
    await ctx.reply("Validating bot token...");

    let tempBot: Bot;
    try {
      tempBot = new Bot(token);
      const me = await tempBot.api.getMe();

      const botConfig: BotConfig = {
        id: me.id,
        token,
        username: me.username ?? `bot_${me.id}`,
        workingDir: dir,
      };

      // Check if already added
      const workers = callbacks.getActiveWorkers();
      if (workers.has(me.id)) {
        await ctx.reply(
          `@${botConfig.username} is already active. Remove it first with /remove.`
        );
        return;
      }

      await callbacks.startWorker(botConfig);

      await ctx.reply(
        [
          `✓ Added <b>@${botConfig.username}</b>`,
          `  Path: <code>${botConfig.workingDir}</code>`,
          "",
          "Send it a message to start coding!",
        ].join("\n"),
        { parse_mode: "HTML" }
      );

      logStatus(`Worker added: @${botConfig.username} → ${dir}`);
    } catch (err: any) {
      await ctx.reply(`Failed to add bot: ${err.message}`);
      logError(`Failed to add worker: ${err.message}`);
    }
  }

  function clearConversation(userId: number): void {
    const conv = conversations.get(userId);
    if (conv) {
      clearTimeout(conv.timer);
      conversations.delete(userId);
    }
  }

  return bot;
}

export { MANAGER_COMMANDS };
