import { AgentSnapError, RuntimeError } from '../core/errors.js';
import type { AgentAdapter, DetectContext, DetectionResult } from './types.js';
import { claudeCodeAdapter } from './claude-code.js';
import { fakeAdapter } from './fake.js';

/** Re-exported so callers can keep importing version helpers from the registry. */
export { clearVersionCache, parseVersion, probeVersion, versionAtLeast, type VersionProbe } from './version.js';

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
