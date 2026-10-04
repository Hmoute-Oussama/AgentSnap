import { getAdapter, probeAdapters, versionAtLeast } from '../../adapters/registry.js';
import { loadConfig } from '../../config/index.js';
import { inspectRepository } from '../../config/discovery.js';
import { ExitCode } from '../../core/exit-codes.js';
import { ConfigError, UsageError } from '../../core/errors.js';
import type { DiagnosticEntry, SuiteResult } from '../../core/types.js';
import { runSuite } from '../../runner/run-suite.js';
import { createTestFilter } from '../../runner/filter.js';
import { createReporter } from '../../reporters/index.js';
import type { Logger } from '../../utils/logger.js';
import type { CliContext } from '../context.js';
import { readFlags } from '../args.js';

const RUN_FLAGS = [
  'all',
  'bail',
  'color',
  'concurrency',
  'config',
  'debug',
  'exclude',
  'events',
  'help',
  'include-events',
  'json',
  'json-stream',
  'name',
  'no-color',
  'quiet',
  'reporter',
  'retries',
  'snapshot-mode',
  'tag',
  'timeout',
  'update-snapshots',
  'usage',
  'verbose',
  'version',
] as const;

/**
 * `agentsnap run`
 *
 * Resolves the adapter, refuses to start when the runtime is unusable, then hands everything
 * to the suite runner. A run that cannot possibly succeed fails fast with exit code 3 instead
 * of producing a wall of red assertion failures.
 */
export async function commandRun(context: CliContext): Promise<number> {
  const parsed = context.args;
  const flags = readFlags(parsed, RUN_FLAGS);

  if (flags.bool('help')) {
    context.logger.out(context.help);
    return ExitCode.Success;
  }

  // The positional after the command is a test-name filter, so `agentsnap run web/*` works.
  const nameFilter = flags.string('name') ?? parsed.positionals[0];

  const config = await loadConfig({
    configPath: flags.string('config'),
    cwd: context.cwd,
  });

  const adapter = getAdapter(config.agent.provider);
  const detection = await adapter.detect({
    config: config.agent,
    cwd: config.rootDir,
    env: process.env,
  });

  if (!detection.available) {
    throw new ConfigError(`The ${adapter.displayName} runtime is not usable.`, {
      causes: detection.problems,
      fixes: [
        `Install ${adapter.displayName} and make sure \`${config.agent.command ?? 'the default executable'}\` runs in your shell.`,
        'Run `agentsnap doctor` for a full environment diagnostic.',
        'To try the pipeline without any runtime, set `agent.provider: fake` in your config.',
      ],
      hint: 'agentsnap doctor',
    });
  }

  // A version below the adapter's minimums means flags would be rejected by the CLI itself,
  // which would look like an agent failure instead of a configuration problem.
  const minimum = adapter.minimumVersion?.(detection.version);
  if (minimum !== undefined && minimum !== null && !versionAtLeast(detection.version, minimum)) {
    context.logger.warn('the detected runtime is older than this adapter supports', {
      detected: detection.version ?? 'unknown',
      required: minimum,
    });
  }

  const profile = await inspectRepository(config.rootDir);
  const defaultTestCommand = profile.testCommand;

  const reporterName = flags.string('reporter') ?? (flags.bool('json') ? 'json' : 'console');
  const reporter = createReporter({
    color: context.color,
    logger: context.logger,
    name: reporterName,
    showEvents: flags.bool('events'),
    showUsage: flags.bool('usage'),
    stream: flags.bool('json-stream'),
    verboseAssertions: flags.bool('verbose'),
    write: (text) => context.stdout.write(text),
  });

  const concurrency = Math.max(1, flags.number('concurrency', 1) ?? 1);
  const timeoutOverride = flags.number('timeout');
  const retriesOverride = flags.number('retries');

  const snapshotCompare = parseCompareMode(flags.string('snapshot-mode'));
  // Blessing baselines is explicit: without the flag, `snapshot.update: never` stays `never`,
  // so an existing baseline is never silently rewritten by an ordinary run.
  const snapshotUpdate = flags.bool('update-snapshots') ? 'auto' : undefined;
  const effective = timeoutOverride === undefined && retriesOverride === undefined
    ? config
    : {
        ...config,
        defaults: {
          ...config.defaults,
          retries: retriesOverride ?? config.defaults.retries,
          timeout: {
            ...config.defaults.timeout,
            total: timeoutOverride ?? config.defaults.timeout.total,
          },
        },
        tests: config.tests.map((test) => ({
          ...test,
          retries: retriesOverride ?? test.retries,
          timeout:
            timeoutOverride === undefined
              ? test.timeout
              : { ...test.timeout, total: timeoutOverride },
        })),
      };

  const result = await runSuite({
    adapter,
    bail: flags.bool('bail'),
    concurrency,
    config: effective,
    defaultTestCommand,
    diagnostics: await collectDiagnostics(context, config.agent.provider, detection.version),
    filter: createTestFilter({
      exclude: flags.string('exclude'),
      name: nameFilter,
      tags: flags.list('tag'),
    }),
    logger: context.logger,
    persistRuns: true,
    recordEvents: flags.bool('include-events'),
    reporter,
    signal: context.signal,
    snapshotCompare,
    snapshotUpdate,
    toolVersion: context.toolVersion,
  });

  return exitCodeFor(result);
}

function parseCompareMode(value: string | undefined): 'strict' | 'loose' | 'off' | undefined {
  if (value === undefined) return undefined;
  if (value === 'strict' || value === 'loose' || value === 'off') return value;
  throw new UsageError(`--snapshot-mode must be strict, loose or off, received ${JSON.stringify(value)}.`, {
    fixes: ['Use `--snapshot-mode strict` to fail on any behavioral difference.'],
  });
}

/**
 * Maps a suite verdict onto the documented exit code.
 *
 * Precedence is deliberate: an infrastructure error (3) hides test failures because the
 * results are not trustworthy, and a timeout (4) is only reported when nothing else failed so
 * a genuinely red test is never misreported as a slow one.
 */
export function exitCodeFor(result: SuiteResult): number {
  const { totals } = result;
  if (result.status === 'interrupted') return ExitCode.Interrupted;
  if (totals.errored > 0) return ExitCode.RuntimeError;
  if (totals.timedOut > 0 && totals.failed === 0) return ExitCode.Timeout;
  if (totals.failed > 0) return ExitCode.TestFailure;
  return ExitCode.Success;
}

async function collectDiagnostics(
  context: CliContext,
  provider: string,
  version: string | null,
): Promise<DiagnosticEntry[]> {
  void context;
  void version;
  const entries: DiagnosticEntry[] = [];
  const [probe] = await probeAdapters({
    config: { provider },
    cwd: context.cwd,
    env: process.env,
  });
  if (probe && probe.detection.available) {
    entries.push({
      detail: `${probe.adapter.displayName} ${probe.detection.version ?? '(version unknown)'}`,
      name: 'agent-runtime',
      status: 'ok',
    });
  }
  return entries;
}

export type { Logger };