import { runCommandToCompletion } from '../sandbox/exec.js';
import { resolveExecutable } from './executable.js';

export interface VersionProbe {
  version: string | null;
  raw: string | null;
}

/**
 * Reads a runtime's `--version` output once per process.
 *
 * Version-gated flags matter: passing a flag a CLI does not understand makes the run fail
 * with "unknown option", which is indistinguishable from a real agent failure.
 *
 * This lives apart from `registry.ts` because adapters need it to build their argv, and
 * `registry.ts` imports the adapters. Keeping it here means importing a single adapter never
 * pulls the registry into a circular initialization.
 */
const versionCache = new Map<string, Promise<VersionProbe>>();

export async function probeVersion(command: string, env: NodeJS.ProcessEnv): Promise<VersionProbe> {
  const cached = versionCache.get(command);
  if (cached) return cached;

  const pending = (async (): Promise<VersionProbe> => {
    try {
      const executable = await resolveExecutable(command, env);
      if (executable === null) return { raw: null, version: null };
      const result = await runCommandToCompletion([executable.path, '--version'], {
        cwd: executable.cwd,
        env,
        timeoutSeconds: 20,
      });
      if (result.exitCode !== 0) return { raw: result.stdout.trim() || null, version: null };
      const raw = result.stdout.trim();
      return { raw, version: parseVersion(raw) };
    } catch {
      return { raw: null, version: null };
    }
  })();

  versionCache.set(command, pending);
  return pending;
}

export function clearVersionCache(): void {
  versionCache.clear();
}

/** Extracts the first dotted numeric version, e.g. `2.1.285 (Claude Code)` -> `2.1.285`. */
export function parseVersion(raw: string): string | null {
  const match = /(\d+)\.(\d+)(?:\.(\d+))?/.exec(raw);
  if (!match) return null;
  const [, major, minor, patch] = match;
  return `${major}.${minor}.${patch ?? '0'}`;
}

/** Semantic-version comparison for numeric dotted versions. */
export function versionAtLeast(actual: string | null, minimum: string): boolean {
  if (actual === null) return false;
  const parse = (value: string): number[] =>
    value.split('.').map((part) => Number.parseInt(part, 10) || 0);
  const left = parse(actual);
  const right = parse(minimum);
  for (let index = 0; index < Math.max(left.length, right.length); index += 1) {
    const a = left[index] ?? 0;
    const b = right[index] ?? 0;
    if (a !== b) return a > b;
  }
  return true;
}