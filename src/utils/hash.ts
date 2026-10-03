import { createHash, randomUUID } from 'node:crypto';

export function createRunId(): string {
  return randomUUID().replace(/-/g, '').slice(0, 16);
}

/** Deterministic hash of a value, used for config fingerprints and snapshots. */
export function hashValue(value: unknown): string {
  const json = stableStringify(value);
  return `sha256:${createHash('sha256').update(json).digest('hex').slice(0, 32)}`;
}

export function hashString(value: string): string {
  return `sha256:${createHash('sha256').update(value).digest('hex').slice(0, 32)}`;
}

/** JSON.stringify with deterministic key ordering at every depth. */
export function stableStringify(value: unknown, indent = 0): string {
  return JSON.stringify(sortKeysDeep(value), null, indent);
}

export function sortKeysDeep(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeysDeep);
  if (value && typeof value === 'object' && !(value instanceof Date)) {
    const source = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(source).sort()) out[key] = sortKeysDeep(source[key]);
    return out;
  }
  return value;
}
