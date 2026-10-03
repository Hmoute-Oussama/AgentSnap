/**
 * Tiny path-aware validation helpers.
 *
 * AgentSnap validates its own configuration instead of relying on a schema library, so
 * every diagnostic can carry the exact YAML path that is wrong plus a concrete fix.
 * This keeps runtime dependencies to two packages and keeps error wording under our control.
 */

export interface Issue {
  /** JSON-pointer-ish path into the document, e.g. `tests[0].assertions[2].file_changed`. */
  path: string;
  message: string;
  /** Optional extra guidance printed under the issue. */
  hint?: string;
}

export function issue(path: string, message: string, hint?: string): Issue {
  return { path, message, hint };
}

export function joinPath(base: string, key: string | number): string {
  if (typeof key === 'number') return `${base}[${key}]`;
  return base ? `${base}.${key}` : key;
}

export function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function requireObject(value: unknown, path: string): Issue[] {
  if (!isPlainObject(value)) {
    return [issue(path, `expected a mapping, received ${describeType(value)}.`)];
  }
  return [];
}

/** Rejects unknown keys so typos fail loudly instead of silently doing nothing. */
export function rejectUnknownKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
  path: string,
): Issue[] {
  const problems: Issue[] = [];
  for (const key of Object.keys(value)) {
    if (allowed.includes(key)) continue;
    const suggestion = closestKey(key, allowed);
    problems.push(
      issue(
        joinPath(path, key),
        `unknown option \`${key}\`.`,
        suggestion
          ? `Did you mean \`${suggestion}\`? Allowed here: ${allowed.map((k) => `\`${k}\``).join(', ')}.`
          : `Allowed here: ${allowed.map((k) => `\`${k}\``).join(', ')}.`,
      ),
    );
  }
  return problems;
}

export function requireString(
  value: unknown,
  path: string,
  options: { allowEmpty?: boolean; maxLength?: number } = {},
): Issue[] {
  if (typeof value !== 'string') {
    return [issue(path, `expected a string, received ${describeType(value)}.`)];
  }
  if (!options.allowEmpty && value.trim() === '') {
    return [issue(path, 'must not be empty.')];
  }
  if (options.maxLength !== undefined && value.length > options.maxLength) {
    return [issue(path, `must be at most ${options.maxLength} characters (received ${value.length}).`)];
  }
  return [];
}

export function requireNonNegativeNumber(
  value: unknown,
  path: string,
  options: { integer?: boolean; min?: number } = {},
): Issue[] {
  if (typeof value !== 'number' || Number.isNaN(value)) {
    return [issue(path, `expected a number, received ${describeType(value)}.`)];
  }
  if (options.integer && !Number.isInteger(value)) {
    return [issue(path, `expected a whole number, received ${value}.`)];
  }
  if (options.min !== undefined && value < options.min) {
    return [issue(path, `must be >= ${options.min} (received ${value}).`)];
  }
  return [];
}

export function requireBoolean(value: unknown, path: string): Issue[] {
  if (typeof value !== 'boolean') {
    return [issue(path, `expected true or false, received ${describeType(value)}.`)];
  }
  return [];
}

export function requireStringArray(value: unknown, path: string): Issue[] {
  if (!Array.isArray(value)) {
    return [issue(path, `expected a list of strings, received ${describeType(value)}.`)];
  }
  const problems: Issue[] = [];
  value.forEach((entry, index) => {
    problems.push(...requireString(entry, joinPath(path, index)));
  });
  return problems;
}

export function requireEnum<T extends string>(
  value: unknown,
  allowed: readonly T[],
  path: string,
): Issue[] {
  if (typeof value !== 'string') {
    return [issue(path, `expected one of ${allowed.join(', ')}, received ${describeType(value)}.`)];
  }
  if (!(allowed as readonly string[]).includes(value)) {
    const suggestion = closestKey(value, allowed);
    return [
      issue(
        path,
        `\`${value}\` is not a supported value.`,
        `Allowed: ${allowed.join(', ')}.${suggestion ? ` Did you mean \`${suggestion}\`?` : ''}`,
      ),
    ];
  }
  return [];
}

/** Suggestions for misspelled keys are a large usability win for a YAML-heavy config. */
export function closestKey(input: string, candidates: readonly string[]): string | undefined {
  let best: string | undefined;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (const candidate of candidates) {
    const distance = levenshtein(input.toLowerCase(), candidate.toLowerCase());
    if (distance < bestDistance) {
      bestDistance = distance;
      best = candidate;
    }
  }
  const threshold = Math.max(2, Math.floor(input.length / 3));
  return bestDistance <= threshold ? best : undefined;
}

export function describeType(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'a list';
  switch (typeof value) {
    case 'undefined':
      return 'nothing';
    case 'string':
      return 'a string';
    case 'number':
      return 'a number';
    case 'boolean':
      return 'a boolean';
    case 'object':
      return 'a mapping';
    default:
      return typeof value;
  }
}

function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  const previous = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i += 1) {
    let diagonal = previous[0] ?? 0;
    previous[0] = i;
    for (let j = 1; j <= b.length; j += 1) {
      const temp = previous[j] ?? 0;
      previous[j] = Math.min(
        (previous[j - 1] ?? 0) + 1,
        (previous[j] ?? 0) + 1,
        diagonal + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
      diagonal = temp;
    }
  }
  return previous[b.length] ?? Number.POSITIVE_INFINITY;
}

export function formatIssues(issues: Issue[], max = 25): string {
  const shown = issues.slice(0, max).map((item) => {
    const hint = item.hint ? `\n    ${item.hint}` : '';
    return `  - ${item.path}: ${item.message}${hint}`;
  });
  const extra = issues.length > max ? `\n  ... and ${issues.length - max} more problems.` : '';
  return `${shown.join('\n')}${extra}`;
}
