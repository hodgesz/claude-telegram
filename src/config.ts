import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import "dotenv/config";

export const DATA_DIR = path.join(os.homedir(), ".clautel");
const CONFIG_FILE = path.join(DATA_DIR, "config.json");

export interface Config {
  TELEGRAM_BOT_TOKEN: string;
  TELEGRAM_OWNER_ID: number;
  NGROK_AUTH_TOKEN?: string;
  ANTHROPIC_API_KEY?: string;
}

function loadConfigFile(): Record<string, string> {
  try {
    const raw = fs.readFileSync(CONFIG_FILE, "utf-8");
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

function resolveConfig(): Config {
  const file = loadConfigFile();

  // Config file takes priority over env vars (env may have stale values
  // from shell profile that conflict with the setup wizard's choices)
  const token = file.TELEGRAM_BOT_TOKEN ?? process.env.TELEGRAM_BOT_TOKEN ?? "";
  const ownerId = file.TELEGRAM_OWNER_ID ?? process.env.TELEGRAM_OWNER_ID ?? "";
  const ngrokToken =
    file.NGROK_AUTH_TOKEN ?? process.env.NGROK_AUTH_TOKEN ?? undefined;
  const anthropicKey =
    file.ANTHROPIC_API_KEY ?? process.env.ANTHROPIC_API_KEY ?? undefined;

  if (!token) {
    console.error("TELEGRAM_BOT_TOKEN not set. Run: claude-telegram setup");
    process.exit(1);
  }

  if (!ownerId) {
    console.error("TELEGRAM_OWNER_ID not set. Run: claude-telegram setup");
    process.exit(1);
  }

  return {
    TELEGRAM_BOT_TOKEN: token,
    TELEGRAM_OWNER_ID: Number(ownerId),
    NGROK_AUTH_TOKEN: ngrokToken,
    ANTHROPIC_API_KEY: anthropicKey,
  };
}

export const config = resolveConfig();

export function ensureDataDir(): void {
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { mode: 0o700 });
  }
}

export function saveConfig(cfg: Record<string, string>): void {
  ensureDataDir();
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(cfg, null, 2), {
    mode: 0o600,
  });
}
