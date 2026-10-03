import { UsageError } from '../core/errors.js';

/**
 * Dependency-free argument parsing.
 *
 * Supported forms:
 *   --flag            boolean true
 *   --no-flag         boolean false
 *   --key value       string (consumes the next token)
 *   --key=value       string
 *   --key             repeatable flags collect into an array
 *   --                everything after is treated as positional
 */
export interface ParsedArgs {
  command: string | null;
  positionals: string[];
  flags: Map<string, string[]>;
  /** Flags that were seen at least once, including negated forms. */
  provided: Set<string>;
}

export function parseArgs(argv: readonly string[]): ParsedArgs {
  const flags = new Map<string, string[]>();
  const positionals: string[] = [];
  const provided = new Set<string>();
  let command: string | null = null;
  let passthrough = false;

  const set = (name: string, value: string | boolean): void => {
    const key = name;
    provided.add(key);
    const existing = flags.get(key);
    const encoded = value === true ? 'true' : value === false ? 'false' : value;
    if (existing) existing.push(encoded);
    else flags.set(key, [encoded]);
  };

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index] as string;

    if (passthrough) {
      positionals.push(token);
      continue;
    }
    if (token === '--') {
      passthrough = true;
      continue;
    }

    if (!token.startsWith('-') || token === '-') {
      if (command === null) command = token;
      else positionals.push(token);
      continue;
    }

    const withoutDashes = token.replace(/^--?/, '');
    const equals = withoutDashes.indexOf('=');

    if (equals !== -1) {
      set(withoutDashes.slice(0, equals), withoutDashes.slice(equals + 1));
      continue;
    }

    if (withoutDashes.startsWith('no-')) {
      set(withoutDashes.slice(3), false);
      continue;
    }

    // Long flag that takes a value.
    if (VALUE_FLAGS.has(withoutDashes)) {
      const next = argv[index + 1];
      if (next === undefined) {
        throw new UsageError(`Option \`--${withoutDashes}\` needs a value.`, {
          fixes: [`Write it as \`--${withoutDashes} <value>\` or \`--${withoutDashes}=<value>\`.`],
        });
      }
      set(withoutDashes, next);
      index += 1;
      continue;
    }

    // Short flags with an attached or following value.
    const shortValue = SHORT_VALUE_FLAGS[withoutDashes];
    if (shortValue !== undefined) {
      const next = argv[index + 1];
      if (next === undefined || next.startsWith('-')) {
        throw new UsageError(`Option \`-${withoutDashes}\` needs a value.`, {
          fixes: [`Write it as \`-${withoutDashes} <value>\` or \`-${withoutDashes}=<value>\`.`],
        });
      }
      set(shortValue, next);
      index += 1;
      continue;
    }

    if (SHORT_BOOLEAN_FLAGS.has(withoutDashes)) {
      set(withoutDashes, true);
      continue;
    }

    // Unknown bare flag: record it as boolean so `provided` can reject it later.
    set(withoutDashes, true);
  }

  return { command, flags, positionals, provided };
}

/**
 * Long flags that consume the following token.
 *
 * The parser must know this up front: otherwise `--provider fake` silently records
 * `provider=true` and treats `fake` as a positional, which is exactly the kind of bug that
 * makes a CLI feel haunted. Command-level validation of *which* flags exist stays with
 * `readFlags`, because that differs per command.
 */
const VALUE_FLAGS = new Set([
  'concurrency',
  'config',
  'exclude',
  'name',
  'output',
  'provider',
  'reporter',
  'retries',
  'tag',
  'timeout',
]);

/** Short flags that take a value. */
const SHORT_VALUE_FLAGS: Record<string, string> = {
  c: 'config',
  C: 'concurrency',
  r: 'reporter',
  t: 'tag',
  T: 'timeout',
};

/** Short flags that are booleans. */
const SHORT_BOOLEAN_FLAGS = new Set(['h', 'v', 'q', 'f', 'b']);

/** Flags accepted by every command. */
export const GLOBAL_FLAGS = [
  'color',
  'config',
  'debug',
  'help',
  'no-color',
  'quiet',
  'verbose',
  'version',
] as const;

export interface FlagReader {
  bool(name: string, fallback?: boolean): boolean;
  /** Throws when the flag was supplied more than once with conflicting values. */
  number(name: string, fallback?: number): number | undefined;
  string(name: string, fallback?: string): string | undefined;
  list(name: string): string[];
  wasProvided(name: string): boolean;
}

/**
 * Reads a flag without validating it against a command's allow-list.
 *
 * Used before command dispatch, where command-specific flags such as `--provider` are legal
 * but not yet known. Individual commands use {@link readFlags}, which does validate.
 */
export function peekFlags(parsed: ParsedArgs): FlagReader {
  return makeReader(parsed);
}

export function readFlags(parsed: ParsedArgs, allowed: readonly string[]): FlagReader {
  const known = new Set(allowed);

  for (const name of parsed.provided) {
    if (known.has(name)) continue;
    const suggestion = closest(name, allowed);
    throw new UsageError(`Unknown option \`--${name}\`.`, {
      fixes: suggestion
        ? [`Did you mean \`--${suggestion}\`?`]
        : [`Known options: ${allowed.map((entry) => `--${entry}`).join(', ')}.`],
    });
  }

  return makeReader(parsed);
}

function makeReader(parsed: ParsedArgs): FlagReader {
  const raw = (name: string): string[] | undefined => parsed.flags.get(name);

  return {
    bool: (name, fallback = false) => {
      const values = raw(name);
      if (!values || values.length === 0) return fallback;
      const last = values[values.length - 1];
      return last !== 'false';
    },
    list: (name) => raw(name) ?? [],
    number: (name, fallback) => {
      const values = raw(name);
      if (!values || values.length === 0) return fallback;
      const last = values[values.length - 1] as string;
      const value = Number(last);
      if (!Number.isFinite(value)) {
        throw new UsageError(`Option \`--${name}\` expects a number, received ${JSON.stringify(last)}.`);
      }
      return value;
    },
    string: (name, fallback) => {
      const values = raw(name);
      if (!values || values.length === 0) return fallback;
      return values[values.length - 1];
    },
    wasProvided: (name) => parsed.provided.has(name),
  };
}

/** Cheap edit-distance suggestion so typos produce a fix instead of an error wall. */
function closest(name: string, candidates: readonly string[]): string | null {
  let best: string | null = null;
  let bestScore = Number.POSITIVE_INFINITY;
  for (const candidate of candidates) {
    const score = distance(name, candidate);
    if (score < bestScore) {
      bestScore = score;
      best = candidate;
    }
  }
  return bestScore <= 2 ? best : null;
}

function distance(a: string, b: string): number {
  const rows = a.length + 1;
  const columns = b.length + 1;
  let previous = Array.from({ length: columns }, (_, index) => index);
  for (let row = 1; row < rows; row += 1) {
    const current = [row];
    for (let column = 1; column < columns; column += 1) {
      const cost = a[row - 1] === b[column - 1] ? 0 : 1;
      current[column] = Math.min(
        (current[column - 1] as number) + 1,
        (previous[column] as number) + 1,
        (previous[column - 1] as number) + cost,
      );
    }
    previous = current;
  }
  return previous[columns - 1] as number;
}