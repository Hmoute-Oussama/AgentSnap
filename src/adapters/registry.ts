import { AgentSnapError, RuntimeError } from '../core/errors.js';
import { runCommandToCompletion } from '../sandbox/exec.js';
import { resolveExecutable } from './executable.js';
import type { AgentAdapter, DetectContext, DetectionResult } from './types.js';
import { claudeCodeAdapter } from './claude-code.js';
import { fakeAdapter } from './fake.js';

/**
 * Built-in adapters.
 *
 * Adding a runtime means implementing `AgentAdapter` and adding it here; nothing in the
 * runner, assertion engine, snapshot store or reporters changes.
 */
const BUILT_IN: AgentAdapter[] = [claudeCodeAdapter, fakeAdapter];

export function builtinAdapters(): AgentAdapter[] {
  return [...BUILT_IN];
}

export function getAdapter(name: string): AgentAdapter {
  const adapter = BUILT_IN.find((candidate) => candidate.name === name);
  if (adapter) return adapter;
  throw new ConfigUnknownAdapter(name);
}

export class ConfigUnknownAdapter extends AgentSnapError {
  constructor(name: string) {
    super(
      'E_UNKNOWN_ADAPTER',
      2,
      `Unknown agent provider ${JSON.stringify(name)}.`,
      {
        causes: [`Registered providers are: ${BUILT_IN.map((adapter) => adapter.name).join(', ')}.`],
        fixes: [
          `Set \`agent.provider\` to one of: ${BUILT_IN.map((adapter) => adapter.name).join(', ')}.`,
          'Run `agentsnap doctor` to see which runtimes are detected on this machine.',
        ],
      },
    );
  }
}

export interface AdapterProbe {
  adapter: AgentAdapter;
  detection: DetectionResult;
}

/** Runs `detect()` for every adapter, in registration order. */
export async function probeAdapters(context: DetectContext): Promise<AdapterProbe[]> {
  const probes: AdapterProbe[] = [];
  for (const adapter of BUILT_IN) {
    try {
      probes.push({ adapter, detection: await adapter.detect(context) });
    } catch (error) {
      probes.push({
        adapter,
        detection: {
          available: false,
          executablePath: null,
          notes: [],
          problems: [error instanceof Error ? error.message : String(error)],
          version: null,
        },
      });
    }
  }
  return probes;
}

export interface VersionProbe {
  version: string | null;
  raw: string | null;
}

/**
 * Reads a runtime's `--version` output once per process.
 *
 * Version-gated flags matter: passing a flag a CLI does not understand makes the run fail
 * with "unknown option", which is indistinguishable from a real agent failure.
 */
const versionCache = new Map<string, Promise<VersionProbe>>();

export async function probeVersion(command: string, env: NodeJS.ProcessEnv): Promise<VersionProbe> {
  const key = command;
  const cached = versionCache.get(key);
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

  versionCache.set(key, pending);
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

/** Turns a spawn failure into the message shape the CLI documents. */
export function describeSpawnFailure(adapterName: string, command: string, error: unknown): RuntimeError {
  const message = error instanceof Error ? error.message : String(error);
  return new RuntimeError(`AgentSnap could not start ${adapterName} using \`${command}\`.`, {
    cause: error,
    causes: [
      `${command} is not installed, or the executable is not available on PATH.`,
      message,
      'The runtime may also be unauthenticated, in which case the first run fails immediately.',
    ],
    fixes: [
      `Install ${adapterName} and make sure \`${command}\` runs in your shell.`,
      'Run `agentsnap doctor` for a full diagnostic.',
      'Or set a different executable with `agent.command` in agentsnap.yaml.',
    ],
  });
}
