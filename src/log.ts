const isTTY = process.stdout.isTTY ?? false;

const COLORS = {
  reset: "\x1b[0m",
  dim: "\x1b[2m",
  bold: "\x1b[1m",
  red: "\x1b[31m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  blue: "\x1b[34m",
  magenta: "\x1b[35m",
  cyan: "\x1b[36m",
} as const;

function timestamp(): string {
  return new Date().toLocaleTimeString("en-US", { hour12: false });
}

function emit(
  level: string,
  color: string,
  message: string,
  tag?: string,
  extra?: Record<string, unknown>
): void {
  if (isTTY) {
    const prefix = tag ? `${COLORS.dim}[${tag}]${COLORS.reset} ` : "";
    console.log(
      `${COLORS.dim}${timestamp()}${COLORS.reset} ${color}${level}${COLORS.reset} ${prefix}${message}`
    );
  } else {
    console.log(
      JSON.stringify({
        ts: new Date().toISOString(),
        level,
        message,
        ...(tag ? { tag } : {}),
        ...extra,
      })
    );
  }
}

export function logUser(message: string, tag?: string): void {
  emit("USER", COLORS.cyan, message, tag);
}

export function logStatus(message: string, tag?: string): void {
  emit("STATUS", COLORS.blue, message, tag);
}

export function logStream(message: string, tag?: string): void {
  emit("STREAM", COLORS.dim, message, tag);
}

export function logTool(message: string, tag?: string): void {
  emit("TOOL", COLORS.magenta, message, tag);
}

export function logApproval(message: string, tag?: string): void {
  emit("APPROVAL", COLORS.yellow, message, tag);
}

export function logResult(message: string, tag?: string): void {
  emit("RESULT", COLORS.green, message, tag);
}

export function logError(message: string, tag?: string): void {
  emit("ERROR", COLORS.red, message, tag);
}
