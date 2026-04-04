import { Bot, InlineKeyboard, type Context } from "grammy";
import * as fs from "node:fs";
import * as path from "node:path";
import { config } from "./config.js";
import type { BotConfig } from "./store.js";
import { ClaudeBridge, type TokenUsage } from "./claude.js";
import { TunnelManager, parsePort } from "./tunnel.js";
import {
  ScheduleManager,
  generateScheduleId,
  parseScheduleWithClaude,
  type Schedule,
} from "./scheduler.js";
import {
  claudeToTelegram,
  splitMessage,
  formatToolCall,
} from "./formatter.js";
import { logUser, logStatus, logError, logTool, logApproval } from "./log.js";
import type { PermissionResult } from "@anthropic-ai/claude-code";

interface QueuedMessage {
  chatId: number;
  prompt: string;
  replyTo?: number;
}

const MAX_QUEUE_SIZE = 20;
const TYPING_INTERVAL_MS = 4000;
const STREAM_DEBOUNCE_MS = 1500;

const WORKER_COMMANDS = [
  { command: "new", description: "Start a fresh session" },
  { command: "model", description: "Switch Claude model" },
  { command: "cost", description: "Show token usage" },
  { command: "session", description: "Get session ID for CLI handoff" },
  { command: "resume", description: "Resume a CLI session" },
  { command: "cancel", description: "Cancel current operation" },
  { command: "preview", description: "Open localhost preview via ngrok" },
  { command: "close", description: "Close ngrok tunnel" },
  { command: "schedule", description: "Schedule a recurring task" },
  { command: "schedules", description: "List scheduled tasks" },
  { command: "unschedule", description: "Remove a scheduled task" },
  { command: "yolo", description: "Toggle auto-approve mode" },
  { command: "help", description: "Show available commands" },
];

const AVAILABLE_MODELS = [
  { id: "", label: "Default (from settings)" },
  { id: "global.anthropic.claude-opus-4-6-v1", label: "Opus 4.6" },
  { id: "global.anthropic.claude-sonnet-4-6", label: "Sonnet 4.6" },
];

export function createWorker(
  botConfig: BotConfig,
  bridge: ClaudeBridge,
  tunnelManager: TunnelManager,
  scheduleManager: ScheduleManager
): Bot {
  const bot = new Bot(botConfig.token);
  const tag = botConfig.username;

  // Per-chat message queues
  const messageQueues = new Map<number, QueuedMessage[]>();

  // Pending approval/answer maps
  const pendingApprovals = new Map<
    string,
    { resolve: (result: PermissionResult) => void; timer: ReturnType<typeof setTimeout>; description: string }
  >();
  const pendingAnswers = new Map<
    string,
    { resolve: (answer: string) => void; timer: ReturnType<typeof setTimeout> }
  >();
  const pendingScheduleConfirm = new Map<
    number,
    { schedule: Omit<Schedule, "id" | "createdAt" | "lastRunAt">; timer: ReturnType<typeof setTimeout> }
  >();

  // Owner-only auth middleware
  bot.use(async (ctx, next) => {
    if (ctx.from?.id !== config.TELEGRAM_OWNER_ID) {
      return; // Silently ignore non-owner messages
    }
    await next();
  });

  // --- Commands ---

  bot.command("help", async (ctx) => {
    const lines = [
      `<b>Worker Bot: @${tag}</b>`,
      `<b>Project:</b> <code>${botConfig.workingDir}</code>`,
      "",
      "<b>Commands:</b>",
      ...WORKER_COMMANDS.map((c) => `/${c.command} — ${c.description}`),
      "",
      "Send any message to talk to Claude Code.",
      "Send photos or files to add them as context.",
    ];
    await ctx.reply(lines.join("\n"), { parse_mode: "HTML" });
  });

  bot.command("new", async (ctx) => {
    bridge.clearSession(ctx.chat.id);
    await ctx.reply("Session cleared. Send a message to start fresh.");
  });

  bot.command("model", async (ctx) => {
    const current = bridge.getModel(ctx.chat.id);
    const keyboard = new InlineKeyboard();
    for (const model of AVAILABLE_MODELS) {
      const isCurrent = current === model.id;
      keyboard
        .text(
          `${isCurrent ? "✓ " : ""}${model.label}`,
          `model:${model.id}`
        )
        .row();
    }
    await ctx.reply("Select a model:", {
      reply_markup: keyboard,
    });
  });

  bot.command("cost", async (ctx) => {
    const usage = bridge.getTokenUsage(ctx.chat.id);
    const sessionId = bridge.getSessionId(ctx.chat.id);
    const lines = [
      "<b>Token Usage</b>",
      "",
      `Input tokens: ${usage.inputTokens.toLocaleString()}`,
      `Output tokens: ${usage.outputTokens.toLocaleString()}`,
      `Cache read: ${usage.cacheReadInputTokens.toLocaleString()}`,
      `Cache creation: ${usage.cacheCreationInputTokens.toLocaleString()}`,
      `Total cost: $${usage.costUSD.toFixed(4)}`,
      "",
      `Session: <code>${sessionId ?? "none"}</code>`,
    ];
    await ctx.reply(lines.join("\n"), { parse_mode: "HTML" });
  });

  bot.command("session", async (ctx) => {
    const sessionId = bridge.getSessionId(ctx.chat.id);
    if (!sessionId) {
      await ctx.reply("No active session. Send a message to start one.");
      return;
    }
    await ctx.reply(
      [
        `<b>Session ID:</b>`,
        `<code>${sessionId}</code>`,
        "",
        `To resume in CLI:`,
        `<code>claude --resume ${sessionId}</code>`,
      ].join("\n"),
      { parse_mode: "HTML" }
    );
  });

  bot.command("resume", async (ctx) => {
    const args = ctx.match?.trim();

    if (args) {
      // Resume specific session
      bridge.setSessionId(ctx.chat.id, args);
      await ctx.reply(`Resuming session <code>${args}</code>`, {
        parse_mode: "HTML",
      });
      return;
    }

    // Show recent sessions
    const sessions = bridge.listRecentSessions(10);
    if (sessions.length === 0) {
      await ctx.reply("No recent sessions found.");
      return;
    }

    const keyboard = new InlineKeyboard();
    for (const session of sessions) {
      const timeAgo = formatTimeAgo(session.mtime);
      const label = session.firstMessage
        ? `${timeAgo}: ${session.firstMessage.slice(0, 40)}...`
        : `${timeAgo}: ${session.sessionId.slice(0, 8)}`;
      keyboard.text(label, `resume:${session.sessionId}`).row();
    }

    await ctx.reply("Select a session to resume:", {
      reply_markup: keyboard,
    });
  });

  bot.command("cancel", async (ctx) => {
    const aborted = bridge.abort(ctx.chat.id);
    if (aborted) {
      await ctx.reply("Operation cancelled.");
    } else {
      await ctx.reply("Nothing to cancel.");
    }
  });

  bot.command("preview", async (ctx) => {
    const args = ctx.match?.trim();
    if (!args) {
      await ctx.reply(
        "Usage: /preview <port>\nExample: /preview 3000"
      );
      return;
    }

    const port = parsePort(args);
    if (!port) {
      await ctx.reply("Invalid port number.");
      return;
    }

    try {
      const url = await tunnelManager.openTunnel(ctx.chat.id, port);
      await ctx.reply(
        [
          `<b>Preview tunnel opened</b>`,
          "",
          `<a href="${url}">${url}</a>`,
          `→ localhost:${port}`,
          "",
          "Tunnel auto-closes after 30 minutes of inactivity.",
          "Use /close to close it manually.",
        ].join("\n"),
        { parse_mode: "HTML" }
      );
    } catch (err: any) {
      await ctx.reply(`Failed to open tunnel: ${err.message}`);
    }
  });

  bot.command("close", async (ctx) => {
    const closed = await tunnelManager.closeTunnel(ctx.chat.id);
    if (closed) {
      await ctx.reply("Tunnel closed.");
    } else {
      await ctx.reply("No active tunnel.");
    }
  });

  bot.command("schedule", async (ctx) => {
    const args = ctx.match?.trim();
    if (!args) {
      await ctx.reply(
        'Usage: /schedule <description>\nExample: /schedule "run tests every morning at 9am"'
      );
      return;
    }

    await ctx.reply("Parsing schedule...");

    const parsed = await parseScheduleWithClaude(args);
    if (!parsed) {
      await ctx.reply("Couldn't parse that schedule. Try rephrasing.");
      return;
    }

    // Ask for confirmation
    const keyboard = new InlineKeyboard()
      .text("✓ Confirm", `schedule:confirm:${ctx.chat.id}`)
      .text("✗ Cancel", `schedule:cancel:${ctx.chat.id}`);

    pendingScheduleConfirm.set(ctx.chat.id, {
      schedule: {
        botId: botConfig.id,
        chatId: ctx.chat.id,
        prompt: parsed.prompt,
        cronExpr: parsed.cronExpr,
        humanLabel: parsed.humanLabel,
      },
      timer: setTimeout(() => {
        pendingScheduleConfirm.delete(ctx.chat.id);
      }, 120_000),
    });

    await ctx.reply(
      [
        "<b>Schedule Preview</b>",
        "",
        `<b>When:</b> ${parsed.humanLabel}`,
        `<b>Cron:</b> <code>${parsed.cronExpr}</code>`,
        `<b>Task:</b> ${parsed.prompt}`,
      ].join("\n"),
      { parse_mode: "HTML", reply_markup: keyboard }
    );
  });

  bot.command("schedules", async (ctx) => {
    const schedules = scheduleManager.getSchedulesForBot(botConfig.id);
    if (schedules.length === 0) {
      await ctx.reply("No scheduled tasks.");
      return;
    }

    const lines = ["<b>Scheduled Tasks</b>", ""];
    for (const s of schedules) {
      lines.push(
        `• <b>${s.humanLabel}</b>`,
        `  <code>${s.cronExpr}</code>`,
        `  Task: ${s.prompt.slice(0, 80)}`,
        `  Last run: ${s.lastRunAt ?? "never"}`,
        `  ID: <code>${s.id}</code>`,
        ""
      );
    }

    await ctx.reply(lines.join("\n"), { parse_mode: "HTML" });
  });

  bot.command("unschedule", async (ctx) => {
    const args = ctx.match?.trim();
    if (!args) {
      await ctx.reply("Usage: /unschedule <schedule-id>");
      return;
    }

    const removed = scheduleManager.remove(args);
    if (removed) {
      await ctx.reply(`Schedule ${args} removed.`);
    } else {
      await ctx.reply("Schedule not found.");
    }
  });

  bot.command("yolo", async (ctx) => {
    const current = bridge.isYolo(ctx.chat.id);
    bridge.setYolo(ctx.chat.id, !current);
    await ctx.reply(
      !current
        ? "⚡ YOLO mode ON — all tool calls auto-approved"
        : "🛡️ YOLO mode OFF — tool approval required"
    );
  });

  // --- Callback Queries ---

  bot.on("callback_query:data", async (ctx) => {
    const data = ctx.callbackQuery.data;

    // Model selection
    if (data.startsWith("model:")) {
      const modelId = data.slice(6);
      if (modelId === "") {
        // Reset to default (from settings.json)
        bridge.clearModel(ctx.chat!.id);
      } else {
        bridge.setModel(ctx.chat!.id, modelId);
      }
      const label =
        AVAILABLE_MODELS.find((m) => m.id === modelId)?.label ?? modelId;
      await ctx.editMessageText(`Model set to <b>${label}</b>. Session cleared.`, {
        parse_mode: "HTML",
      });
      await ctx.answerCallbackQuery();
      return;
    }

    // Resume session
    if (data.startsWith("resume:")) {
      const sessionId = data.slice(7);
      bridge.setSessionId(ctx.chat!.id, sessionId);
      await ctx.editMessageText(
        `Resuming session <code>${sessionId.slice(0, 8)}...</code>`,
        { parse_mode: "HTML" }
      );
      await ctx.answerCallbackQuery();
      return;
    }

    // Tool approval
    if (data.startsWith("approve:")) {
      const approvalId = data.slice(8);
      const pending = pendingApprovals.get(approvalId);
      if (pending) {
        clearTimeout(pending.timer);
        pendingApprovals.delete(approvalId);
        pending.resolve({ behavior: "allow", updatedInput: {} });
        await ctx.editMessageText(
          `✓ Approved: ${pending.description}`,
          { parse_mode: "HTML" }
        );
      }
      await ctx.answerCallbackQuery();
      return;
    }

    if (data.startsWith("alwaysallow:")) {
      const approvalId = data.slice(12);
      const pending = pendingApprovals.get(approvalId);
      if (pending) {
        clearTimeout(pending.timer);
        pendingApprovals.delete(approvalId);
        pending.resolve({
          behavior: "allow",
          updatedInput: {},
          updatedPermissions: [
            {
              type: "addRules",
              rules: [{ toolName: pending.description }],
              behavior: "allow",
              destination: "session",
            },
          ],
        });
        await ctx.editMessageText(
          `✓ Always allowed: ${pending.description}`,
          { parse_mode: "HTML" }
        );
      }
      await ctx.answerCallbackQuery();
      return;
    }

    if (data.startsWith("deny:")) {
      const approvalId = data.slice(5);
      const pending = pendingApprovals.get(approvalId);
      if (pending) {
        clearTimeout(pending.timer);
        pendingApprovals.delete(approvalId);
        pending.resolve({ behavior: "deny", message: "User denied" });
        await ctx.editMessageText(
          `✗ Denied: ${pending.description}`,
          { parse_mode: "HTML" }
        );
      }
      await ctx.answerCallbackQuery();
      return;
    }

    // Answer selection
    if (data.startsWith("answer:")) {
      const [, answerId, ...answerParts] = data.split(":");
      const answer = answerParts.join(":");
      const pending = pendingAnswers.get(answerId);
      if (pending) {
        clearTimeout(pending.timer);
        pendingAnswers.delete(answerId);
        pending.resolve(answer);
      }
      await ctx.answerCallbackQuery();
      return;
    }

    // Schedule confirm/cancel
    if (data.startsWith("schedule:confirm:")) {
      const chatId = Number(data.split(":")[2]);
      const pending = pendingScheduleConfirm.get(chatId);
      if (pending) {
        clearTimeout(pending.timer);
        pendingScheduleConfirm.delete(chatId);

        const schedule: Schedule = {
          id: generateScheduleId(),
          createdAt: new Date().toISOString(),
          lastRunAt: null,
          ...pending.schedule,
        };

        scheduleManager.add(schedule);
        await ctx.editMessageText(
          `✓ Scheduled: <b>${schedule.humanLabel}</b>\nID: <code>${schedule.id}</code>`,
          { parse_mode: "HTML" }
        );
      }
      await ctx.answerCallbackQuery();
      return;
    }

    if (data.startsWith("schedule:cancel:")) {
      const chatId = Number(data.split(":")[2]);
      const pending = pendingScheduleConfirm.get(chatId);
      if (pending) {
        clearTimeout(pending.timer);
        pendingScheduleConfirm.delete(chatId);
        await ctx.editMessageText("Schedule cancelled.");
      }
      await ctx.answerCallbackQuery();
      return;
    }

    // Retry
    if (data.startsWith("retry:")) {
      const chatId = Number(data.split(":")[1]);
      const lastPrompt = bridge.getLastPrompt(chatId);
      if (lastPrompt) {
        await ctx.answerCallbackQuery({ text: "Retrying..." });
        handlePrompt(chatId, lastPrompt);
      } else {
        await ctx.answerCallbackQuery({ text: "No prompt to retry" });
      }
      return;
    }

    // Tunnel close
    if (data.startsWith("tunnel:close:")) {
      const chatId = Number(data.split(":")[2]);
      await tunnelManager.closeTunnel(chatId);
      await ctx.editMessageText("Tunnel closed.");
      await ctx.answerCallbackQuery();
      return;
    }

    await ctx.answerCallbackQuery();
  });

  // --- File/Photo handling ---

  bot.on("message:document", async (ctx) => {
    const doc = ctx.message.document;
    if (!doc) return;

    try {
      const file = await ctx.getFile();
      const filePath = file.file_path;
      if (!filePath) {
        await ctx.reply("Could not download file.");
        return;
      }

      const url = `https://api.telegram.org/file/bot${botConfig.token}/${filePath}`;
      const response = await fetch(url, {
        signal: AbortSignal.timeout(30_000),
      });

      if (!response.ok) {
        await ctx.reply("Failed to download file.");
        return;
      }

      const buffer = Buffer.from(await response.arrayBuffer());
      if (buffer.length > 20 * 1024 * 1024) {
        await ctx.reply("File too large (max 20MB).");
        return;
      }

      const sanitizedName = (doc.file_name ?? "file").replace(
        /[^a-zA-Z0-9._-]/g,
        "_"
      );
      const localPath = path.join(bridge.getTempDir(), sanitizedName);
      fs.writeFileSync(localPath, buffer);

      const caption = ctx.message.caption ?? "";
      const prompt = caption
        ? `Here is a file at ${localPath}: ${caption}`
        : `I've shared a file at ${localPath}. Please review it.`;

      handlePrompt(ctx.chat.id, prompt);
    } catch (err: any) {
      await ctx.reply(`Error processing file: ${err.message}`);
    }
  });

  bot.on("message:photo", async (ctx) => {
    const photos = ctx.message.photo;
    if (!photos || photos.length === 0) return;

    try {
      const photo = photos[photos.length - 1]; // Largest size
      const file = await ctx.api.getFile(photo.file_id);
      const filePath = file.file_path;
      if (!filePath) {
        await ctx.reply("Could not download photo.");
        return;
      }

      const url = `https://api.telegram.org/file/bot${botConfig.token}/${filePath}`;
      const response = await fetch(url, {
        signal: AbortSignal.timeout(30_000),
      });

      if (!response.ok) {
        await ctx.reply("Failed to download photo.");
        return;
      }

      const buffer = Buffer.from(await response.arrayBuffer());
      const localPath = path.join(
        bridge.getTempDir(),
        `${Date.now()}.jpg`
      );
      fs.writeFileSync(localPath, buffer);

      const caption = ctx.message.caption ?? "";
      const prompt = caption
        ? `Here is a photo at ${localPath}: ${caption}`
        : `I've shared a photo at ${localPath}. Please review it.`;

      handlePrompt(ctx.chat.id, prompt);
    } catch (err: any) {
      await ctx.reply(`Error processing photo: ${err.message}`);
    }
  });

  // --- Text message handler ---

  bot.on("message:text", async (ctx) => {
    const text = ctx.message.text;
    if (!text || text.startsWith("/")) return; // Commands handled above

    logUser(text.slice(0, 100), tag);
    handlePrompt(ctx.chat.id, text);
  });

  // --- Core prompt handler ---

  async function handlePrompt(chatId: number, prompt: string): Promise<void> {
    // Queue if already processing
    if (bridge.isProcessing(chatId)) {
      const queue = messageQueues.get(chatId) ?? [];
      if (queue.length >= MAX_QUEUE_SIZE) {
        await bot.api.sendMessage(chatId, "Queue full. Please wait.");
        return;
      }
      queue.push({ chatId, prompt });
      messageQueues.set(chatId, queue);
      await bot.api.sendMessage(
        chatId,
        `Queued (position ${queue.length}). Please wait...`
      );
      return;
    }

    bridge.setLastPrompt(chatId, prompt);

    // Send "Thinking..." message
    let draftMsgId: number | undefined;
    try {
      const msg = await bot.api.sendMessage(chatId, "Thinking...");
      draftMsgId = msg.message_id;
    } catch {
      // Failed to send draft
    }

    // Start typing indicator
    let typingInterval: ReturnType<typeof setInterval> | undefined;
    typingInterval = setInterval(() => {
      bot.api.sendChatAction(chatId, "typing").catch(() => {});
    }, TYPING_INTERVAL_MS);

    // Stream debounce state
    let streamBuffer = "";
    let streamTimer: ReturnType<typeof setTimeout> | undefined;
    let lastEditTime = 0;

    function scheduleEdit(): void {
      if (streamTimer) clearTimeout(streamTimer);
      const elapsed = Date.now() - lastEditTime;
      const delay = Math.max(0, STREAM_DEBOUNCE_MS - elapsed);

      streamTimer = setTimeout(async () => {
        if (!draftMsgId || !streamBuffer) return;
        lastEditTime = Date.now();
        try {
          const html = claudeToTelegram(streamBuffer);
          const chunks = splitMessage(html);
          await bot.api.editMessageText(chatId, draftMsgId, chunks[0], {
            parse_mode: "HTML",
          });
        } catch {
          // Edit failed (message not modified, etc.)
        }
      }, delay);
    }

    try {
      await bridge.sendMessage(
        chatId,
        prompt,
        {
          onStreamChunk: (text) => {
            streamBuffer = text;
            scheduleEdit();
          },

          onStatusUpdate: async (status) => {
            if (!draftMsgId) return;
            try {
              await bot.api.editMessageText(
                chatId,
                draftMsgId,
                `<i>${status}</i>`,
                { parse_mode: "HTML" }
              );
            } catch {
              // Ignore edit failures
            }
          },

          onToolApproval: (toolName, input, resolve) => {
            const approvalId = `${chatId}_${Date.now()}`;
            const description = toolName;

            const keyboard = new InlineKeyboard()
              .text("✓ Approve", `approve:${approvalId}`)
              .text("✓ Always", `alwaysallow:${approvalId}`)
              .text("✗ Deny", `deny:${approvalId}`);

            pendingApprovals.set(approvalId, {
              resolve,
              description,
              timer: setTimeout(() => {
                pendingApprovals.delete(approvalId);
                resolve({ behavior: "deny", message: "Approval timed out" });
              }, 300_000), // 5 min timeout
            });

            const toolDisplay = formatToolCall(toolName, input);

            bot.api
              .sendMessage(
                chatId,
                `<b>Tool Approval Required</b>\n\n${toolDisplay}`,
                { parse_mode: "HTML", reply_markup: keyboard }
              )
              .then((msg) => {
                // New message for approval, don't use draft
                draftMsgId = undefined;
              })
              .catch(() => {});

            logApproval(`Awaiting approval: ${toolName}`, tag);
          },

          onAskUser: (question, options, resolve) => {
            const answerId = `${chatId}_${Date.now()}`;

            const keyboard = new InlineKeyboard();
            for (const opt of options) {
              keyboard
                .text(opt.label, `answer:${answerId}:${opt.label}`)
                .row();
            }

            pendingAnswers.set(answerId, {
              resolve,
              timer: setTimeout(() => {
                pendingAnswers.delete(answerId);
                resolve(options[0]?.label ?? "");
              }, 300_000),
            });

            bot.api
              .sendMessage(chatId, `<b>Question:</b> ${question}`, {
                parse_mode: "HTML",
                reply_markup: keyboard,
              })
              .then(() => {
                draftMsgId = undefined;
              })
              .catch(() => {});
          },

          onResult: async (result) => {
            if (streamTimer) clearTimeout(streamTimer);

            const html = claudeToTelegram(result.text);
            const chunks = splitMessage(html);

            // Send first chunk as edit of draft, rest as new messages
            for (let i = 0; i < chunks.length; i++) {
              try {
                if (i === 0 && draftMsgId) {
                  await bot.api.editMessageText(
                    chatId,
                    draftMsgId,
                    chunks[i],
                    { parse_mode: "HTML" }
                  );
                } else {
                  await bot.api.sendMessage(chatId, chunks[i], {
                    parse_mode: "HTML",
                  });
                }
              } catch {
                // Fallback: send as plain text
                try {
                  await bot.api.sendMessage(chatId, chunks[i]);
                } catch {
                  // Give up on this chunk
                }
              }
            }

            // Send summary footer
            const summary = [
              `📊 ${result.numTurns} turns`,
              `${(result.usage.inputTokens + result.usage.outputTokens).toLocaleString()} tokens`,
              `$${result.costUSD.toFixed(4)}`,
              `${(result.durationMs / 1000).toFixed(1)}s`,
            ].join(" · ");

            await bot.api.sendMessage(chatId, summary).catch(() => {});
          },

          onError: async (error) => {
            if (streamTimer) clearTimeout(streamTimer);

            const keyboard = new InlineKeyboard().text(
              "Retry",
              `retry:${chatId}`
            );

            const msg = draftMsgId
              ? await bot.api
                  .editMessageText(
                    chatId,
                    draftMsgId,
                    `❌ Error: ${error}`,
                    { reply_markup: keyboard }
                  )
                  .catch(() => null)
              : await bot.api
                  .sendMessage(chatId, `❌ Error: ${error}`, {
                    reply_markup: keyboard,
                  })
                  .catch(() => null);
          },

          onSessionReset: async (newSessionId) => {
            await bot.api
              .sendMessage(
                chatId,
                `Session changed to <code>${newSessionId.slice(0, 8)}...</code>`,
                { parse_mode: "HTML" }
              )
              .catch(() => {});
          },
        },
        "bypassPermissions"
      );
    } finally {
      if (typingInterval) clearInterval(typingInterval);
      if (streamTimer) clearTimeout(streamTimer);

      // Drain queue
      const queue = messageQueues.get(chatId);
      if (queue && queue.length > 0) {
        const next = queue.shift()!;
        if (queue.length === 0) messageQueues.delete(chatId);
        // Process next in queue (fire and forget)
        handlePrompt(next.chatId, next.prompt);
      }
    }
  }

  // Set up tunnel auto-close notification
  tunnelManager.setAutoCloseCallback(async (chatId, url) => {
    await bot.api
      .sendMessage(chatId, `Tunnel auto-closed (30min timeout): ${url}`)
      .catch(() => {});
  });

  return bot;
}

export { WORKER_COMMANDS };

function formatTimeAgo(date: Date): string {
  const seconds = Math.floor((Date.now() - date.getTime()) / 1000);
  if (seconds < 60) return "just now";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}
