import { createColorizer, type Colorizer } from './color.js';

export const LOG_LEVELS = ['silent', 'error', 'warn', 'info', 'debug'] as const;
export type LogLevel = (typeof LOG_LEVELS)[number];

export interface LoggerOptions {
  color?: Colorizer;
  debugToFile?: boolean;
  level?: LogLevel;
  /** All diagnostics go here so `--json` keeps stdout machine-readable. */
  stream?: NodeJS.WritableStream;
  stderr?: NodeJS.WritableStream;
}

export interface Logger {
  debug(message: string, fields?: Record<string, unknown>): void;
  error(message: string, fields?: Record<string, unknown>): void;
  info(message: string, fields?: Record<string, unknown>): void;
  /** Terminal sink for reporter output. Reporter never logs. */
  out(line: string): void;
  raw(chunk: string): void;
  warn(message: string, fields?: Record<string, unknown>): void;
}

const LEVEL_RANK: Record<LogLevel, number> = {
  silent: 0,
  error: 1,
  warn: 2,
  info: 3,
  debug: 4,
};

/** Resolves the effective log level from flags and environment. */
export function resolveLogLevel(options: {
  ci?: boolean;
  debug?: boolean;
  quiet?: boolean;
  verbose?: boolean;
}): LogLevel {
  if (options.quiet) return 'error';
  if (options.debug) return 'debug';
  if (options.verbose) return 'debug';
  if (options.ci) return 'warn';
  return 'info';
}

export function createLogger(options: LoggerOptions = {}): Logger {
  const color = options.color ?? createColorizer(false);
  const stream = options.stream ?? process.stderr;
  const stderr = options.stderr ?? process.stderr;
  const level = options.level ?? 'info';
  const threshold = LEVEL_RANK[level];

  const write = (line: string): void => {
    stderr.write(line.endsWith('\n') ? line : `${line}\n`);
  };

  const formatFields = (fields?: Record<string, unknown>): string => {
    if (!fields || Object.keys(fields).length === 0) return '';
    const parts = Object.entries(fields).map(([key, value]) => `${key}=${formatValue(value)}`);
    return ` ${color.dim(parts.join(' '))}`;
  };

  return {
    debug(message, fields) {
      if (threshold < LEVEL_RANK.debug) return;
      write(`${color.dim(`debug ${message}`)}${formatFields(fields)}`);
    },
    error(message, fields) {
      if (threshold < LEVEL_RANK.error) return;
      write(`${color.red('error')} ${message}${formatFields(fields)}`);
    },
    info(message, fields) {
      if (threshold < LEVEL_RANK.info) return;
      write(`${message}${formatFields(fields)}`);
    },
    out(line) {
      stream.write(line.endsWith('\n') ? line : `${line}\n`);
    },
    raw(chunk) {
      stream.write(chunk);
    },
    warn(message, fields) {
      if (threshold < LEVEL_RANK.warn) return;
      write(`${color.yellow('warn')} ${message}${formatFields(fields)}`);
    },
  };
}

function formatValue(value: unknown): string {
  if (typeof value === 'string') return value.includes(' ') ? JSON.stringify(value) : value;
  if (value === null || value === undefined) return String(value);
  if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') {
    return String(value);
  }
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}
