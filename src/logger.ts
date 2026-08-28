/**
 * stderr-only logger.
 *
 * This server speaks JSON-RPC over stdout via the stdio transport. Writing
 * ANY byte to stdout from here would corrupt the protocol stream — so every
 * log line, at every level, goes to `process.stderr.write` and nowhere else.
 * This is a functional requirement, not just hygiene.
 */
import { redact, safeStringify } from './security/redact.js';

export type LogLevel = 'silent' | 'error' | 'warn' | 'info' | 'debug';

export interface Logger {
  error(msg: string, meta?: unknown): void;
  warn(msg: string, meta?: unknown): void;
  info(msg: string, meta?: unknown): void;
  debug(msg: string, meta?: unknown): void;
}

const LEVEL_ORDER: Record<Exclude<LogLevel, 'silent'>, number> = {
  error: 0,
  warn: 1,
  info: 2,
  debug: 3,
};

function shouldLog(configured: LogLevel, level: Exclude<LogLevel, 'silent'>): boolean {
  if (configured === 'silent') {
    return false;
  }
  return LEVEL_ORDER[level] <= LEVEL_ORDER[configured];
}

function writeLine(level: Exclude<LogLevel, 'silent'>, msg: string, meta: unknown, hasMeta: boolean): void {
  const timestamp = new Date().toISOString();
  const label = level.toUpperCase();
  const safeMsg = redact(msg);
  const line = hasMeta
    ? `[${timestamp}] ${label} ${safeMsg} ${safeStringify(meta)}`
    : `[${timestamp}] ${label} ${safeMsg}`;
  process.stderr.write(`${line}\n`);
}

export function createLogger(level: LogLevel): Logger {
  function emit(target: Exclude<LogLevel, 'silent'>, msg: string, meta?: unknown): void {
    if (!shouldLog(level, target)) {
      return;
    }
    writeLine(target, msg, meta, meta !== undefined);
  }

  return {
    error(msg: string, meta?: unknown): void {
      emit('error', msg, meta);
    },
    warn(msg: string, meta?: unknown): void {
      emit('warn', msg, meta);
    },
    info(msg: string, meta?: unknown): void {
      emit('info', msg, meta);
    },
    debug(msg: string, meta?: unknown): void {
      emit('debug', msg, meta);
    },
  };
}
