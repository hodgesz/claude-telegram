import * as fs from "node:fs";
import * as path from "node:path";
import { DATA_DIR, ensureDataDir } from "./config.js";

export interface BotConfig {
  id: number;
  token: string;
  username: string;
  workingDir: string;
}

const BOTS_FILE = path.join(DATA_DIR, "bots.json");

export function loadBots(): BotConfig[] {
  try {
    const raw = fs.readFileSync(BOTS_FILE, "utf-8");
    return JSON.parse(raw) as BotConfig[];
  } catch {
    return [];
  }
}

export function saveBots(bots: BotConfig[]): void {
  ensureDataDir();
  fs.writeFileSync(BOTS_FILE, JSON.stringify(bots, null, 2), {
    mode: 0o600,
  });
}

export function addBot(bot: BotConfig): void {
  const bots = loadBots().filter((b) => b.id !== bot.id);
  bots.push(bot);
  saveBots(bots);
}

export function removeBot(botId: number): void {
  const bots = loadBots().filter((b) => b.id !== botId);
  saveBots(bots);
}

export function getBots(): BotConfig[] {
  return loadBots();
}
