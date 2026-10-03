import type { ChildProcess } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join, resolve, sep } from 'node:path';
import { SandboxError } from '../core/errors.js';
import {
  copyDirFiltered,
  ensureDir,
  isDirectory,
  pathExists,
  readText,
  removePath,
  scanTree,
  writeTextAtomic,
} from '../utils/fsx.js';
import { matchesAnyGlob } from '../utils/matching.js';
import { relativePosix, resolveWithin } from '../utils/paths.js';
import {
  killProcessTree,
  runCommandToCompletion,
  spawnProcess,
  tokenizeCommand,
  validateExecutable,
} from './exec.js';
import type { MatcherSpec } from '../utils/matching.js';
import type { CommandOutcome, Sandbox, SandboxCapabilities, SandboxProcess, SpawnOptions, WorkspaceApi } from './types.js';

export interface LocalSandboxOptions {
  /** Project directory whose content the agent sees. */
  projectRoot: string;
  /** Unique id used for the temporary workspace directory name. */
  runId: string;
  mode: 'workspace' | 'repo';
  exclude: MatcherSpec[];
  keepWorkspace: boolean;
  /** Extra directories copied over the workspace before the agent starts. */
  fixtures: string[];
  /** Pre-built allow-listed environment handed to every child process. */
  env: NodeJS.ProcessEnv;
}

/** Never copied or scanned, regardless of configuration. */
const IGNORED_ALWAYS = new Set(['.git', '.agentsnap/tmp', '.agentsnap/runs', 'node_modules/.cache']);

/**
 * Filesystem and process isolation without OS-level containment.
 *
 * What this sandbox genuinely provides:
 *   - the agent's writes land in a throwaway copy of the project, not your working tree
 *   - the child process runs with an allow-listed environment
 *   - every process gets a hard timeout and its whole process tree is killed
 *   - symlinks are never dereferenced while copying, so a hostile repo cannot leak host files
 *
 * What it does NOT provide (see `docs/security.md`):
 *   - no OS-level isolation: the child can read anything the current user can read
 *   - no network blocking
 *   - no memory or CPU limits
 *
 * Those limitations are published through `capabilities` so assertions and reports never
 * overstate what actually happened.
 */
export class LocalSandbox implements Sandbox {
  readonly kind = 'local' as const;
  readonly capabilities: SandboxCapabilities;
  #root: string;
  #temporary: string | null = null;
  readonly #options: LocalSandboxOptions;
  readonly #exclude: (relativePath: string, isDirectory: boolean) => boolean;

  constructor(options: LocalSandboxOptions) {
    this.#options = options;
    this.#root = options.mode === 'repo' ? resolve(options.projectRoot) : '';
    this.capabilities = {
      filesystemIsolation: options.mode === 'repo' ? 'in-place' : 'copy',
      kind: 'local',
      networkBlocked: false,
      processIsolation: 'none',
      resourceLimits: false,
    };
    this.#exclude = (relativePath, isDirectory) => {
      if (isDirectory && IGNORED_ALWAYS.has(relativePath)) return true;
      if (relativePath.startsWith('.agentsnap/tmp/') || relativePath.startsWith('.agentsnap/runs/')) return true;
      return matchesAnyGlob(relativePath, options.exclude);
    };
  }

  get root(): string {
    if (this.#root === '') {
      throw new SandboxError('The local sandbox was used before `prepare()` completed.', {
        fixes: ['This is a bug in AgentSnap. Please report it with the run output.'],
      });
    }
    return this.#root;
  }

  async prepare(): Promise<void> {
    if (this.#options.mode === 'repo') {
      if (!(await isDirectory(this.#root))) {
        throw new SandboxError(`Project directory ${this.#root} does not exist.`);
      }
      return;
    }

    const temporary = join(tmpdir(), `agentsnap-${process.pid.toString(36)}-${this.#options.runId}`);
    await removePath(temporary);
    await ensureDir(temporary);
    this.#temporary = temporary;
    this.#root = temporary;

    const stats = await copyDirFiltered(this.#options.projectRoot, temporary, {
      exclude: this.#exclude,
      includeSymlinks: false,
    });
    if (stats.files === 0) {
      // An empty workspace would make every file assertion vacuously true.
      throw new SandboxError(`Nothing to copy from ${this.#options.projectRoot}.`, {
        causes: ['Every file was excluded, or the project directory contains no files.'],
        fixes: [
          'Check `sandbox.exclude` in agentsnap.yaml.',
          'Run AgentSnap from your project root, not from an empty subdirectory.',
        ],
      });
    }

    for (const fixture of this.#options.fixtures) {
      await copyDirFiltered(fixture, temporary, { includeSymlinks: false });
    }
  }

  api(): WorkspaceApi {
    const root = this.root;
    const guard = (relativePath: string): string => this.resolveInside(relativePath);

    return {
      exists: async (relativePath: string) => pathExists(guard(relativePath)),
      exec: (command, options) => this.runCommandString(command, options),
      mkdir: async (relativePath: string) => {
        await ensureDir(guard(relativePath));
      },
      readTextFile: (relativePath: string) => readText(guard(relativePath)),
      relative: (absolutePath: string) => {
        const relative = relativePosix(root, absolutePath);
        if (relative === null) {
          throw new SandboxError(`Path ${absolutePath} is outside the sandbox workspace.`);
        }
        return relative;
      },
      remove: async (relativePath: string) => {
        await removePath(guard(relativePath));
      },
      resolve: guard,
      root,
      writeTextFile: async (relativePath: string, contents: string) => {
        const target = guard(relativePath);
        await ensureDir(dirname(target));
        await writeTextAtomic(target, contents);
      },
    };
  }

  async spawn(argv: string[], options: SpawnOptions): Promise<SandboxProcess> {
    const executable = argv[0];
    if (executable === undefined || executable === '') {
      throw new SandboxError('Cannot spawn an empty command in the sandbox.');
    }
    validateExecutable(executable, 'Agent executable');

    const startedAt = Date.now();
    let child: ChildProcess;
    try {
      child = spawnProcess({
        argv,
        cwd: options.cwd ? this.api().resolve(options.cwd) : this.root,
        env: { ...this.#options.env, ...options.env },
        isolateProcessGroup: true,
        stdin: options.stdin,
        timeoutSeconds: options.timeoutSeconds,
      });
    } catch (error) {
      throw new SandboxError(`Could not start ${executable}.`, {
        cause: error,
        causes: [error instanceof Error ? error.message : String(error)],
        fixes: [
          `Check that \`${executable}\` is installed and reachable from PATH.`,
          'Run `agentsnap doctor` for a full diagnostic.',
        ],
      });
    }

    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      killProcessTree(child);
    }, Math.max(1, options.timeoutSeconds) * 1000);
    timer.unref?.();

    const done = new Promise<{
      durationMs: number;
      exitCode: number | null;
      signal: string | null;
      timedOut: boolean;
    }>((resolvePromise) => {
      const settle = (exitCode: number | null, signal: string | null, timedOutNow: boolean) => {
        clearTimeout(timer);
        resolvePromise({
          durationMs: Date.now() - startedAt,
          exitCode,
          signal,
          timedOut: timedOutNow,
        });
      };
      child.once('close', (code, signal) => settle(code, (signal as string | null) ?? null, timedOut));
      child.once('error', () => settle(null, null, timedOut));
    });

    return {
      done,
      kill(signal?: NodeJS.Signals) {
        killProcessTree(child, signal ?? 'SIGTERM');
      },
      pid: child.pid,
      stderr: child.stderr,
      stdout: child.stdout,
    };
  }

  async scan() {
    return scanTree(this.root, { exclude: this.#exclude });
  }

  /**
   * Runs a user-supplied command string inside the sandbox without a shell.
   *
   * The string is tokenized by AgentSnap; shell syntax is rejected with guidance rather
   * than executed, so a command from `agentsnap.yaml` cannot be turned into shell input.
   */
  async runCommandString(
    command: string,
    options: Partial<SpawnOptions> & { timeoutSeconds: number },
  ): Promise<CommandOutcome> {
    const argv = tokenizeCommand(command);
    const outcome = await runCommandToCompletion(argv, {
      cwd: options.cwd ? this.api().resolve(options.cwd) : this.root,
      env: { ...this.#options.env, ...options.env },
      isolateProcessGroup: true,
      stdin: options.stdin,
      timeoutSeconds: options.timeoutSeconds,
    });
    return {
      command: outcome.command,
      cwd: outcome.cwd,
      durationMs: outcome.durationMs,
      exitCode: outcome.exitCode,
      signal: outcome.signal,
      stderr: outcome.stderr,
      stdout: outcome.stdout,
      timedOut: outcome.timedOut,
      truncated: outcome.truncated,
    };
  }

  async dispose(): Promise<void> {
    if (this.#temporary === null) return;
    if (this.#options.keepWorkspace) return;
    await removePath(this.#temporary);
    this.#temporary = null;
  }

  resolveInside(relativePath: string): string {
    try {
      return resolveWithin(this.root, relativePath);
    } catch (error) {
      throw new SandboxError(
        `Refused to access ${JSON.stringify(relativePath)}: it points outside the sandbox workspace.`,
        {
          cause: error,
          causes: ['AgentSnap only lets an agent touch files inside the sandbox root.'],
          fixes: [
            'Use a project-relative path such as `src/index.ts`.',
            'If the agent genuinely needs paths outside the project, use `sandbox.source: repo` and accept the risk.',
          ],
        },
      );
    }
  }
}

/** Directory name AgentSnap uses for a temporary workspace. */
export function temporaryWorkspacePath(runId: string): string {
  return join(tmpdir(), `agentsnap-${process.pid.toString(36)}-${runId}`);
}

/** Ensures a parent directory exists before writing into a nested sandbox path. */
export function ensureParent(target: string): string {
  return dirname(target) + sep;
}
