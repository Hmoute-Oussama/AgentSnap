import { evaluateAssertions } from '../assertions/evaluate.js';
import type { AssertionContext, ParsedAssertion } from '../assertions/definitions.js';
import type { AgentAdapter, AgentEventFragment, AgentRunInput } from '../adapters/types.js';
import type { AgentSnapConfig, TestCase } from '../config/types.js';
import { EventRecorder, type AgentEvent, type UsageInfo } from '../core/events.js';
import { RuntimeError, SandboxError, TimeoutError } from '../core/errors.js';
import type {
  AssertionResult,
  ExitReason,
  FileChanges,
  RunRecord,
  RunStatus,
  RunSummary,
  SandboxInfo,
} from '../core/types.js';
import { createSandbox } from '../sandbox/index.js';
import { diffSnapshot } from '../snapshots/diff.js';
import { normalizeRun, type SnapshotPayload } from '../snapshots/normalize.js';
import { readSnapshot, writeSnapshot } from '../snapshots/store.js';
import { join } from 'node:path';
import type { Sandbox } from '../sandbox/types.js';
import { computeDelta, type FileDelta } from '../utils/fsx.js';
import { createRunId } from '../utils/hash.js';
import type { Logger } from '../utils/logger.js';
import { createRedactor, type Redactor } from '../utils/redact.js';
import { nowIso } from '../utils/time.js';
import { projectRun } from './project.js';
import { parseJsonLine, readLines, stderrTail } from './stream.js';

export const RUN_RECORD_SCHEMA_VERSION = 1;

export interface RunTestOptions {
  adapter: AgentAdapter;
  attempt: number;
  config: AgentSnapConfig;
  defaultTestCommand: string | null;
  /** Overrides `snapshot.update`, e.g. for `--update-snapshots`. */
  forceSnapshotUpdate?: 'auto' | 'never';
  logger: Logger;
  /** Overrides `snapshot.compare`, e.g. for `--snapshot-mode strict`. */
  snapshotCompare?: 'strict' | 'loose' | 'off';
  recordEvents: boolean;
  signal: AbortSignal;
  test: TestCase;
}

/**
 * Executes one test once and returns its durable, redacted record.
 *
 * The runner is the only place that knows how to turn an adapter plus a sandbox into a
 * `RunRecord`. Everything downstream (reporters, snapshots, diff, CLI) consumes only records,
 * which is what keeps a second adapter from requiring any changes there.
 */
export async function runTest(options: RunTestOptions): Promise<RunRecord> {
  const { adapter, attempt, config, logger, test } = options;
  const runId = createRunId();
  const startedAt = nowIso();
  const start = Date.now();

  if (test.skip) {
    return skippedRecord({ adapter, attempt, runId, startedAt, start, test });
  }

  const redactor = createRedactor(process.env);
  const sandbox = await createSandbox({
    agentEnvOverrides: config.agent.env ?? {},
    agentInheritEnv: config.agent.inheritEnv ?? [],
    extraInheritEnv: runtimeCredentialEnv(adapter.name),
    projectRoot: config.rootDir,
    runId,
    sandbox: config.sandbox,
    test,
  });

  const recorder = new EventRecorder();

  // The wall-clock budget is enforced here instead of being left to the adapter, so an
  // adapter that never returns cannot outlive the timeout it was configured with.
  const timeoutSignal = AbortSignal.timeout(Math.max(1, test.timeout.total) * 1000);
  const runSignal = AbortSignal.any([options.signal, timeoutSignal]);

  try {
    await sandbox.prepare();
    const before = await sandbox.scan();

    const input: AgentRunInput = {
      agent: config.agent,
      emit: (fragment) => void emitFragment(recorder, fragment),
      env: {},
      maxCostUsd: test.maxCostUsd,
      prompt: test.prompt,
      sandbox,
      signal: runSignal,
      test,
      timeoutSeconds: test.timeout.total,
    };

    recorder.emit({ adapter: adapter.name, cwd: sandbox.root, type: 'agent_started' });

    const outcome = await executeRuntime({
      adapter,
      input,
      logger,
      recorder,
      sandbox,
      test,
      timeoutSignal,
    });
    const after = await sandbox.scan();
    const delta = computeDelta(before, after);
    reconcileWriteKinds(recorder, delta);

    const projected = projectRun(recorder.toArray(), {
      delta: toFileChanges(delta),
      output: outcome.output,
      root: sandbox.root,
    });

    const assertions = await evaluateAssertions(
      test.assertions as ParsedAssertion[],
      buildAssertionContext(config, test, projected, sandbox),
      { defaultTestCommand: options.defaultTestCommand },
    );

    const record = buildRecord({
      adapter,
      assertions,
      attempt,
      delta: toFileChanges(delta),
      exitReason: outcome.exitReason,
      output: outcome.output,
      projected,
      redactor,
      recorder,
      recordEvents: options.recordEvents,
      runId,
      sandbox,
      start,
      startedAt,
      status: 'passed',
      test,
      usage: outcome.usage,
    });

    // Snapshots are evaluated after the record exists because they compare against the same
    // normalized payload that gets persisted, keeping the two definitions identical.
    const snapshot = await evaluateSnapshot({
      adapter: adapter.name,
      config,
      forceUpdate: options.forceSnapshotUpdate,
      logger,
      mode: options.snapshotCompare ?? test.snapshot.compare,
      record,
      root: sandbox.root,
      test,
    });

    record.assertions.push(snapshot.assertion);
    if (snapshot.assertion.status === 'failed') {
      record.exitReason = 'assertions-failed';
      record.status = 'failed';
    } else {
      const status = decideStatus(outcome.exitReason, outcome.timedOut, assertions);
      record.exitReason = status.exitReason;
      record.status = status.status;
    }

    return record;
  } catch (error) {
    return errorRecord({
      adapter,
      attempt,
      error,
      logger,
      redactor,
      recorder,
      recordEvents: options.recordEvents,
      runId,
      sandbox,
      start,
      startedAt,
      test,
    });
  } finally {
    await sandbox.dispose().catch((disposeError: unknown) => {
      logger.debug('sandbox cleanup failed', {
        reason: disposeError instanceof Error ? disposeError.message : String(disposeError),
      });
    });
  }
}

/**
 * Environment variables forwarded to a runtime process.
 *
 * Only the credentials that runtime actually needs are passed, so a run never leaks an
 * unrelated token into an agent's process.
 */
function runtimeCredentialEnv(adapterName: string): string[] {
  if (adapterName === 'claude-code') {
    return [
      'ANTHROPIC_API_KEY',
      'ANTHROPIC_AUTH_TOKEN',
      'ANTHROPIC_BASE_URL',
      'CLAUDE_CODE_OAUTH_TOKEN',
      'ANTHROPIC_DEFAULT_HAIKU_MODEL',
      'ANTHROPIC_DEFAULT_SONNET_MODEL',
      'ANTHROPIC_DEFAULT_OPUS_MODEL',
    ];
  }
  return [];
}

// ---------------------------------------------------------------------------
// Runtime execution
// ---------------------------------------------------------------------------

interface ExecuteRuntimeInput {
  adapter: AgentAdapter;
  input: AgentRunInput;
  logger: Logger;
  recorder: EventRecorder;
  sandbox: Sandbox;
  test: TestCase;
  /** Aborts when the test's wall-clock budget is spent. */
  timeoutSignal: AbortSignal;
}

interface RuntimeOutcome {
  errors: string[];
  exitReason: ExitReason;
  output: string;
  timedOut: boolean;
  usage: UsageInfo | null;
}

async function executeRuntime(input: ExecuteRuntimeInput): Promise<RuntimeOutcome> {
  const { adapter, logger, recorder, sandbox, test } = input;
  const errors: string[] = [];

  if (adapter.execution === 'in-process') {
    if (!adapter.run) {
      throw new RuntimeError(`Adapter "${adapter.name}" declares in-process execution but implements no run().`);
    }
    const result = await adapter.run(input.input);
    const output = result.output ?? lastAssistantText(recorder);
    // An in-process adapter has no child process to kill, so the deadline is the only thing
    // that can end it; report it the same way the subprocess path does.
    const timedOut = input.timeoutSignal.aborted;
    const reported = result.errors ?? [];
    return {
      errors: [
        ...reported,
        ...(result.ok === false ? ['the agent reported a failed run'] : []),
        ...(timedOut ? [`the agent exceeded its ${input.input.timeoutSeconds}s timeout`] : []),
      ],
      exitReason: timedOut ? 'timeout' : result.ok === false ? 'agent-error' : 'completed',
      output,
      timedOut,
      usage: result.usage ?? null,
    };
  }

  const argv = await adapter.buildArgv(input.input);
  logger.debug('spawning agent', { argv: argv[0] ?? '', sandbox: sandbox.kind });

  const child = await sandbox.spawn(argv, {
    cwd: input.input.agent.cwd,
    inheritEnv: runtimeCredentialEnv(adapter.name),
    timeoutSeconds: input.input.timeoutSeconds,
  });

  const onAbort = (): void => child.kill('SIGTERM');
  input.input.signal.addEventListener('abort', onAbort, { once: true });

  let output = '';
  let usage: UsageInfo | null = null;
  let failed = false;
  let stderr = '';
  let budgetExceeded = false;

  try {
    void (async () => {
      const chunks: string[] = [];
      child.stderr?.setEncoding('utf8');
      for await (const chunk of child.stderr ?? []) chunks.push(String(chunk));
      stderr = chunks.join('');
    })();

    for await (const line of readLines(child.stdout)) {
      const record = parseJsonLine(line);
      if (record === undefined) {
        logger.debug('non-JSON agent output', { line: line.slice(0, 200) });
        continue;
      }

      for (const fragment of adapter.parseEvent(record, input.input)) {
        emitFragment(recorder, fragment);
        if (fragment.kind === 'tool_call_started' && test.maxToolCalls !== null) {
          const observed = countToolCalls(recorder);
          if (observed > test.maxToolCalls && !budgetExceeded) {
            budgetExceeded = true;
            logger.warn('tool-call budget exceeded; stopping the agent', {
              limit: String(test.maxToolCalls),
              observed: String(observed),
            });
            child.kill('SIGTERM');
          }
        }
      }

      const result = adapter.parseResult(record);
      if (!result) continue;
      if (result.output !== undefined) output = result.output;
      if (result.usage) usage = result.usage;
      if (result.errors) errors.push(...result.errors);
      if (result.ok === false) failed = true;
    }

    const exited = await child.done;
    const tail = stderrTail(stderr);

    if (exited.timedOut) {
      return {
        errors: [...errors, `the agent exceeded its ${input.input.timeoutSeconds}s timeout`],
        exitReason: 'timeout',
        output,
        timedOut: true,
        usage,
      };
    }

    if (budgetExceeded) {
      return {
        errors: [...errors, `the agent exceeded its tool-call budget of ${test.maxToolCalls}`],
        exitReason: 'agent-error',
        output,
        timedOut: false,
        usage,
      };
    }

    if (exited.exitCode !== 0) {
      return {
        errors: [
          ...errors,
          `the agent exited with code ${exited.exitCode ?? `signal ${exited.signal ?? 'unknown'}`}`,
          ...(tail ? [tail] : []),
        ],
        exitReason: 'agent-error',
        output,
        timedOut: false,
        usage,
      };
    }

    if (output === '') output = lastAssistantText(recorder);
    return { errors, exitReason: failed ? 'agent-error' : 'completed', output, timedOut: false, usage };
  } finally {
    input.input.signal.removeEventListener('abort', onAbort);
  }
}

function countToolCalls(recorder: EventRecorder): number {
  let count = 0;
  for (const event of recorder.events) {
    if (event.type === 'tool_call_started') count += 1;
  }
  return count;
}

function lastAssistantText(recorder: EventRecorder): string {
  for (let index = recorder.events.length - 1; index >= 0; index -= 1) {
    const event = recorder.events[index];
    if (event?.type === 'message' && event.role === 'assistant') return event.text;
  }
  return '';
}

// ---------------------------------------------------------------------------
// Fragments -> events
// ---------------------------------------------------------------------------

/**
 * Translates an adapter fragment into a stored event.
 *
 * The fragment discriminator is `kind`; the stored event discriminator is `type`. Sequence
 * numbers and timestamps are assigned here so no adapter has to think about them.
 */
export function emitFragment(recorder: EventRecorder, fragment: AgentEventFragment): AgentEvent {
  switch (fragment.kind) {
    case 'agent_started':
      return recorder.emit({
        adapter: 'agent',
        cwd: '',
        model: fragment.model,
        sessionId: fragment.sessionId,
        type: 'agent_started',
      });
    case 'agent_finished':
      return recorder.emit({
        durationMs: fragment.durationMs ?? 0,
        numTurns: fragment.numTurns,
        ok: fragment.ok,
        usage: fragment.usage,
        type: 'agent_finished',
      });
    case 'tool_call_started':
      return recorder.emit({
        input: fragment.input,
        tool: fragment.tool,
        toolUseId: fragment.toolUseId,
        type: 'tool_call_started',
      });
    case 'tool_call_finished':
      return recorder.emit({
        durationMs: 0,
        ok: fragment.ok,
        output: fragment.output,
        tool: fragment.tool,
        toolUseId: fragment.toolUseId,
        type: 'tool_call_finished',
      });
    case 'file_read':
      return recorder.emit({ path: fragment.path, type: 'file_read' });
    case 'file_written':
      return recorder.emit({ kind: 'modified', path: fragment.path, type: 'file_written' });
    case 'command_started':
      return recorder.emit({ command: fragment.command, cwd: '', type: 'command_started' });
    case 'command_finished':
      return recorder.emit({
        command: fragment.command,
        durationMs: 0,
        exitCode: fragment.exitCode,
        type: 'command_finished',
      });
    case 'network_request':
      return recorder.emit({ blocked: fragment.blocked, type: 'network_request', url: fragment.url });
    case 'permission_request':
      return recorder.emit({
        decision: fragment.decision,
        input: fragment.input,
        tool: fragment.tool,
        type: 'permission_request',
      });
    case 'message':
      return recorder.emit({ role: fragment.role, text: fragment.text, type: 'message' });
    case 'error':
      return recorder.emit({ fatal: fragment.fatal, message: fragment.message, type: 'error' });
    default:
      return recorder.emit({ role: 'system', text: JSON.stringify(fragment), type: 'message' });
  }
}

/**
 * Replaces the adapter's guess at write kind with the measured delta.
 *
 * An adapter reports *that* a file was written; only the before/after scan knows whether it
 * was created, modified or deleted, so the measurement wins.
 */
function reconcileWriteKinds(recorder: EventRecorder, delta: FileDelta): void {
  const created = new Set(delta.created);
  const deleted = new Set(delta.deleted);
  for (const event of recorder.events) {
    if (event.type !== 'file_written') continue;
    if (created.has(event.path)) event.kind = 'created';
    else if (deleted.has(event.path)) event.kind = 'deleted';
    else event.kind = 'modified';
  }
}

// ---------------------------------------------------------------------------
// Record assembly
// ---------------------------------------------------------------------------

function toFileChanges(delta: FileDelta): FileChanges {
  return {
    created: delta.created,
    deleted: delta.deleted,
    modified: delta.modified,
    unchangedCount: delta.unchangedCount,
  };
}

function buildAssertionContext(
  config: AgentSnapConfig,
  test: TestCase,
  projected: ReturnType<typeof projectRun>,
  sandbox: Sandbox,
): AssertionContext {
  return {
    commands: projected.summary.commands.map((entry) => ({
      command: entry.command,
      exitCode: entry.exitCode,
      timedOut: entry.timedOut,
    })),
    filesChanged: projected.summary.filesChanged,
    filesCreated: projected.summary.filesCreated,
    filesDeleted: projected.summary.filesDeleted,
    filesRead: projected.summary.filesRead,
    filesWritten: projected.filesWritten,
    forbidden: config.security.forbidden,
    networkAttempts: projected.summary.network.map((entry) => entry.url),
    output: projected.summary.output,
    permissionRequests: projected.summary.permissions,
    runCommand: async (command, timeoutSeconds) => {
      const outcome = await sandbox.api().exec(command, {
        timeoutSeconds: Math.min(timeoutSeconds, test.timeout.command),
      });
      return {
        exitCode: outcome.exitCode,
        output: `${outcome.stdout}\n${outcome.stderr}`.trim(),
        timedOut: outcome.timedOut,
      };
    },
    sandbox: sandbox.capabilities,
    steps: projected.summary.steps,
    toolCallCounts: projected.summary.toolCallCounts,
    toolCalls: projected.summary.toolCalls,
  };
}

/**
 * Maps runtime outcome plus assertion results onto a status.
 *
 * A runtime that never completed cannot be "passed" no matter what the assertions say, and a
 * run whose assertions failed is `failed` rather than `errored` because that is a normal
 * test result the user is meant to act on.
 */
function decideStatus(
  exitReason: ExitReason,
  timedOut: boolean,
  assertions: readonly AssertionResult[],
): { status: RunStatus; exitReason: ExitReason } {
  if (timedOut) return { exitReason: 'timeout', status: 'timed-out' };
  if (exitReason === 'agent-error') return { exitReason, status: 'failed' };
  if (exitReason !== 'completed') return { exitReason, status: 'errored' };
  const failed = assertions.some((assertion) => assertion.status === 'failed');
  return failed ? { exitReason: 'assertions-failed', status: 'failed' } : { exitReason, status: 'passed' };
}

interface BuildRecordInput {
  adapter: AgentAdapter;
  assertions: AssertionResult[];
  attempt: number;
  delta: FileChanges;
  exitReason: ExitReason;
  output: string;
  projected: ReturnType<typeof projectRun>;
  redactor: Redactor;
  recorder: EventRecorder;
  recordEvents: boolean;
  runId: string;
  sandbox: Sandbox;
  start: number;
  startedAt: string;
  status: RunStatus;
  test: TestCase;
  usage: UsageInfo | null;
}

function buildRecord(input: BuildRecordInput): RunRecord {
  const summary: RunSummary = {
    commands: input.projected.summary.commands.map((entry) => ({ ...entry })),
    errors: [...input.projected.summary.errors],
    filesChanged: [...input.projected.summary.filesChanged],
    filesCreated: [...input.projected.summary.filesCreated],
    filesDeleted: [...input.projected.summary.filesDeleted],
    filesRead: [...input.projected.summary.filesRead],
    network: input.projected.summary.network.map((entry) => ({ ...entry })),
    output: input.redactor.text(input.output),
    permissions: input.projected.summary.permissions.map((entry) => ({ ...entry })),
    steps: input.projected.summary.steps,
    toolCallCounts: { ...input.projected.summary.toolCallCounts },
    toolCalls: input.projected.summary.toolCalls,
  };

  return {
    adapter: input.adapter.name,
    assertions: input.assertions,
    attempt: input.attempt,
    durationMs: Date.now() - input.start,
    events: input.recordEvents ? redactEvents(input.redactor, input.recorder.events) : [],
    exitReason: input.exitReason,
    fileChanges: input.delta,
    model: null,
    runId: input.runId,
    sandbox: sandboxInfo(input.sandbox),
    schemaVersion: RUN_RECORD_SCHEMA_VERSION,
    startedAt: input.startedAt,
    status: input.status,
    summary,
    test: input.test.name,
    usage: input.usage,
  };
}

function sandboxInfo(sandbox: Sandbox): SandboxInfo {
  return {
    filesystemIsolation: sandbox.capabilities.filesystemIsolation,
    kind: sandbox.capabilities.kind,
    networkBlocked: sandbox.capabilities.networkBlocked,
    resourceLimits: sandbox.capabilities.resourceLimits,
  };
}

function redactEvents(redactor: Redactor, events: AgentEvent[]): AgentEvent[] {
  return events.map((event) => redactor.value(event) as AgentEvent);
}

function errorRecord(input: {
  adapter: AgentAdapter;
  attempt: number;
  error: unknown;
  logger: Logger;
  redactor: Redactor;
  recorder: EventRecorder;
  recordEvents: boolean;
  runId: string;
  sandbox: Sandbox;
  start: number;
  startedAt: string;
  test: TestCase;
}): RunRecord {
  const { error } = input;
  const message =
    error instanceof Error ? error.message : `unexpected non-Error failure: ${String(error)}`;

  const exitReason: ExitReason =
    error instanceof TimeoutError
      ? 'timeout'
      : error instanceof SandboxError
        ? 'sandbox-error'
        : error instanceof RuntimeError
          ? 'spawn-failure'
          : isAbort(error)
            ? 'cancelled'
            : 'internal-error';

  if (exitReason === 'internal-error' && error instanceof Error && error.stack) {
    input.logger.debug('internal error stack', { stack: input.redactor.text(error.stack) });
  }

  input.recorder.emit({ fatal: true, message: input.redactor.text(message), type: 'error' });

  const delta: FileChanges = { created: [], deleted: [], modified: [], unchangedCount: 0 };
  const projected = projectRun(input.recorder.events, {
    delta,
    output: '',
    root: input.sandbox.root,
  });

  return buildRecord({
    adapter: input.adapter,
    assertions: [],
    attempt: input.attempt,
    delta,
    exitReason,
    output: '',
    projected,
    redactor: input.redactor,
    recorder: input.recorder,
    recordEvents: input.recordEvents,
    runId: input.runId,
    sandbox: input.sandbox,
    start: input.start,
    startedAt: input.startedAt,
    status: exitReason === 'timeout' ? 'timed-out' : 'errored',
    test: input.test,
    usage: null,
  });
}

function skippedRecord(input: {
  adapter: AgentAdapter;
  attempt: number;
  runId: string;
  startedAt: string;
  start: number;
  test: TestCase;
}): RunRecord {
  return {
    adapter: input.adapter.name,
    assertions: [],
    attempt: input.attempt,
    durationMs: Date.now() - input.start,
    events: [],
    exitReason: 'completed',
    fileChanges: { created: [], deleted: [], modified: [], unchangedCount: 0 },
    model: null,
    runId: input.runId,
    sandbox: {
      filesystemIsolation: 'copy',
      kind: 'local',
      networkBlocked: false,
      resourceLimits: false,
    },
    schemaVersion: RUN_RECORD_SCHEMA_VERSION,
    startedAt: input.startedAt,
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

// ---------------------------------------------------------------------------
// Snapshots
// ---------------------------------------------------------------------------

interface SnapshotEvaluation {
  assertion: AssertionResult;
}

/**
 * Compares the run against its stored behavioral baseline.
 *
 * A missing baseline is created under `update: auto` and reported as a passing (informational)
 * assertion, because the first run of a new test cannot be a regression. Under `never` the
 * same situation fails, which is what CI should use when it wants baselines to be reviewed.
 */
async function evaluateSnapshot(input: {
  adapter: string;
  config: AgentSnapConfig;
  forceUpdate: 'auto' | 'never' | undefined;
  logger: Logger;
  mode: 'strict' | 'loose' | 'off';
  record: RunRecord;
  root: string;
  test: TestCase;
}): Promise<SnapshotEvaluation> {
  const update = input.forceUpdate ?? input.test.snapshot.update;
  const dir = join(input.config.rootDir, input.config.snapshot.dir);
  const store = {
    adapter: input.adapter,
    dir,
    model: input.record.model,
    test: input.test.name,
    variant: input.test.snapshot.variant,
  };

  const payload = normalizeRun(input.record, input.root);
  const stored = await readSnapshot(store);
  const diff = diffSnapshot(payload, stored, { mode: input.mode, update });

  if (stored === null) {
    if (update === 'auto') {
      const written = await writeSnapshot(store, payload, update);
      if (written) {
        input.logger.info('recorded a new behavioral baseline', {
          test: input.test.name,
          variant: input.test.snapshot.variant,
        });
      }
    } else {
      input.logger.info('no baseline was written because snapshot.update is `never`', {
        test: input.test.name,
      });
    }
  }

  const index = input.record.assertions.length;
  const base = {
    expectation: 'the agent behaves like the recorded baseline',
    index,
    kind: 'snapshot_matches',
  };

  if (diff.status === 'disabled') {
    return {
      assertion: { ...base, observed: 'snapshot comparison is disabled', status: 'skipped' },
    };
  }
  if (diff.status === 'created') {
    return {
      assertion: {
        ...base,
        details: { payload },
        observed: `recorded a new baseline (${summarizePayload(payload)})`,
        status: 'passed',
      },
    };
  }
  if (diff.status === 'missing') {
    return {
      assertion: {
        ...base,
        observed: 'no snapshot exists and snapshot.update is `never`',
        skipReason: undefined,
        status: 'failed',
      },
    };
  }
  if (diff.status === 'matched') {
    return {
      assertion: { ...base, observed: summarizePayload(payload), status: 'passed' },
    };
  }

  const observed = [`behavior differs from the recorded baseline:`, ...diff.changes.map((c) => `  ${c}`)].join('\n');
  if (!diff.isRegression) {
    return {
      assertion: {
        ...base,
        details: { changes: diff.changes },
        observed: `${observed}\n(no new side effects, so this is not a regression in \`${input.mode}\` mode)`,
        status: 'warning',
      },
    };
  }
  return {
    assertion: {
      ...base,
      details: { changes: diff.changes, mode: input.mode },
      observed,
      status: 'failed',
    },
  };
}

function summarizePayload(payload: SnapshotPayload): string {
  const parts: string[] = [];
  if (payload.files.length > 0) parts.push(`${payload.files.length} file(s)`);
  if (payload.commands.length > 0) parts.push(`${payload.commands.length} command(s)`);
  if (payload.tools.length > 0) parts.push(`tools: ${payload.tools.join(', ')}`);
  if (parts.length === 0) return 'the agent changed nothing';
  return parts.join(', ');
}

function isAbort(error: unknown): boolean {
  return error instanceof Error && (error.name === 'AbortError' || error.name === 'TimeoutError');
}