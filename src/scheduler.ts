import * as fs from "node:fs";
import * as path from "node:path";
import cron from "node-cron";
import { query } from "@anthropic-ai/claude-code";
import { DATA_DIR, ensureDataDir } from "./config.js";
import { logStatus, logError } from "./log.js";

export interface Schedule {
  id: string;
  botId: number;
  chatId: number;
  prompt: string;
  cronExpr: string;
  humanLabel: string;
  createdAt: string;
  lastRunAt: string | null;
}

const SCHEDULES_FILE = path.join(DATA_DIR, "schedules.json");

type RunCallback = (
  botId: number,
  chatId: number,
  prompt: string,
  scheduleId: string
) => Promise<void>;

export class ScheduleManager {
  private tasks = new Map<string, cron.ScheduledTask>();
  private runCallback: RunCallback;

  constructor(runCallback: RunCallback) {
    this.runCallback = runCallback;
  }

  start(schedules: Schedule[]): void {
    for (const schedule of schedules) {
      this.startTask(schedule);
    }
    logStatus(`Started ${schedules.length} scheduled tasks`);
  }

  private startTask(schedule: Schedule): void {
    if (!cron.validate(schedule.cronExpr)) {
      logError(
        `Invalid cron expression for schedule ${schedule.id}: ${schedule.cronExpr}`
      );
      return;
    }

    const task = cron.schedule(schedule.cronExpr, async () => {
      logStatus(
        `Running scheduled task ${schedule.id}: ${schedule.humanLabel}`
      );

      // Update lastRunAt
      const schedules = loadSchedules();
      const idx = schedules.findIndex((s) => s.id === schedule.id);
      if (idx !== -1) {
        schedules[idx].lastRunAt = new Date().toISOString();
        saveSchedules(schedules);
      }

      try {
        await this.runCallback(
          schedule.botId,
          schedule.chatId,
          schedule.prompt,
          schedule.id
        );
      } catch (err) {
        logError(`Scheduled task ${schedule.id} failed: ${err}`);
      }
    });

    this.tasks.set(schedule.id, task);
  }

  add(schedule: Schedule): void {
    const schedules = loadSchedules();
    schedules.push(schedule);
    saveSchedules(schedules);
    this.startTask(schedule);
    logStatus(`Added schedule ${schedule.id}: ${schedule.humanLabel}`);
  }

  remove(scheduleId: string): boolean {
    const task = this.tasks.get(scheduleId);
    if (task) {
      task.stop();
      this.tasks.delete(scheduleId);
    }

    const schedules = loadSchedules();
    const filtered = schedules.filter((s) => s.id !== scheduleId);
    if (filtered.length === schedules.length) return false;

    saveSchedules(filtered);
    return true;
  }

  removeAllForBot(botId: number): void {
    const schedules = loadSchedules();
    const toRemove = schedules.filter((s) => s.botId === botId);
    for (const schedule of toRemove) {
      const task = this.tasks.get(schedule.id);
      if (task) {
        task.stop();
        this.tasks.delete(schedule.id);
      }
    }
    saveSchedules(schedules.filter((s) => s.botId !== botId));
  }

  getSchedules(): Schedule[] {
    return loadSchedules();
  }

  getSchedulesForBot(botId: number): Schedule[] {
    return loadSchedules().filter((s) => s.botId === botId);
  }

  stop(): void {
    for (const [id, task] of this.tasks) {
      task.stop();
      this.tasks.delete(id);
    }
  }
}

export function loadSchedules(): Schedule[] {
  try {
    const raw = fs.readFileSync(SCHEDULES_FILE, "utf-8");
    return JSON.parse(raw) as Schedule[];
  } catch {
    return [];
  }
}

function saveSchedules(schedules: Schedule[]): void {
  ensureDataDir();
  fs.writeFileSync(SCHEDULES_FILE, JSON.stringify(schedules, null, 2), {
    mode: 0o600,
  });
}

export function generateScheduleId(): string {
  const random = Math.random().toString(36).slice(2, 7);
  return `sched_${Date.now()}_${random}`;
}

export async function parseScheduleWithClaude(
  input: string
): Promise<{ cronExpr: string; humanLabel: string; prompt: string } | null> {
  // Strip CLAUDECODE from env to prevent SDK issues
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (k === "CLAUDECODE" || k === "CLAUDE_CODE") continue;
    if (v !== undefined) env[k] = v;
  }

  try {
    const q = query({
      prompt: `Parse this schedule request and return ONLY a JSON object with no other text:
{
  "cronExpr": "<cron expression, 5 fields>",
  "humanLabel": "<human-readable description of the schedule>",
  "prompt": "<the actual task/prompt to run>"
}

Schedule request: "${input}"

Rules:
- cronExpr must be a valid 5-field cron expression (minute hour day-of-month month day-of-week)
- humanLabel should be a concise description like "Every day at 9:00 AM"
- prompt should be the task to execute, extracted from the schedule request
- Return ONLY the JSON object, no markdown, no explanation`,
      options: {
        env,
        model: "claude-haiku-4-5-20251001",
        maxTurns: 1,
        permissionMode: "bypassPermissions",
      },
    });

    let resultText = "";
    for await (const message of q) {
      if (message.type === "result" && message.subtype === "success") {
        resultText = message.result;
        break;
      }
    }

    // Extract JSON from result
    const jsonMatch = resultText.match(/\{[\s\S]*\}/);
    if (!jsonMatch) return null;

    const parsed = JSON.parse(jsonMatch[0]);
    if (!parsed.cronExpr || !parsed.humanLabel || !parsed.prompt) return null;
    if (!cron.validate(parsed.cronExpr)) return null;

    return parsed;
  } catch (err) {
    logError(`Failed to parse schedule with Claude: ${err}`);
    return null;
  }
}
