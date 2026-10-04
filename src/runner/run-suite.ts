import { join } from 'node:path';
import type { AgentAdapter } from '../adapters/types.js';
import type { AgentSnapConfig, TestCase } from '../config/types.js';
import type {
  DiagnosticEntry,
  FlakinessReport,
  RunRecord,
  SuiteResult,
  SuiteStatus,
  SuiteTotals,
} from '../core/types.js';
import type { Reporter } from '../reporters/types.js';
import { ensureDir, writeJsonAtomic } from '../utils/fsx.js';
import type { Logger } from '../utils/logger.js';
import { nowIso } from '../utils/time.js';
import { runTest, RUN_RECORD_SCHEMA_VERSION } from './run-test.js';
import type { TestFilter } from './filter.js';

export interface RunSuiteOptions {
  adapter: AgentAdapter;
  bail: boolean;
  concurrency: number;
  config: AgentSnapConfig;
  defaultTestCommand: string | null;
  diagnostics?: DiagnosticEntry[];
  filter: TestFilter;
  logger: Logger;
  /** Persist each run record under `.agentsnap/runs`. */
  persistRuns: boolean;
  recordEvents: boolean;
  reporter: Reporter;
  signal: AbortSignal;
  /** Overrides each test's `snapshot.compare` for this run. */
  snapshotCompare?: 'strict' | 'loose' | 'off';
  /** Overrides each test's `snapshot.update`, set by `--update-snapshots`. */
  snapshotUpdate?: 'auto';
  toolVersion: string;
}

export const SUITE_SCHEMA_VERSION = RUN_RECORD_SCHEMA_VERSION;

/**
 * Runs the selected tests and aggregates a suite verdict.
 *
 * Concurrency is opt-in (default 1) because each run copies the workspace: parallel runs are
 * isolated from each other but still multiply API spend and host load, so the default stays
 * predictable.
 */
export async function runSuite(options: RunSuiteOptions): Promise<SuiteResult> {
  const { adapter, config, filter, logger, reporter, signal } = options;
  const startedAt = nowIso();
  const start = Date.now();

  const selected = config.tests.filter((test) => filter.matches(test));
  reporter.suiteStart?.({
    adapter: adapter.name,
    configPath: config.configPath,
    toolVersion: options.toolVersion,
    total: selected.length,
  });

  const records: RunRecord[] = [];
  const allAttempts = new Map<string, RunRecord[]>();
  let interrupted = false;

  if (selected.length === 0) {
    logger.warn('no tests matched the selection', filter.describe());
  }

  const queue = [...selected];
  const workers = Math.max(1, Math.min(options.concurrency, queue.length));

  await Promise.all(
    Array.from({ length: workers }, async () => {
      for (;;) {
        if (interrupted) return;
        if (signal.aborted) {
          interrupted = true;
          return;
        }
        const test = queue.shift();
        if (!test) return;

        const attempts = await runWithRetries({
          adapter,
          config,
          defaultTestCommand: options.defaultTestCommand,
          index: selected.indexOf(test),
          logger,
          persistRuns: options.persistRuns,
          recordEvents: options.recordEvents,
          reporter,
          signal,
          snapshotCompare: options.snapshotCompare,
          snapshotUpdate: options.snapshotUpdate,
          test,
          total: selected.length,
        });

        allAttempts.set(test.name, attempts);
        const final = attempts[attempts.length - 1];
        if (final) records.push(final);

        if (options.bail && final && final.status !== 'passed' && final.status !== 'skipped') {
          interrupted = true;
          logger.warn('bailing out after the first failure', { test: final.test });
          queue.length = 0;
          return;
        }
      }
    }),
  );

  if (signal.aborted) interrupted = true;

  const totals = computeTotals(records);
  const flakiness = computeFlakiness(allAttempts);
  const status = decideSuiteStatus(records, interrupted);

  const result: SuiteResult = {
    adapter: adapter.name,
    configPath: config.configPath,
    diagnostics: options.diagnostics ?? [],
    durationMs: Date.now() - start,
    flakiness,
    schemaVersion: SUITE_SCHEMA_VERSION,
    startedAt,
    status,
    tests: records,
    toolVersion: options.toolVersion,
    totals,
  };

  await persistSuite(config, result, options.persistRuns);
  reporter.suiteEnd?.(result);
  return result;
}

interface RetryInput {
  adapter: AgentAdapter;
  config: AgentSnapConfig;
  defaultTestCommand: string | null;
  index: number;
  logger: Logger;
  persistRuns: boolean;
  recordEvents: boolean;
  reporter: Reporter;
  signal: AbortSignal;
  snapshotCompare?: 'strict' | 'loose' | 'off';
  snapshotUpdate?: 'auto';
  test: TestCase;
  total: number;
}

/**
 * Runs one test until it passes, is skipped, or exhausts its retry budget.
 *
 * Only a `failed` status is retried. `errored` and `timed-out` mean the harness itself or the
 * runtime broke, and retrying those hides real problems rather than smoothing out flakiness.
 */
async function runWithRetries(input: RetryInput): Promise<RunRecord[]> {
  const maxAttempts = input.test.retries + 1;
  const attempts: RunRecord[] = [];

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    if (input.signal.aborted) break;

    input.reporter.testStart?.({
      attempt,
      description: input.test.description,
      index: input.index + 1,
      maxAttempts,
      tags: input.test.tags,
      test: input.test.name,
      total: input.total,
    });

    const record = await runTest({
      adapter: input.adapter,
      attempt,
      config: input.config,
      defaultTestCommand: input.defaultTestCommand,
      forceSnapshotUpdate: input.snapshotUpdate,
      logger: input.logger,
      recordEvents: input.recordEvents,
      signal: input.signal,
      snapshotCompare: input.snapshotCompare,
      test: input.test,
    });

    attempts.push(record);
    input.reporter.attemptEnd?.(record);
    if (input.persistRuns) await persistRun(input.config, record);

    const retryable = record.status === 'failed';
    if (!retryable || attempt === maxAttempts) break;

    input.logger.info('retrying after a failed attempt', {
      attempt,
      next: attempt + 1,
      test: input.test.name,
    });
  }

  const final = attempts[attempts.length - 1];
  if (!final) {
    // Aborted before any attempt ran: report the test as skipped rather than inventing a result.
    const aborted = skippedDueToAbort(input, maxAttempts);
    attempts.push(aborted);
  }

  const statuses = new Set(attempts.map((attempt) => attempt.status));
  input.reporter.testEnd?.({
    attempts,
    durationMs: attempts.reduce((total, attempt) => total + attempt.durationMs, 0),
    record: attempts[attempts.length - 1] as RunRecord,
    unstable: statuses.size > 1,
  });

  return attempts;
}

function skippedDueToAbort(input: RetryInput, attempt: number): RunRecord {
  return {
    adapter: input.adapter.name,
    assertions: [],
    attempt,
    durationMs: 0,
    events: [],
    exitReason: 'cancelled',
    fileChanges: { created: [], deleted: [], modified: [], unchangedCount: 0 },
    model: null,
    runId: 'cancelled',
    sandbox: { filesystemIsolation: 'copy', kind: 'local', networkBlocked: false, resourceLimits: false },
    schemaVersion: RUN_RECORD_SCHEMA_VERSION,
    startedAt: nowIso(),
    status: 'skipped',
    summary: {
      commands: [],
      errors: [],
      filesChanged: [],
      filesCreated: [],
      filesDeleted: [],
      filesRead: [],
      network: [],
      output: '',
      permissions: [],
      steps: 0,
      toolCallCounts: {},
      toolCalls: 0,
    },
    test: input.test.name,
    usage: null,
  };
}

export function computeTotals(records: readonly RunRecord[]): SuiteTotals {
  const totals: SuiteTotals = {
    assertions: { failed: 0, passed: 0, skipped: 0, total: 0, warning: 0 },
    errored: 0,
    failed: 0,
    passed: 0,
    regressions: 0,
    skipped: 0,
    timedOut: 0,
    toolCalls: 0,
    total: records.length,
  };

  for (const record of records) {
    if (record.status === 'passed') totals.passed += 1;
    else if (record.status === 'failed') totals.failed += 1;
    else if (record.status === 'skipped') totals.skipped += 1;
    else if (record.status === 'timed-out') totals.timedOut += 1;
    else totals.errored += 1;

    totals.toolCalls += record.summary.toolCalls;

    for (const assertion of record.assertions) {
      totals.assertions.total += 1;
      if (assertion.status === 'passed') totals.assertions.passed += 1;
      else if (assertion.status === 'failed') {
        totals.assertions.failed += 1;
        if (isRegression(assertion.kind)) totals.regressions += 1;
      } else if (assertion.status === 'warning') totals.assertions.warning += 1;
      else totals.assertions.skipped += 1;
    }
  }

  return totals;
}

const REGRESSION_KINDS = new Set(['must_not_execute', 'must_not_read', 'must_not_write', 'network_access_forbidden']);

/** A failed security assertion is counted separately: it is a finding, not just a red test. */
function isRegression(kind: string): boolean {
  return REGRESSION_KINDS.has(kind);
}

export function computeFlakiness(attemptsByTest: ReadonlyMap<string, RunRecord[]>): FlakinessReport {
  const unstable: FlakinessReport['unstable'] = [];
  let retriesObserved = 0;

  for (const [test, attempts] of attemptsByTest) {
    if (attempts.length > 1) retriesObserved += attempts.length - 1;
    const statuses = [...new Set(attempts.map((attempt) => attempt.status))];
    if (statuses.length > 1) unstable.push({ statuses, test });
  }

  unstable.sort((a, b) => (a.test < b.test ? -1 : a.test > b.test ? 1 : 0));
  return { retriesObserved, unstable };
}

export function decideSuiteStatus(records: readonly RunRecord[], interrupted: boolean): SuiteStatus {
  if (records.some((record) => record.status === 'errored')) return 'error';
  if (interrupted) return 'interrupted';
  if (records.some((record) => record.status === 'failed' || record.status === 'timed-out')) return 'fail';
  return 'pass';
}

async function persistRun(config: AgentSnapConfig, record: RunRecord): Promise<void> {
  const directory = join(config.rootDir, '.agentsnap', 'runs');
  await ensureDir(directory);
  await writeJsonAtomic(join(directory, `${record.runId}.json`), record);
}

async function persistSuite(config: AgentSnapConfig, result: SuiteResult, persist: boolean): Promise<void> {
  if (!persist) return;
  await writeJsonAtomic(join(config.rootDir, '.agentsnap', 'last-run.json'), result);
}