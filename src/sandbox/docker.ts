import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { SandboxError } from '../core/errors.js';
import { copyDirFiltered, ensureDir, isDirectory, removePath, scanTree } from '../utils/fsx.js';
import { matchesAnyGlob } from '../utils/matching.js';
import { toPosixPath } from '../utils/paths.js';
import { LocalSandbox } from './local.js';
import { runCommandToCompletion, spawnProcess, tokenizeCommand, validateExecutable } from './exec.js';
import type { LocalSandboxOptions } from './local.js';
import type {
  CommandOutcome,
  Sandbox,
  SandboxCapabilities,
  SandboxProcess,
  SpawnOptions,
} from './types.js';
import type { MatcherSpec } from '../utils/matching.js';

export interface DockerSandboxOptions extends Omit<LocalSandboxOptions, 'env'> {
  docker: {
    image: string;
    network: 'none' | 'bridge';
    memory: string;
    cpus: string;
    pidsLimit: number;
    readOnlyRoot: boolean;
    user: string;
    extraArgs: string[];
    shareNpmCache: boolean;
  };
  dockerPath: string;
  env: NodeJS.ProcessEnv;
}

const CONTAINER_WORKDIR = '/workspace';
const CONTAINER_HOME = '/tmp/agentsnap-home';

/**
 * Container isolation via `docker run`.
 *
 * This sandbox provides what the local sandbox cannot: enforced network isolation, memory
 * and CPU limits, PID limits and a read-only root filesystem. It requires a Docker daemon
 * and an image that contains the agent CLI (the base image alone does not).
 *
 * The workspace is a host directory bind-mounted into the container, so file assertions
 * and snapshots are computed from the same files the agent modified.
 */
export class DockerSandbox implements Sandbox {
  readonly kind = 'docker' as const;
  readonly capabilities: SandboxCapabilities;
  readonly #options: DockerSandboxOptions;
  readonly #inner: LocalSandbox;
  #hostRoot: string;
  #containerId: string | null = null;

  constructor(options: DockerSandboxOptions) {
    this.#options = options;
    this.#hostRoot = '';
    this.capabilities = {
      filesystemIsolation: options.mode === 'repo' ? 'in-place' : 'copy',
      kind: 'docker',
      networkBlocked: options.docker.network === 'none',
      processIsolation: 'container',
      resourceLimits: true,
    };
    this.#inner = new LocalSandbox({
      env: options.env,
      exclude: options.exclude,
      fixtures: options.fixtures,
      keepWorkspace: options.keepWorkspace,
      mode: options.mode,
      projectRoot: options.projectRoot,
      runId: options.runId,
    });
  }

  get root(): string {
    return this.#inner.root;
  }

  async prepare(): Promise<void> {
    await ensureDockerAvailable(this.#options.dockerPath);
    await this.#inner.prepare();
    this.#hostRoot = this.#inner.root;

    if (this.#options.mode === 'workspace') {
      // Verify the bind mount actually works before the agent spends money on it.
      const probe = await runCommandToCompletion(
        [
          this.#options.dockerPath,
          'run',
          '--rm',
          '-v',
          `${toPosixPath(this.#hostRoot)}:${CONTAINER_WORKDIR}`,
          this.#options.docker.image,
          'node',
          '-e',
          'process.stdout.write("ok")',
        ],
        { cwd: this.#hostRoot, env: this.#options.env, timeoutSeconds: 120 },
      );
      if (probe.exitCode !== 0) {
        throw new SandboxError(`Could not bind-mount the workspace into ${this.#options.docker.image}.`, {
          causes: [
            probe.stderr.trim().split('\n').slice(0, 4).join('\n') || `docker exited with ${probe.exitCode}.`,
            'Docker Desktop file sharing may not include this directory.',
          ],
          fixes: [
            'Add the project directory to Docker Desktop \u2192 Settings \u2192 Resources \u2192 File sharing.',
            'Or use `sandbox.type: local` which needs no daemon.',
          ],
        });
      }
    }
  }

  api() {
    return this.#inner.api();
  }

  async spawn(argv: string[], options: SpawnOptions): Promise<SandboxProcess> {
    const executable = argv[0];
    if (executable === undefined || executable === '') {
      throw new SandboxError('Cannot spawn an empty command in the sandbox.');
    }
    validateExecutable(executable, 'Agent executable');

    const dockerArgs = this.#dockerRunArgs(options.env, options.inheritEnv ?? []);
    const fullArgv = [this.#options.dockerPath, ...dockerArgs, ...argv];

    const startedAt = Date.now();
    const child = spawnProcess({
      argv: fullArgv,
      cwd: this.#hostRoot,
      env: this.#options.env,
      isolateProcessGroup: true,
      stdin: options.stdin,
      timeoutSeconds: options.timeoutSeconds,
    });

    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      void this.stop();
    }, Math.max(1, options.timeoutSeconds) * 1000);
    timer.unref?.();

    const done = new Promise<{
      durationMs: number;
      exitCode: number | null;
      signal: string | null;
      timedOut: boolean;
    }>((resolvePromise) => {
      const settle = (exitCode: number | null, signal: string | null) => {
        clearTimeout(timer);
        resolvePromise({
          durationMs: Date.now() - startedAt,
          exitCode,
          signal,
          timedOut,
        });
      };
      child.once('close', (code, signal) => settle(code, (signal as string | null) ?? null));
      child.once('error', () => settle(null, null));
    });

    return {
      done,
      kill: () => {
        void this.stop();
      },
      pid: child.pid,
      stderr: child.stderr,
      stdout: child.stdout,
    };
  }

  async scan() {
    return scanTree(this.#hostRoot, {
      exclude: (relativePath) => matchesAnyGlob(relativePath, this.#options.exclude),
    });
  }

  /** Runs a command through `docker run` so post-run assertions share the same isolation. */
  async runCommandString(
    command: string,
    options: Partial<SpawnOptions> & { timeoutSeconds: number },
  ): Promise<CommandOutcome> {
    const argv = tokenizeCommand(command);
    const dockerArgs = this.#dockerRunArgs(options.env, []);
    const outcome = await runCommandToCompletion([this.#options.dockerPath, ...dockerArgs, ...argv], {
      cwd: this.#hostRoot,
      env: { ...this.#options.env, ...options.env },
      isolateProcessGroup: true,
      stdin: options.stdin,
      timeoutSeconds: options.timeoutSeconds,
    });
    return {
      command: outcome.command,
      cwd: CONTAINER_WORKDIR,
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
    await this.stop();
    await this.#inner.dispose();
  }

  /** Best-effort removal of a container left behind by a hard kill. */
  private async stop(): Promise<void> {
    if (this.#containerId === null) return;
    const id = this.#containerId;
    this.#containerId = null;
    await runCommandToCompletion([this.#options.dockerPath, 'rm', '-f', id], {
      cwd: tmpdir(),
      env: this.#options.env,
      timeoutSeconds: 30,
    }).catch(() => undefined);
  }

  #dockerRunArgs(env: Record<string, string> | undefined, inheritEnv: string[]): string[] {
    const docker = this.#options.docker;
    const args: string[] = [
      'run',
      '--rm',
      '-i',
      '--network',
      docker.network,
      '--memory',
      docker.memory,
      '--cpus',
      docker.cpus,
      '--pids-limit',
      String(docker.pidsLimit),
      '--cap-drop',
      'ALL',
      '--security-opt',
      'no-new-privileges',
      '--tmpfs',
      '/tmp:rw,nosuid,nodev,size=256m',
      '--workdir',
      CONTAINER_WORKDIR,
      '-e',
      'HOME=' + CONTAINER_HOME,
      '-e',
      'CI=1',
      ...(docker.readOnlyRoot ? ['--read-only'] : []),
      ...(docker.user ? ['--user', docker.user] : []),
    ];

    if (this.#hostRoot !== '') {
      args.push('-v', `${toPosixPath(this.#hostRoot)}:${CONTAINER_WORKDIR}:rw`);
    }
    if (docker.shareNpmCache) {
      args.push('-v', 'agentsnap-npm-cache:/root/.npm:rw');
    }

    // Only explicitly allowed variables cross the container boundary.
    for (const name of [...inheritEnv, ...Object.keys(env ?? {})]) {
      if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) args.push('-e', name);
    }

    args.push(...docker.extraArgs, docker.image);
    return args;
  }
}

/** Verifies a usable Docker daemon exists, with a message that says how to fix it. */
export async function ensureDockerAvailable(dockerPath = 'docker'): Promise<void> {
  let result;
  try {
    result = await runCommandToCompletion([dockerPath, 'version', '--format', '{{.Server.Version}}'], {
      cwd: resolve(tmpdir()),
      env: process.env,
      timeoutSeconds: 30,
    });
  } catch (error) {
    throw new SandboxError(`Could not run \`${dockerPath}\`.`, {
      cause: error,
      causes: ['The Docker CLI is not on PATH.'],
      fixes: [
        'Install Docker Desktop or the Docker Engine.',
        'Or set `sandbox.type: local` in agentsnap.yaml, which needs no daemon.',
      ],
    });
  }

  if (result.exitCode !== 0) {
    throw new SandboxError('The Docker daemon is not responding.', {
      causes: [
        result.stderr.trim().split('\n').slice(0, 3).join('\n') || `\`docker version\` exited with ${result.exitCode}.`,
      ],
      fixes: [
        'Start Docker Desktop, or start the Docker daemon.',
        'On Linux, check `systemctl status docker`.',
        'Or set `sandbox.type: local` in agentsnap.yaml.',
      ],
    });
  }
}

/** Reports whether the Docker sandbox looks usable, for `agentsnap doctor`. */
export async function probeDocker(dockerPath = 'docker'): Promise<{ available: boolean; version: string | null; detail: string }> {
  try {
    const result = await runCommandToCompletion([dockerPath, 'version', '--format', '{{.Server.Version}}'], {
      cwd: tmpdir(),
      env: process.env,
      timeoutSeconds: 20,
    });
    if (result.exitCode === 0) {
      return { available: true, detail: result.stdout.trim(), version: result.stdout.trim() };
    }
    return {
      available: false,
      detail: result.stderr.trim().split('\n')[0] ?? `exit ${result.exitCode}`,
      version: null,
    };
  } catch (error) {
    return { available: false, detail: error instanceof Error ? error.message : String(error), version: null };
  }
}

/** Creates the host-side workspace directory used as the container bind mount. */
export async function createHostWorkspace(runId: string): Promise<string> {
  const target = join(tmpdir(), `agentsnap-docker-${runId}`);
  await removePath(target);
  await ensureDir(target);
  return target;
}

/** Copies a project tree into a prepared container workspace. */
export async function seedHostWorkspace(source: string, destination: string, exclude: MatcherSpec[]): Promise<void> {
  await copyDirFiltered(source, destination, {
    exclude: (relativePath) => matchesAnyGlob(relativePath, exclude),
    includeSymlinks: false,
  });
  if (!(await isDirectory(destination))) {
    throw new SandboxError(`Container workspace ${destination} was not created.`);
  }
}
