/**
 * Tiny stderr logger. stdout stays free for machine-readable output
 * (`doctor --json`, `run --once --json`), the same split imsg itself uses.
 */

export type Level = "debug" | "info" | "warn" | "error";

const ORDER: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };

export interface Logger {
  debug(msg: string, fields?: Record<string, unknown>): void;
  info(msg: string, fields?: Record<string, unknown>): void;
  warn(msg: string, fields?: Record<string, unknown>): void;
  error(msg: string, fields?: Record<string, unknown>): void;
}

export interface LoggerOptions {
  level?: Level;
  /** Strings that must never appear in output (the API key). */
  secrets?: string[];
  write?: (line: string) => void;
  now?: () => Date;
}

/** Replace every occurrence of each secret with a fixed marker. */
export function redact(text: string, secrets: readonly string[]): string {
  let out = text;
  for (const s of secrets) {
    if (s.length >= 6) out = out.split(s).join("[redacted]");
  }
  return out;
}

export function createLogger(opts: LoggerOptions = {}): Logger {
  const level = opts.level ?? "info";
  const secrets = opts.secrets ?? [];
  const write = opts.write ?? ((line: string) => process.stderr.write(`${line}\n`));
  const now = opts.now ?? (() => new Date());

  const emit = (lvl: Level, msg: string, fields?: Record<string, unknown>) => {
    if (ORDER[lvl] < ORDER[level]) return;
    const stamp = now().toISOString();
    const tail = fields && Object.keys(fields).length > 0 ? ` ${JSON.stringify(fields)}` : "";
    write(redact(`${stamp} ${lvl.toUpperCase().padEnd(5)} ${msg}${tail}`, secrets));
  };

  return {
    debug: (m, f) => emit("debug", m, f),
    info: (m, f) => emit("info", m, f),
    warn: (m, f) => emit("warn", m, f),
    error: (m, f) => emit("error", m, f),
  };
}

export const silentLogger: Logger = {
  debug() {},
  info() {},
  warn() {},
  error() {},
};
