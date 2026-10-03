import type { ParsedAssertion } from '../assertions/definitions.js';
import type { MatcherSpec } from '../utils/matching.js';

/** Schema version understood by this build. */
export const CONFIG_VERSION = 1;

/** Highest `version:` accepted by this build. */
export const MAX_SUPPORTED_CONFIG_VERSION = 1;

export interface AgentConfig {
  /** Registered adapter name, e.g. `claude-code` or `fake`. */
  provider: string;
  /** Executable override. Defaults to the adapter's own default binary. */
  command?: string;
  model?: string;
  /** Extra argv appended after the adapter's own flags. */
  args?: string[];
  allowedTools?: string[];
  disallowedTools?: string[];
  /** Adapter-specific permission mode. Never a permission bypass. */
  permissionMode?: string;
  maxTurns?: number;
  appendSystemPrompt?: string;
  /** Extra environment variables for the agent process. Values may reference env vars. */
  env?: Record<string, string>;
  /** Names of additional host env vars to forward (e.g. ANTHROPIC_API_KEY). */
  inheritEnv?: string[];
  /** Working directory inside the sandbox. Defaults to the sandbox root. */
  cwd?: string;
  /**
   * Run in "bare" mode, skipping host-level hooks, plugins, MCP servers and memory files.
   * Off by default: agent tests usually exist to observe the effect of those files.
   */
  bare?: boolean;
}

export interface DockerSandboxConfig {
  image: string;
  network: 'none' | 'bridge';
  memory: string;
  cpus: string;
  pidsLimit: number;
  readOnlyRoot: boolean;
  user: string;
  /** Extra `docker run` arguments appended verbatim. */
  extraArgs: string[];
  /** Mount the host npm cache so installs are fast. Off by default. */
  shareNpmCache: boolean;
}

export interface SandboxConfig {
  type: 'local' | 'docker';
  /**
   * How the agent workspace is prepared.
   *   - `workspace`: the project tree is copied into a temporary directory (write isolation)
   *   - `repo`: the agent runs directly in the project tree (fast, but writes hit your repo)
   */
  source: 'workspace' | 'repo';
  exclude: string[];
  keepWorkspace: boolean;
  docker: DockerSandboxConfig;
}

export interface TimeoutConfig {
  /** Wall-clock budget for one agent run, in seconds. */
  total: number;
  /** Wall-clock budget for a single asserted command, in seconds. */
  command: number;
}

export interface DefaultsConfig {
  timeout: TimeoutConfig;
  retries: number;
  maxToolCalls: number | null;
  maxCostUsd: number | null;
}

export interface SnapshotPolicy {
  /** `auto` writes a missing snapshot, `never` fails when one is missing. */
  update: 'auto' | 'never';
}

export interface SnapshotConfig {
  dir: string;
  update: SnapshotPolicy['update'];
}

/**
 * Declared forbidden-path policy.
 *
 * Patterns here are enforced by assertions and reported as security findings. They are
 * *not* an OS-level access control: see `docs/security.md` for what actually blocks a
 * write versus what is only detected afterwards.
 */
export interface ForbiddenPolicy {
  read: MatcherSpec[];
  write: MatcherSpec[];
  execute: MatcherSpec[];
}

export interface SecurityConfig {
  forbidden: ForbiddenPolicy;
  /** `forbid` is only enforceable under a sandbox that can block egress. */
  network: 'forbid' | 'allow';
}

export interface TestSnapshotConfig extends SnapshotPolicy {
  variant: string;
}

export interface TestCase {
  name: string;
  description: string;
  prompt: string;
  tags: string[];
  skip: boolean;
  skipReason: string;
  /** Directory copied over the workspace before the run (relative to the config file). */
  fixture: string | null;
  assertions: ParsedAssertion[];
  timeout: TimeoutConfig;
  retries: number;
  maxToolCalls: number | null;
  maxCostUsd: number | null;
  snapshot: TestSnapshotConfig;
}

export interface AgentSnapConfig {
  version: number;
  agent: AgentConfig;
  sandbox: SandboxConfig;
  defaults: DefaultsConfig;
  snapshot: SnapshotConfig;
  security: SecurityConfig;
  tests: TestCase[];
  /** Absolute path of the loaded config file. */
  configPath: string;
  /** Absolute path of the project root (directory containing the config file). */
  rootDir: string;
}

export const DEFAULT_TEST_TIMEOUT: TimeoutConfig = { total: 300, command: 60 };

export const DEFAULT_SANDBOX: SandboxConfig = {
  type: 'local',
  source: 'workspace',
  exclude: [
    '.git',
    '**/.git',
    'node_modules',
    '**/node_modules',
    '**/.venv',
    '**/__pycache__',
    'dist',
    'build',
    'coverage',
    '.agentsnap/tmp',
    '.agentsnap/runs',
  ],
  keepWorkspace: false,
  docker: {
    image: 'node:20-bookworm-slim',
    network: 'none',
    memory: '2g',
    cpus: '1',
    pidsLimit: 512,
    readOnlyRoot: true,
    user: 'node',
    extraArgs: [],
    shareNpmCache: false,
  },
};

export const DEFAULT_SNAPSHOT: SnapshotConfig = {
  dir: '.agentsnap/snapshots',
  update: 'auto',
};

/** Shorthand used by the default forbidden policy. */
function matcher(pattern: string): MatcherSpec {
  return { pattern };
}

export const DEFAULT_SECURITY: SecurityConfig = {
  forbidden: {
    execute: ['git push *', 'git commit *', 'npm publish *', 'rm -rf *', 'curl *', 'wget *'].map(matcher),
    read: ['.env', '.env.*', '**/*.pem', '**/id_rsa*', '**/id_ed25519*', '**/.npmrc', '**/.aws/**'].map(matcher),
    write: ['.git/**', '**/*.lock'].map(matcher),
  },
  network: 'forbid',
};
