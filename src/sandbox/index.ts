import { existsSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import { SandboxError } from '../core/errors.js';
import type { MatcherSpec } from '../utils/matching.js';
import type { SandboxConfig, TestCase } from '../config/types.js';
import { BASE_ENV_ALLOWLIST, DEFAULT_DENY_LIST, buildChildEnv } from './env.js';
import { DockerSandbox, ensureDockerAvailable } from './docker.js';
import { LocalSandbox } from './local.js';
import type { Sandbox } from './types.js';

export interface CreateSandboxOptions {
  runId: string;
  projectRoot: string;
  sandbox: SandboxConfig;
  test: TestCase;
  agentEnvOverrides: Record<string, string>;
  agentInheritEnv: string[];
  /** Extra allow-listed variables the adapter needs at runtime (e.g. per-model keys). */
  extraInheritEnv?: string[];
}

/** Resolves the docker executable without shelling out to `which`. */
export function resolveDockerExecutable(): string {
  const configured = process.env['AGENTSNAP_DOCKER_PATH'];
  if (configured !== undefined && configured.trim() !== '') {
    if (!isAbsolute(configured) && !existsSync(configured)) {
      throw new SandboxError(`AGENTSNAP_DOCKER_PATH is set to ${configured}, which does not exist.`, {
        fixes: ['Unset the variable to use `docker` from PATH, or point it at a real executable.'],
      });
    }
    return configured;
  }
  return 'docker';
}

/**
 * Builds the sandbox for one test run.
 *
 * The choice is explicit: `local` is the default because it always works, `docker` is
 * opt-in because it is the only sandbox that can actually enforce network and resource
 * limits. AgentSnap never silently downgrades one to the other.
 */
export async function createSandbox(options: CreateSandboxOptions): Promise<Sandbox> {
  const { sandbox, test } = options;
  const exclude: MatcherSpec[] = sandbox.exclude.map((pattern) => ({ pattern }));
  const fixtures = test.fixture ? [test.fixture] : [];

  const env = buildChildEnv({
    base: BASE_ENV_ALLOWLIST,
    deny: DEFAULT_DENY_LIST,
    inherit: [...options.agentInheritEnv, ...(options.extraInheritEnv ?? [])],
    overrides: options.agentEnvOverrides,
  });

  const shared = {
    env,
    exclude,
    fixtures,
    keepWorkspace: sandbox.keepWorkspace,
    mode: sandbox.source,
    projectRoot: options.projectRoot,
    runId: options.runId,
  };

  if (sandbox.type === 'docker') {
    const dockerPath = resolveDockerExecutable();
    await ensureDockerAvailable(dockerPath);
    return new DockerSandbox({ ...shared, docker: sandbox.docker, dockerPath });
  }

  return new LocalSandbox(shared);
}

export { BASE_ENV_ALLOWLIST, DEFAULT_DENY_LIST, buildChildEnv };
export { DockerSandbox, ensureDockerAvailable, probeDocker } from './docker.js';
export { LocalSandbox } from './local.js';
export * from './types.js';
