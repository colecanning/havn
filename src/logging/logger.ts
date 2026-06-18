/**
 * PII-safe structured logger. Patient and insurance data are sensitive, so values
 * for known PII keys are masked before anything is written. Log field *keys* and
 * *states*, never raw values. When in doubt, mask.
 */

export type LogLevel = "debug" | "info" | "warn" | "error";

const LEVEL_ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

/** Keys whose values must never appear in logs. */
const PII_KEYS = new Set([
  "first_name",
  "last_name",
  "name",
  "email",
  "date_of_birth",
  "dob",
  "phone",
  "address",
  "line1",
  "line2",
  "city",
  "state",
  "zip",
  "insurance_type",
  "insurance",
  "ssn",
  "member_id",
  "value",
]);

function mask(v: unknown): string {
  if (typeof v === "string" && v.length > 0) return `[redacted:${v.length}]`;
  return "[redacted]";
}

/** Return a shallow copy of meta with PII-key values masked. */
export function redact(meta: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(meta)) {
    out[k] = PII_KEYS.has(k) ? mask(v) : v;
  }
  return out;
}

export interface Logger {
  debug(msg: string, meta?: Record<string, unknown>): void;
  info(msg: string, meta?: Record<string, unknown>): void;
  warn(msg: string, meta?: Record<string, unknown>): void;
  error(msg: string, meta?: Record<string, unknown>): void;
  child(context: Record<string, unknown>): Logger;
}

export interface LoggerOptions {
  level?: LogLevel;
  context?: Record<string, unknown>;
}

export function createLogger(opts: LoggerOptions = {}): Logger {
  const level = opts.level ?? "info";
  const context = opts.context ?? {};
  const threshold = LEVEL_ORDER[level];

  function emit(lvl: LogLevel, msg: string, meta?: Record<string, unknown>) {
    if (LEVEL_ORDER[lvl] < threshold) return;
    const line = {
      level: lvl,
      msg,
      ...redact(context),
      ...(meta ? redact(meta) : {}),
    };
    const sink = lvl === "error" ? console.error : lvl === "warn" ? console.warn : console.log;
    sink(JSON.stringify(line));
  }

  return {
    debug: (m, meta) => emit("debug", m, meta),
    info: (m, meta) => emit("info", m, meta),
    warn: (m, meta) => emit("warn", m, meta),
    error: (m, meta) => emit("error", m, meta),
    child: (ctx) => createLogger({ level, context: { ...context, ...ctx } }),
  };
}
