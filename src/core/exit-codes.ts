/**
 * Process exit codes. Documented in `docs/cli.md` and enforced by the CLI entrypoint.
 *
 * These values are part of the public contract: CI systems and scripts depend on them,
 * so they must not change without a major version bump.
 */
export const ExitCode = {
  /** Everything passed. */
  Success: 0,
  /** At least one agent test failed, or a behavioral regression was detected. */
  TestFailure: 1,
  /** `agentsnap.yaml` is missing, unreadable, malformed, or semantically invalid. */
  ConfigError: 2,
  /** Infrastructure problem: agent executable missing, spawn failure, sandbox failure. */
  RuntimeError: 3,
  /** A run, command, or the overall suite exceeded its configured timeout. */
  Timeout: 4,
  /** Interrupted by the user (SIGINT/SIGTERM). 128 + 2, per POSIX shell convention. */
  Interrupted: 130,
} as const;

export type ExitCodeValue = (typeof ExitCode)[keyof typeof ExitCode];

export function isExitCode(value: number): value is ExitCodeValue {
  return Object.values(ExitCode).includes(value as ExitCodeValue);
}

/** Human-readable description used by `agentsnap help` and the docs. */
export const EXIT_CODE_DESCRIPTIONS: ReadonlyArray<{ code: number; name: string; description: string }> = [
  { code: ExitCode.Success, name: 'success', description: 'All selected agent tests passed.' },
  {
    code: ExitCode.TestFailure,
    name: 'test-failure',
    description: 'At least one agent test failed or a behavioral regression was detected.',
  },
  { code: ExitCode.ConfigError, name: 'config-error', description: 'Configuration is missing or invalid.' },
  {
    code: ExitCode.RuntimeError,
    name: 'runtime-error',
    description: 'Infrastructure failure (agent not found, spawn failure, sandbox failure).',
  },
  { code: ExitCode.Timeout, name: 'timeout', description: 'A configured timeout was exceeded.' },
  { code: ExitCode.Interrupted, name: 'interrupted', description: 'Interrupted by the user.' },
];
