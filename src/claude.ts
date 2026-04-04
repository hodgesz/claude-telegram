import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { execSync } from "node:child_process";
import { query, type SDKMessage, type SDKResultMessage, type PermissionMode, type PermissionResult, type ModelUsage } from "@anthropic-ai/claude-code";
import { DATA_DIR, config } from "./config.js";
import { logStatus, logError, logResult } from "./log.js";

// Resolve claude executable path at module load
let claudeExecutablePath: string | undefined;
try {
  claudeExecutablePath = execSync("which claude", { encoding: "utf-8" }).trim();
} catch {
  // Will let the SDK try to find it
}

export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadInputTokens: number;
  cacheCreationInputTokens: number;
  costUSD: number;
}

export interface SendMessageCallbacks {
  onStreamChunk?: (text: string) => void;
  onStatusUpdate?: (status: string) => void;
  onToolApproval?: (
    toolName: string,
    input: Record<string, unknown>,
    resolve: (result: PermissionResult) => void
  ) => void;
  onAskUser?: (
    question: string,
    options: Array<{ label: string; description?: string }>,
    resolve: (answer: string) => void
  ) => void;
  onPlanApproval?: (
    planContent: string,
    resolve: (approved: boolean) => void
  ) => void;
  onResult?: (result: {
    text: string;
    usage: TokenUsage;
    numTurns: number;
    durationMs: number;
    costUSD: number;
  }) => void;
  onError?: (error: string) => void;
  onSessionReset?: (newSessionId: string) => void;
}

const AUTO_APPROVE_TOOLS = new Set([
  "Read",
  "Glob",
  "Grep",
  "WebFetch",
  "WebSearch",
  "ToolSearch",
  "TaskCreate",
  "TaskUpdate",
  "TaskGet",
  "TaskList",
  "TaskOutput",
  "TaskStop",
]);

interface PersistedState {
  sessions: Record<string, string>;
  sessionTokens: Record<string, TokenUsage>;
  selectedModels: Record<string, string>;
}

export class ClaudeBridge {
  readonly botId: number;
  readonly workingDir: string;
  readonly botUsername: string;

  private sessions = new Map<number, string>();
  private sessionTokens = new Map<number, TokenUsage>();
  private activeAborts = new Map<number, AbortController>();
  private selectedModels = new Map<number, string>();
  private sessionApprovedTools = new Map<number, Set<string>>();
  private yoloChats = new Set<number>();
  private lastPrompts = new Map<number, string>();
  private lastQueryEnd = new Map<number, number>();
  private processing = new Set<number>();

  private cleanEnv: Record<string, string>;
  private stateFile: string;

  constructor(botId: number, workingDir: string, botUsername: string) {
    this.botId = botId;
    this.workingDir = workingDir;
    this.botUsername = botUsername;
    this.stateFile = path.join(DATA_DIR, `${botId}-state.json`);

    // Build a clean env — remove CLAUDECODE to prevent SDK from refusing
    // to run inside Claude Code, and handle API key
    const env: Record<string, string> = {};
    for (const [k, v] of Object.entries(process.env)) {
      if (k === "CLAUDECODE" || k === "CLAUDE_CODE") continue;
      if (k === "ANTHROPIC_API_KEY") continue;
      if (v !== undefined) env[k] = v;
    }

    // Re-inject API key from our config if set
    if (config.ANTHROPIC_API_KEY) {
      env.ANTHROPIC_API_KEY = config.ANTHROPIC_API_KEY;
    }

    // Read Claude settings.json and merge env vars
    try {
      const settingsPath = path.join(os.homedir(), ".claude", "settings.json");
      const settings = JSON.parse(fs.readFileSync(settingsPath, "utf-8"));
      if (settings.env && typeof settings.env === "object") {
        Object.assign(env, settings.env);
      }
    } catch {
      // No settings file, that's fine
    }

    this.cleanEnv = env;
    this.loadState();
  }

  private loadState(): void {
    try {
      const raw = fs.readFileSync(this.stateFile, "utf-8");
      const state: PersistedState = JSON.parse(raw);
      for (const [k, v] of Object.entries(state.sessions ?? {})) {
        this.sessions.set(Number(k), v);
      }
      for (const [k, v] of Object.entries(state.sessionTokens ?? {})) {
        this.sessionTokens.set(Number(k), v);
      }
      for (const [k, v] of Object.entries(state.selectedModels ?? {})) {
        this.selectedModels.set(Number(k), v);
      }
    } catch {
      // No state file yet
    }
  }

  saveState(): void {
    const state: PersistedState = {
      sessions: Object.fromEntries(this.sessions),
      sessionTokens: Object.fromEntries(this.sessionTokens),
      selectedModels: Object.fromEntries(this.selectedModels),
    };
    try {
      fs.writeFileSync(this.stateFile, JSON.stringify(state, null, 2), {
        mode: 0o600,
      });
    } catch (err) {
      logError(`Failed to save state: ${err}`, this.botUsername);
    }
  }

  isProcessing(chatId: number): boolean {
    return this.processing.has(chatId);
  }

  getModel(chatId: number): string | undefined {
    return this.selectedModels.get(chatId);
  }

  setModel(chatId: number, model: string): void {
    this.selectedModels.set(chatId, model);
    // Clear session when changing model
    this.clearSession(chatId);
    this.saveState();
  }

  clearModel(chatId: number): void {
    this.selectedModels.delete(chatId);
    this.clearSession(chatId);
    this.saveState();
  }

  getSessionId(chatId: number): string | undefined {
    return this.sessions.get(chatId);
  }

  setSessionId(chatId: number, sessionId: string): void {
    this.sessions.set(chatId, sessionId);
    this.saveState();
  }

  clearSession(chatId: number): void {
    this.sessions.delete(chatId);
    this.sessionApprovedTools.delete(chatId);
    this.saveState();
  }

  getTokenUsage(chatId: number): TokenUsage {
    return (
      this.sessionTokens.get(chatId) ?? {
        inputTokens: 0,
        outputTokens: 0,
        cacheReadInputTokens: 0,
        cacheCreationInputTokens: 0,
        costUSD: 0,
      }
    );
  }

  setLastPrompt(chatId: number, prompt: string): void {
    this.lastPrompts.set(chatId, prompt);
  }

  getLastPrompt(chatId: number): string | undefined {
    return this.lastPrompts.get(chatId);
  }

  setYolo(chatId: number, enabled: boolean): void {
    if (enabled) {
      this.yoloChats.add(chatId);
    } else {
      this.yoloChats.delete(chatId);
    }
  }

  isYolo(chatId: number): boolean {
    return this.yoloChats.has(chatId);
  }

  abort(chatId: number): boolean {
    const controller = this.activeAborts.get(chatId);
    if (controller) {
      controller.abort();
      this.activeAborts.delete(chatId);
      this.processing.delete(chatId);
      return true;
    }
    return false;
  }

  abortAll(): void {
    for (const [chatId, controller] of this.activeAborts) {
      controller.abort();
      this.activeAborts.delete(chatId);
      this.processing.delete(chatId);
    }
  }

  getTempDir(): string {
    const dir = path.join(os.tmpdir(), `clautel-${this.botId}`);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    return dir;
  }

  async sendMessage(
    chatId: number,
    prompt: string,
    callbacks: SendMessageCallbacks,
    permissionMode: PermissionMode = "bypassPermissions",
    maxTurns?: number
  ): Promise<void> {
    // Enforce 2s cooldown between queries
    const lastEnd = this.lastQueryEnd.get(chatId) ?? 0;
    const elapsed = Date.now() - lastEnd;
    if (elapsed < 2000) {
      await new Promise((r) => setTimeout(r, 2000 - elapsed));
    }

    this.processing.add(chatId);
    const abortController = new AbortController();
    this.activeAborts.set(chatId, abortController);

    const sessionId = this.sessions.get(chatId);
    const mode = this.yoloChats.has(chatId)
      ? ("bypassPermissions" as PermissionMode)
      : permissionMode;

    // Pending approval resolvers
    let pendingToolApproval:
      | { resolve: (result: PermissionResult) => void }
      | undefined;

    const canUseTool = async (
      toolName: string,
      input: Record<string, unknown>,
      options: { signal: AbortSignal; suggestions?: any[] }
    ): Promise<PermissionResult> => {
      // Auto-approve safe tools
      if (AUTO_APPROVE_TOOLS.has(toolName)) {
        return { behavior: "allow", updatedInput: input };
      }

      // Check session-approved tools
      const approved = this.sessionApprovedTools.get(chatId);
      if (approved?.has(toolName)) {
        return { behavior: "allow", updatedInput: input };
      }

      // Ask user via Telegram inline keyboard
      if (callbacks.onToolApproval) {
        return new Promise<PermissionResult>((resolve) => {
          pendingToolApproval = { resolve };
          callbacks.onToolApproval!(toolName, input, (result) => {
            pendingToolApproval = undefined;

            // If "Always Allow", add to session approved set
            if (
              result.behavior === "allow" &&
              result.updatedPermissions?.length
            ) {
              let set = this.sessionApprovedTools.get(chatId);
              if (!set) {
                set = new Set();
                this.sessionApprovedTools.set(chatId, set);
              }
              set.add(toolName);
            }

            resolve(result);
          });
        });
      }

      // Default: allow
      return { behavior: "allow", updatedInput: input };
    };

    let resultText = "";
    let streamBuffer = "";

    try {
      const selectedModel = this.getModel(chatId);
      const q = query({
        prompt,
        options: {
          env: this.cleanEnv,
          cwd: this.workingDir,
          ...(selectedModel ? { model: selectedModel } : {}),
          includePartialMessages: true,
          permissionMode: mode,
          maxTurns,
          resume: sessionId,
          abortController,
          canUseTool,
          ...(claudeExecutablePath
            ? { pathToClaudeCodeExecutable: claudeExecutablePath }
            : {}),
          stderr: (data: string) => {
            logError(`Claude stderr: ${data.trim()}`, this.botUsername);
          },
        },
      });

      for await (const message of q) {
        if (abortController.signal.aborted) break;

        this.handleMessage(chatId, message, callbacks, streamBuffer);

        if (message.type === "system" && message.subtype === "init") {
          const newSessionId = message.session_id;
          if (newSessionId && newSessionId !== sessionId) {
            this.sessions.set(chatId, newSessionId);
            if (sessionId) {
              callbacks.onSessionReset?.(newSessionId);
            }
          }
        }

        if (message.type === "stream_event") {
          const event = message.event;
          if (event.type === "content_block_delta") {
            if ("delta" in event && "text" in (event.delta as any)) {
              const text = (event.delta as any).text as string;
              streamBuffer += text;
              callbacks.onStreamChunk?.(streamBuffer);
            }
          }
          if (event.type === "content_block_start") {
            if ("content_block" in event) {
              const block = event.content_block;
              if (block.type === "tool_use") {
                callbacks.onStatusUpdate?.(`Using ${block.name}...`);
                // Reset stream buffer for next text block
                if (streamBuffer) {
                  resultText += streamBuffer;
                  streamBuffer = "";
                }
              } else if (block.type === "thinking") {
                callbacks.onStatusUpdate?.("Thinking deeply...");
              }
            }
          }
        }

        if (message.type === "assistant") {
          // Extract text from assistant message content blocks
          for (const block of message.message.content) {
            if (block.type === "text") {
              resultText = block.text;
            }
          }
        }

        if (message.type === "result") {
          const result = message as SDKResultMessage;
          if (result.subtype === "success") {
            const usage: TokenUsage = {
              inputTokens: result.usage.input_tokens ?? 0,
              outputTokens: result.usage.output_tokens ?? 0,
              cacheReadInputTokens: result.usage.cache_read_input_tokens ?? 0,
              cacheCreationInputTokens:
                result.usage.cache_creation_input_tokens ?? 0,
              costUSD: result.total_cost_usd ?? 0,
            };

            // Accumulate session tokens
            const existing = this.sessionTokens.get(chatId) ?? {
              inputTokens: 0,
              outputTokens: 0,
              cacheReadInputTokens: 0,
              cacheCreationInputTokens: 0,
              costUSD: 0,
            };
            this.sessionTokens.set(chatId, {
              inputTokens: existing.inputTokens + usage.inputTokens,
              outputTokens: existing.outputTokens + usage.outputTokens,
              cacheReadInputTokens:
                existing.cacheReadInputTokens + usage.cacheReadInputTokens,
              cacheCreationInputTokens:
                existing.cacheCreationInputTokens +
                usage.cacheCreationInputTokens,
              costUSD: existing.costUSD + usage.costUSD,
            });

            this.saveState();

            const finalText = resultText || streamBuffer || result.result || "";

            callbacks.onResult?.({
              text: finalText,
              usage,
              numTurns: result.num_turns,
              durationMs: result.duration_ms,
              costUSD: result.total_cost_usd,
            });

            logResult(
              `${result.num_turns} turns, ${usage.inputTokens + usage.outputTokens} tokens, $${usage.costUSD.toFixed(4)}`,
              this.botUsername
            );
          } else {
            callbacks.onError?.(
              `Session ended: ${result.subtype}${result.is_error ? " (error)" : ""}`
            );
          }
          break;
        }
      }
    } catch (err: any) {
      if (err.name === "AbortError" || abortController.signal.aborted) {
        logStatus("Query aborted", this.botUsername);
      } else {
        logError(`Query error: ${err.message}`, this.botUsername);
        callbacks.onError?.(err.message ?? "Unknown error");
      }
    } finally {
      this.processing.delete(chatId);
      this.activeAborts.delete(chatId);
      this.lastQueryEnd.set(chatId, Date.now());
    }
  }

  private handleMessage(
    _chatId: number,
    _message: SDKMessage,
    _callbacks: SendMessageCallbacks,
    _streamBuffer: string
  ): void {
    // Additional message handling can be added here
    // The main handling is done in sendMessage's for-await loop
  }

  // List recent sessions from Claude's session files
  listRecentSessions(count: number = 10): Array<{
    sessionId: string;
    mtime: Date;
    firstMessage?: string;
  }> {
    const escapedDir = this.workingDir.replace(/\//g, "-");
    const sessionsDir = path.join(
      os.homedir(),
      ".claude",
      "projects",
      escapedDir
    );

    try {
      const files = fs
        .readdirSync(sessionsDir)
        .filter((f) => f.endsWith(".jsonl"))
        .map((f) => {
          const filePath = path.join(sessionsDir, f);
          const stat = fs.statSync(filePath);
          return { file: f, path: filePath, mtime: stat.mtime };
        })
        .sort((a, b) => b.mtime.getTime() - a.mtime.getTime())
        .slice(0, count);

      return files.map((f) => {
        const sessionId = f.file.replace(".jsonl", "");
        let firstMessage: string | undefined;

        try {
          // Read first 4096 bytes to find first user message
          const fd = fs.openSync(f.path, "r");
          const buf = Buffer.alloc(4096);
          fs.readSync(fd, buf, 0, 4096, 0);
          fs.closeSync(fd);

          const lines = buf.toString("utf-8").split("\n");
          for (const line of lines) {
            if (!line.trim()) continue;
            try {
              const msg = JSON.parse(line);
              if (msg.type === "user" && msg.message?.content) {
                const content = msg.message.content;
                if (typeof content === "string") {
                  firstMessage = content.slice(0, 100);
                } else if (Array.isArray(content)) {
                  const textBlock = content.find(
                    (b: any) => b.type === "text"
                  );
                  if (textBlock) {
                    firstMessage = textBlock.text.slice(0, 100);
                  }
                }
                break;
              }
            } catch {
              continue;
            }
          }
        } catch {
          // Can't read file content
        }

        return { sessionId, mtime: f.mtime, firstMessage };
      });
    } catch {
      return [];
    }
  }
}
