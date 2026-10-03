import type { Readable } from 'node:stream';
import type { FileEntry } from '../utils/fsx.js';
import type { AgentEvent } from '../core/events.js';

/**
 * What a sandbox can actually guarantee.
 *
 * Assertors consult this before evaluating security expectations, so AgentSnap never
 * claims enforcement it does not provide.
 */
export interface SandboxCapabilities {
  kind: 'local' | 'docker';
  /** `copy`: the agent writes into a throwaway copy of the project. `in-place`: it writes to your working tree. */
  filesystemIsolation: 'copy' | 'in-place';
  /** True only when the platform actually blocks egress (Docker `--network none`). */
  networkBlocked: boolean;
  /** True only when memory/CPU/PID limits are enforced by the platform. */
  resourceLimits: boolean;
  processIsolation: 'none' | 'container';
}

export interface SpawnOptions {
  cwd?: string;
  env?: Record<string, string>;
  /** Names of host env vars forwarded into the child (values are read at spawn time). */
  inheritEnv?: string[];
  /** Hard wall-clock limit. The child is killed when it elapses. */
  timeoutSeconds: number;
  stdin?: string;
  onEvent?: (event: Omit<AgentEvent, 'seq' | 'at'>) => void;
}

export interface CommandOutcome {
  command: string;
  cwd: string;
  exitCode: number | null;
  signal: string | null;
  stdout: string;
  stderr: string;
  durationMs: number;
  timedOut: boolean;
  truncated: boolean;
}

export interface SandboxProcess {
  readonly pid: number | undefined;
  readonly stdout: Readable | null;
  readonly stderr: Readable | null;
  readonly done: Promise<{
    durationMs: number;
    exitCode: number | null;
    signal: string | null;
    timedOut: boolean;
  }>;
  kill(signal?: NodeJS.Signals): void;
}

/**
 * File and process operations scoped to one sandbox.
 *
 * Every path is resolved through the sandbox root with traversal checks, so adapters and
 * assertions cannot escape the workspace even if the agent asks them to.
 */
export interface WorkspaceApi {
  readonly root: string;
  /** Resolves a project-relative path, throwing if it escapes the sandbox root. */
  resolve(relativePath: string): string;
  relative(absolutePath: string): string;
  exists(relativePath: string): Promise<boolean>;
  readTextFile(relativePath: string): Promise<string>;
  writeTextFile(relativePath: string, contents: string): Promise<void>;
  mkdir(relativePath: string): Promise<void>;
  remove(relativePath: string): Promise<void>;
  exec(command: string, options: Partial<SpawnOptions> & { timeoutSeconds: number }): Promise<CommandOutcome>;
}

/**
 * Execution isolation.
 *
 * Implementations: `local` (process-level, no OS isolation) and `docker` (container
 * isolation). The assertion engine only depends on this interface.
 */
export interface Sandbox {
  readonly kind: 'local' | 'docker';
  readonly capabilities: SandboxCapabilities;
  /** Absolute path of the directory the agent sees as its project root. */
  readonly root: string;
  prepare(): Promise<void>;
  api(): WorkspaceApi;
  spawn(argv: string[], options: SpawnOptions): Promise<SandboxProcess>;
  /** Current filesystem inventory, used to compute the change delta. */
  scan(): Promise<FileEntry[]>;
  dispose(): Promise<void>;
}
