import { spawn, type ChildProcess } from 'node:child_process';
import { isAbsolute } from 'node:path';
import { SandboxError } from '../core/errors.js';
import { nowMs } from '../utils/time.js';
import type { CommandOutcome } from './types.js';

export const MAX_CAPTURE_BYTES = 2 * 1024 * 1024;

/** Characters that would require a real shell. AgentSnap never interprets them. */
const SHELL_METACHARACTERS = /[|&;<>()$`\n\r\\]/;

export class CommandSyntaxError extends SandboxError {
  constructor(command: string, found: string) {
    super(`Command ${JSON.stringify(command)} contains ${JSON.stringify(found)}, which needs a shell.`, {
      causes: [
        'AgentSnap never runs commands through a shell, because a shell turns command strings into injection vectors.',
      ],
      fixes: [
        'Split the work into two assertions, for example `command_must_pass: npm run build` and `command_must_pass: npm test`.',
        'Put the pipeline in a script in your repository and assert on that script instead.',
      ],
    });
  }
}

/**
 * Splits a command string into argv without invoking a shell.
 *
 * Supports single quotes, double quotes and backslash escapes. Shell features
 * (pipes, redirects, globs, variable expansion, `&&`) are rejected with an actionable
 * error rather than silently ignored, because silently ignoring them would produce
 * false-positive test results.
 */
export function tokenizeCommand(command: string): string[] {
  const tokens: string[] = [];
  let current = '';
  let quote: '"' | "'" | null = null;
  let escaped = false;
  let started = false;

  for (const char of command) {
    if (escaped) {
      current += char;
      escaped = false;
      continue;
    }
    if (char === '\\' && quote !== "'") {
      escaped = true;
      started = true;
      continue;
    }
    if (quote) {
      if (char === quote) quote = null;
      else current += char;
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      started = true;
      continue;
    }
    if (/\s/.test(char)) {
      if (started) {
        tokens.push(current);
        current = '';
        started = false;
      }
      continue;
    }
    if (SHELL_METACHARACTERS.test(char)) throw new CommandSyntaxError(command, char);
    current += char;
    started = true;
  }

  if (escaped) throw new CommandSyntaxError(command, '\\');
  if (quote) throw new CommandSyntaxError(command, quote);
  if (started) tokens.push(current);
  if (tokens.length === 0) {
    throw new SandboxError(`Command ${JSON.stringify(command)} is empty.`, {
      fixes: ['Provide a command such as `npm test`.'],
    });
  }
  return tokens;
}

export interface SpawnProcessOptions {
  argv: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  inheritStdio?: boolean;
  stdin?: string;
  timeoutSeconds: number;
  /** When true the child is spawned in its own process group so the whole tree can be killed. */
  isolateProcessGroup?: boolean;
}

/**
 * Spawns a child process with a hard timeout and no shell.
 *
 * Security properties this function is responsible for:
 *   - `shell` is never enabled, so argv is passed to the OS verbatim.
 *   - The whole process tree is terminated on timeout, not just the direct child.
 *   - stdout/stderr are captured with a byte cap to prevent memory exhaustion.
 */
export function spawnProcess(options: SpawnProcessOptions): ChildProcess {
  const [command, ...args] = options.argv;
  if (command === undefined || command === '') {
    throw new SandboxError('Cannot spawn an empty command.', {
      fixes: ['Check `agent.command` in your AgentSnap configuration.'],
    });
  }

  const child = spawn(command, args, {
    cwd: options.cwd,
    detached: options.isolateProcessGroup === true && process.platform !== 'win32',
    env: options.env,
    shell: false,
    stdio: [
      options.stdin === undefined ? 'ignore' : 'pipe',
      'pipe',
      'pipe',
    ],
    windowsHide: true,
  });

  // Never let a child's stdio keep the parent event loop alive.
  child.stdout?.resume?.();
  child.stderr?.resume?.();

  const timer = setTimeout(() => {
    killProcessTree(child);
  }, Math.max(1, options.timeoutSeconds) * 1000);
  timer.unref?.();

  child.once('close', () => clearTimeout(timer));
  child.once('error', () => clearTimeout(timer));

  return child;
}

/**
 * Terminates a child and everything it spawned.
 *
 * Windows has no process groups, so `taskkill /T` is used to walk the tree. On POSIX the
 * child was started with `detached: true`, making it a group leader that can be signalled
 * directly.
 */
export function killProcessTree(child: ChildProcess, signal: NodeJS.Signals = 'SIGTERM'): void {
  const pid = child.pid;
  if (pid === undefined) return;

  if (process.platform === 'win32') {
    try {
      spawn('taskkill', ['/pid', String(pid), '/T', '/F'], {
        shell: false,
        stdio: 'ignore',
        windowsHide: true,
      }).once('error', () => {
        try {
          child.kill(signal);
        } catch {
          // Process already gone.
        }
      });
    } catch {
      try {
        child.kill(signal);
      } catch {
        // Process already gone.
      }
    }
    return;
  }

  try {
    process.kill(-pid, signal);
  } catch {
    try {
      child.kill(signal);
    } catch {
      // Process already gone.
    }
  }
}

export interface RunCommandResult extends CommandOutcome {
  /** Raw exit signal, when the child was terminated by a signal. */
  signal: NodeJS.Signals | null;
}

/** Runs a command to completion with a timeout, capturing bounded output. */
export function runCommandToCompletion(
  argv: string[],
  options: Omit<SpawnProcessOptions, 'argv'>,
): Promise<RunCommandResult> {
  return new Promise<RunCommandResult>((resolvePromise, rejectPromise) => {
    const started = nowMs();
    let child: ChildProcess;
    try {
      child = spawnProcess({ ...options, argv });
    } catch (error) {
      rejectPromise(error);
      return;
    }

    const stdout = createBoundedBuffer();
    const stderr = createBoundedBuffer();
    let timedOut = false;
    let settled = false;

    child.stdout?.on('data', (chunk: Buffer) => stdout.push(chunk));
    child.stderr?.on('data', (chunk: Buffer) => stderr.push(chunk));

    child.once('error', (error) => {
      if (settled) return;
      settled = true;
      rejectPromise(
        new SandboxError(`Could not run \`${argv[0] ?? ''}\`.`, {
          cause: error,
          causes: [
            error instanceof Error && (error as NodeJS.ErrnoException).code === 'ENOENT'
              ? 'The executable was not found on PATH.'
              : (error instanceof Error ? error.message : String(error)),
          ],
          fixes: [
            'Install the executable, or set its location with `agent.command` in agentsnap.yaml.',
            'Run `agentsnap doctor` to check whether the executable is reachable.',
          ],
        }),
      );
    });

    child.once('close', (code, signal) => {
      if (settled) return;
      settled = true;
      resolvePromise({
        command: argv.join(' '),
        cwd: options.cwd,
        durationMs: nowMs() - started,
        exitCode: code,
        signal: signal ?? null,
        stderr: stderr.text(),
        stdout: stdout.text(),
        timedOut,
        truncated: stdout.truncated || stderr.truncated,
      });
    });

    if (options.stdin !== undefined && child.stdin) {
      child.stdin.end(options.stdin);
    }

    // Track the timeout ourselves so the result can report `timedOut`.
    const timer = setTimeout(() => {
      timedOut = true;
      killProcessTree(child);
      // Escalate if the process ignores SIGTERM.
      const escalation = setTimeout(() => killProcessTree(child, 'SIGKILL'), 5_000);
      escalation.unref?.();
      child.once('close', () => clearTimeout(escalation));
    }, Math.max(1, options.timeoutSeconds) * 1000);
    timer.unref?.();
    child.once('close', () => clearTimeout(timer));
  });
}

interface BoundedBuffer {
  push(chunk: Buffer): void;
  text(): string;
  readonly truncated: boolean;
}

function createBoundedBuffer(limit = MAX_CAPTURE_BYTES): BoundedBuffer {
  const chunks: Buffer[] = [];
  let size = 0;
  let truncated = false;
  return {
    push(chunk: Buffer) {
      if (size >= limit) {
        truncated = true;
        return;
      }
      chunks.push(chunk);
      size += chunk.byteLength;
      if (size > limit) truncated = true;
    },
    text() {
      return Buffer.concat(chunks).toString('utf8');
    },
    get truncated() {
      return truncated;
    },
  };
}

/** Validates that a configured executable name cannot be used for injection. */
export function validateExecutable(command: string, label: string): void {
  if (command.trim() === '') {
    throw new SandboxError(`${label} is empty.`, {
      fixes: ['Set `agent.command` to the agent executable, for example `claude`.'],
    });
  }
  const needsPath = !isAbsolute(command) && !/^[\w.@+-]+$/.test(command) && process.platform === 'win32';
  if (needsPath) {
    throw new SandboxError(`${label} ${JSON.stringify(command)} is not a valid executable name.`, {
      causes: ['Executable names may only contain letters, digits, `_`, `-`, `.`, `+` and `@`.'],
      fixes: [
        'Use a bare name and rely on PATH (for example `claude`),',
        'or set an absolute path such as `C:\\Users\\you\\AppData\\Roaming\\npm\\claude.cmd`.',
      ],
    });
  }
}
