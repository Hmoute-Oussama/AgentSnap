import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AgentSnapConfig, TestCase } from '../../src/config/types.js';
import { DEFAULT_SECURITY, DEFAULT_SNAPSHOT, DEFAULT_TEST_TIMEOUT } from '../../src/config/types.js';

/** Creates a temporary directory that is removed when `dispose` is called. */
export async function makeTempDir(prefix = 'agentsnap-test-'): Promise<{
  path: string;
  dispose: () => Promise<void>;
}> {
  const path = await mkdtemp(join(tmpdir(), prefix));
  return {
    dispose: async () => {
      await rm(path, { recursive: true, force: true, maxRetries: 3 });
    },
    path,
  };
}

/** Writes a file, creating parent directories. */
export async function writeFileTree(
  root: string,
  files: Record<string, string>,
): Promise<void> {
  for (const [relative, contents] of Object.entries(files)) {
    const target = join(root, relative);
    await mkdir(join(target, '..'), { recursive: true });
    await writeFile(target, contents, 'utf8');
  }
}

/** A minimal test case with sane defaults, overridable per test. */
export function makeTest(overrides: Partial<TestCase> = {}): TestCase {
  return {
    assertions: [],
    description: 'a test',
    fixture: null,
    maxCostUsd: null,
    maxToolCalls: null,
    name: 'a test',
    prompt: 'do the thing',
    retries: 0,
    skip: false,
    skipReason: '',
    snapshot: { compare: 'loose', update: 'auto', variant: 'default' },
    tags: [],
    timeout: { ...DEFAULT_TEST_TIMEOUT },
    ...overrides,
  };
}

/** A minimal config with sane defaults, overridable per test. */
export function makeConfig(overrides: Partial<AgentSnapConfig> = {}): AgentSnapConfig {
  return {
    agent: { provider: 'fake' },
    configPath: '',
    defaults: {
      maxCostUsd: null,
      maxToolCalls: null,
      retries: 0,
      timeout: { ...DEFAULT_TEST_TIMEOUT },
    },
    rootDir: '',
    sandbox: {
      docker: {
        cpus: '1',
        extraArgs: [],
        image: 'node:20-bookworm-slim',
        memory: '2g',
        network: 'none',
        pidsLimit: 512,
        readOnlyRoot: true,
        shareNpmCache: false,
        user: 'node',
      },
      exclude: ['node_modules', '.git'],
      keepWorkspace: false,
      source: 'workspace',
      type: 'local',
    },
    security: structuredClone(DEFAULT_SECURITY),
    snapshot: { ...DEFAULT_SNAPSHOT },
    tests: [],
    version: 1,
    ...overrides,
  };
}