import { logStatus, logError } from "./log.js";

interface TunnelEntry {
  url: string;
  port: number;
  listener: any;
  timer: ReturnType<typeof setTimeout>;
}

const AUTO_CLOSE_MS = 30 * 60 * 1000; // 30 minutes

export class TunnelManager {
  private tunnels = new Map<number, TunnelEntry>();
  private authToken?: string;
  private onAutoClose?: (chatId: number, url: string) => void;

  constructor(authToken?: string) {
    this.authToken = authToken;
  }

  setAutoCloseCallback(cb: (chatId: number, url: string) => void): void {
    this.onAutoClose = cb;
  }

  async openTunnel(chatId: number, port: number): Promise<string> {
    if (!this.authToken) {
      throw new Error(
        "ngrok auth token not configured. Run setup again or set NGROK_AUTH_TOKEN."
      );
    }

    // Close existing tunnel for this chat
    await this.closeTunnel(chatId);

    let ngrok: typeof import("@ngrok/ngrok");
    try {
      ngrok = await import("@ngrok/ngrok");
    } catch {
      throw new Error(
        "ngrok is not installed. Run: npm install @ngrok/ngrok"
      );
    }

    const listener = await ngrok.forward({
      addr: port,
      authtoken: this.authToken,
    });

    const url = listener.url();
    if (!url) throw new Error("Failed to get tunnel URL");

    const timer = setTimeout(() => {
      logStatus(`Auto-closing tunnel for chat ${chatId} (30min timeout)`);
      this.closeTunnel(chatId);
      this.onAutoClose?.(chatId, url);
    }, AUTO_CLOSE_MS);

    this.tunnels.set(chatId, { url, port, listener, timer });
    logStatus(`Tunnel opened: ${url} → localhost:${port}`);
    return url;
  }

  resetTimer(chatId: number): void {
    const entry = this.tunnels.get(chatId);
    if (!entry) return;

    clearTimeout(entry.timer);
    entry.timer = setTimeout(() => {
      logStatus(`Auto-closing tunnel for chat ${chatId} (30min timeout)`);
      this.closeTunnel(chatId);
      this.onAutoClose?.(chatId, entry.url);
    }, AUTO_CLOSE_MS);
  }

  async closeTunnel(chatId: number): Promise<boolean> {
    const entry = this.tunnels.get(chatId);
    if (!entry) return false;

    clearTimeout(entry.timer);
    try {
      await entry.listener.close();
    } catch (err) {
      logError(`Error closing tunnel: ${err}`);
    }
    this.tunnels.delete(chatId);
    return true;
  }

  async closeAll(): Promise<void> {
    for (const chatId of [...this.tunnels.keys()]) {
      await this.closeTunnel(chatId);
    }
  }

  hasTunnel(chatId: number): boolean {
    return this.tunnels.has(chatId);
  }

  getTunnelInfo(chatId: number): { url: string; port: number } | undefined {
    const entry = this.tunnels.get(chatId);
    if (!entry) return undefined;
    return { url: entry.url, port: entry.port };
  }
}

export function parsePort(input: string): number | null {
  // Try as plain number
  const num = Number(input);
  if (!isNaN(num) && num > 0 && num <= 65535) {
    return Math.floor(num);
  }

  // Try as URL
  try {
    const url = new URL(input);
    const port = url.port ? Number(url.port) : undefined;
    if (port && port > 0 && port <= 65535) return port;
  } catch {
    // Not a URL
  }

  return null;
}
