import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { describe, it } from 'node:test';
import { join } from 'node:path';
import { fakeAdapter } from '../../src/adapters/fake.js';
import { parseAssertions, type RawAssertion } from '../../src/assertions/definitions.js';
import { ALL_TESTS, createTestFilter } from '../../src/runner/filter.js';
import { runSuite, type RunSuiteOptions } from '../../src/runner/run-suite.js';
import { runTest } from '../../src/runner/run-test.js';
import type { Reporter, TestEndInfo, TestStartInfo } from '../../src/reporters/types.js';
import { createLogger } from '../../src/utils/logger.js';
import { makeConfig, makeTempDir, makeTest, writeFileTree } from '../helpers/fixtures.js';

const silent = createLogger({ level: 'silent' });

/** Assertions are authored the way a user writes them, then parsed by the real parser. */
function assertions(...raw: RawAssertion[]) {
  const parsed = parseAssertions(raw, 'assertions');
  assert.deepEqual(parsed.issues, []);
  return parsed.assertions;
}

/**
 * Creates a project plus a config rooted in it, which is what the runner expects: snapshots
 * and run records are written under `rootDir`, never inside the throwaway sandbox copy.
 */
async function makeProject(
  tests = [makeTest()],
  files: Record<string, string> = { 'a.txt': 'original' },
) {
  const project = await makeTempDir('agentsnap-project-');
  await writeFileTree(project.path, files);
  const config = makeConfig({ rootDir: project.path, tests });
  return { config, dispose: project.dispose, project: project.path };
}

function run(options: {
  config: ReturnType<typeof makeConfig>;
  test: ReturnType<typeof makeTest>;
  forceSnapshotUpdate?: 'auto';
}) {
  return runTest({
    adapter: fakeAdapter,
    attempt: 1,
    config: options.config,
    defaultTestCommand: null,
    forceSnapshotUpdate: options.forceSnapshotUpdate,
    logger: silent,
    recordEvents: true,
    signal: new AbortController().signal,
    test: options.test,
  });
}

/** The single test of a one-test fixture, asserted rather than force-unwrapped. */
function firstTest(config: ReturnType<typeof makeConfig>): ReturnType<typeof makeTest> {
  const test = config.tests[0];
  assert.ok(test, 'the fixture config must contain a test');
  return test;
}

function lastOf<T>(values: readonly T[]): T {
  const value = values.at(-1);
  assert.ok(value !== undefined, 'expected at least one entry');
  return value;
}

function expectationOf(results: ReadonlyArray<{ expectation: string }>, pattern: RegExp): string {
  const match = results.find((entry) => pattern.test(entry.expectation));
  assert.ok(match, `expected an assertion whose expectation matches ${pattern}`);
  return match.expectation;
}

describe('runTest', () => {
  it('records a passing test with its real sandbox activity', async () => {
    const { config, dispose } = await makeProject([
      makeTest({
        assertions: assertions({ file_created: 'out.txt' }),
        name: 'writes a file',
        prompt: 'write: out.txt = done',
      }),
    ]);
    try {
      const record = await run({ config, test: firstTest(config) });
      assert.equal(record.status, 'passed');
      assert.equal(record.exitReason, 'completed');
      assert.equal(record.test, 'writes a file');
      assert.deepEqual(record.fileChanges.created, ['out.txt']);
      assert.deepEqual(
        record.assertions.map((entry) => [entry.kind, entry.status]),
        [
          ['file_created', 'passed'],
          ['snapshot_matches', 'passed'],
        ],
      );
      assert.equal(record.summary.toolCalls >= 1, true);
    } finally {
      await dispose();
    }
  });

  it('reports the failing assertion and keeps the rest of the verdict', async () => {
    const { config, dispose } = await makeProject([
      makeTest({
        assertions: assertions({ file_created: 'out.txt' }, { file_read: 'never-read.txt' }),
        name: 'partly wrong',
        prompt: 'write: out.txt = done',
      }),
    ]);
    try {
      const record = await run({ config, test: firstTest(config) });
      assert.equal(record.status, 'failed');
      assert.equal(record.exitReason, 'assertions-failed');
      const failed = record.assertions.filter((entry) => entry.status === 'failed');
      assert.deepEqual(
        failed.map((entry) => entry.kind),
        ['file_read'],
      );
      assert.match(expectationOf(failed, /never-read\.txt/), /never-read\.txt/);
      assert.deepEqual(record.fileChanges.created, ['out.txt']);
    } finally {
      await dispose();
    }
  });

  it('never runs a skipped test', async () => {
    const { config, dispose } = await makeProject([
      makeTest({
        name: 'skipped',
        prompt: 'fail: should not run',
        skip: true,
        skipReason: 'on purpose',
      }),
    ]);
    try {
      const record = await run({ config, test: firstTest(config) });
      assert.equal(record.status, 'skipped');
      assert.equal(record.exitReason, 'completed');
      assert.equal(record.assertions.length, 0);
      assert.deepEqual(record.fileChanges.created, []);
    } finally {
      await dispose();
    }
  });

  it('turns an agent failure into a failed run carrying the agent message', async () => {
    const { config, dispose } = await makeProject([
      makeTest({ name: 'agent explodes', prompt: 'fail: the model gave up' }),
    ]);
    try {
      const record = await run({ config, test: firstTest(config) });
      assert.equal(record.status, 'failed');
      assert.equal(record.exitReason, 'agent-error');
      assert.match(record.summary.errors.join('\n'), /the model gave up/);
    } finally {
      await dispose();
    }
  });

  it('captures created, modified and deleted files', async () => {
    const { config, dispose } = await makeProject(
      [
        makeTest({
          name: 'edits files',
          prompt: ['append: a.txt = more', 'write: b.txt = new', 'delete: keep.txt'].join('\n'),
        }),
      ],
      { 'a.txt': 'original', 'keep.txt': 'doomed' },
    );
    try {
      const record = await run({ config, test: firstTest(config) });
      assert.deepEqual(record.fileChanges.created, ['b.txt']);
      assert.deepEqual(record.fileChanges.modified, ['a.txt']);
      assert.deepEqual(record.fileChanges.deleted, ['keep.txt']);
    } finally {
      await dispose();
    }
  });

  it('redacts secrets before they reach the record', async () => {
    process.env['AGENTSNAP_TOKEN'] = 'super-secret-value';
    const { config, dispose } = await makeProject([
      makeTest({ name: 'leaks a token', prompt: 'text: super-secret-value' }),
    ]);
    try {
      const record = await run({ config, test: firstTest(config) });
      assert.doesNotMatch(record.summary.output, /super-secret-value/);
      assert.doesNotMatch(JSON.stringify(record), /super-secret-value/);
    } finally {
      delete process.env['AGENTSNAP_TOKEN'];
      await dispose();
    }
  });

  it('stops a run that exceeds its timeout', async () => {
    const { config, dispose } = await makeProject([
      makeTest({ name: 'hangs', prompt: 'hang', timeout: { command: 5, total: 1 } }),
    ]);
    try {
      const record = await run({ config, test: firstTest(config) });
      assert.equal(record.status, 'timed-out');
      assert.equal(record.exitReason, 'timeout');
    } finally {
      await dispose();
    }
  });
});

describe('runTest snapshots', () => {
  // `exec` is avoided here: a real command would make the baseline depend on the host.
  const prompt = ['write: out.txt = done', 'read: a.txt'].join('\n');

  it('records a baseline, then passes, then fails on new behavior', async () => {
    const { config, dispose } = await makeProject([
      makeTest({ name: 'behaviour', prompt }),
    ]);
    try {
      const first = await run({ config, test: firstTest(config) });
      assert.equal(first.status, 'passed');
      assert.equal(first.assertions.at(-1)?.kind, 'snapshot_matches');

      const second = await run({ config, test: firstTest(config) });
      assert.equal(second.status, 'passed');
      assert.equal(second.assertions.at(-1)?.status, 'passed');

      const drifted = await run({
        config,
        test: makeTest({
          name: 'behaviour',
          prompt: `${prompt}\ndelete: out.txt`,
          snapshot: { compare: 'loose', update: 'never', variant: 'default' },
        }),
      });
      assert.equal(drifted.status, 'failed');
      assert.equal(drifted.exitReason, 'assertions-failed');
      const snapshot = lastOf(drifted.assertions);
      assert.equal(snapshot.kind, 'snapshot_matches');
      assert.equal(snapshot.status, 'failed');
      assert.ok((snapshot.observed ?? '').length > 0);
    } finally {
      await dispose();
    }
  });

  it('blesses a regression when the caller forces an update', async () => {
    const { config, dispose } = await makeProject([
      makeTest({
        name: 'behaviour',
        prompt,
        snapshot: { compare: 'loose', update: 'never', variant: 'default' },
      }),
    ]);
    try {
      // Record the baseline through a forced update, then drift.
      await run({ config, test: firstTest(config) });
      const blessed = await run({
        config,
        test: makeTest({
          name: 'behaviour',
          prompt: `${prompt}\ndelete: out.txt`,
          snapshot: { compare: 'loose', update: 'never', variant: 'default' },
        }),
        forceSnapshotUpdate: 'auto',
      });
      assert.equal(blessed.status, 'passed');
      const snapshot = lastOf(blessed.assertions);
      assert.equal(snapshot.kind, 'snapshot_matches');
      assert.equal(snapshot.status, 'passed');
      assert.match(snapshot.observed ?? '', /new baseline/);

      // The blessed behaviour is what later runs are compared against.
      const after = await run({
        config,
        test: makeTest({
          name: 'behaviour',
          prompt: `${prompt}\ndelete: out.txt`,
          snapshot: { compare: 'loose', update: 'never', variant: 'default' },
        }),
      });
      assert.equal(after.status, 'passed');
    } finally {
      await dispose();
    }
  });

  it('refuses to invent a baseline when update is never', async () => {
    const { config, dispose } = await makeProject([
      makeTest({
        name: 'unblessed',
        prompt,
        snapshot: { compare: 'loose', update: 'never', variant: 'default' },
      }),
    ]);
    try {
      const record = await run({ config, test: firstTest(config) });
      // A missing baseline is a finding, not a silent pass: the run must be blessed on purpose.
      assert.equal(record.assertions.at(-1)?.kind, 'snapshot_matches');
      assert.equal(record.assertions.at(-1)?.status, 'failed');
      assert.equal(record.status, 'failed');
      assert.equal(record.exitReason, 'assertions-failed');
    } finally {
      await dispose();
    }
  });

  it('never compares snapshots when the mode is off', async () => {
    const { config, dispose } = await makeProject([
      makeTest({
        name: 'unchecked',
        prompt: 'fail: still fine',
        snapshot: { compare: 'off', update: 'auto', variant: 'default' },
      }),
    ]);
    try {
      const record = await run({ config, test: firstTest(config) });
      const snapshot = record.assertions.find((entry) => entry.kind === 'snapshot_matches');
      assert.equal(snapshot?.status, 'skipped');
      assert.match(snapshot?.observed ?? '', /disabled/);
    } finally {
      await dispose();
    }
  });
});

describe('runSuite', () => {
  function recordingReporter() {
    const ends: TestEndInfo[] = [];
    const starts: TestStartInfo[] = [];
    let total = 0;
    const reporter: Reporter = {
      name: 'test-recorder',
      suiteEnd: () => undefined,
      suiteStart: (info) => {
        total = info.total;
      },
      testEnd: (info) => {
        ends.push(info);
      },
      testStart: (info) => {
        starts.push(info);
      },
    };
    return { ends, reporter, starts, total: () => total };
  }

  function suite(options: Partial<RunSuiteOptions> & { config: RunSuiteOptions['config'] }): Promise<
    Awaited<ReturnType<typeof runSuite>>
  > {
    const { config, ...rest } = options;
    return runSuite({
      adapter: fakeAdapter,
      bail: false,
      concurrency: 1,
      config,
      defaultTestCommand: null,
      filter: ALL_TESTS,
      logger: silent,
      persistRuns: false,
      recordEvents: true,
      reporter: recordingReporter().reporter,
      signal: new AbortController().signal,
      toolVersion: '0.1.0-test',
      ...rest,
    });
  }

  it('aggregates totals and drives the reporter', async () => {
    const { config, dispose } = await makeProject([
      makeTest({
        assertions: assertions({ file_created: 'b.txt' }),
        name: 'keeps a',
        prompt: 'write: b.txt = new',
      }),
      makeTest({
        assertions: assertions({ file_read: 'missing.txt' }),
        name: 'loses b',
        prompt: 'read: a.txt',
      }),
      makeTest({ name: 'skipped c', prompt: '', skip: true, tags: ['wip'] }),
    ]);
    const sink = recordingReporter();
    try {
      const result = await suite({ config, persistRuns: true, reporter: sink.reporter });
      assert.equal(sink.total(), 3);
      assert.equal(result.totals.total, 3);
      assert.equal(result.totals.passed, 1);
      assert.equal(result.totals.failed, 1);
      assert.equal(result.totals.skipped, 1);
      assert.equal(result.status, 'fail');
      assert.deepEqual(
        result.tests.map((record) => record.test).sort(),
        ['keeps a', 'loses b', 'skipped c'],
      );
      assert.equal(sink.ends.length, 3);
      assert.equal(sink.starts[0]?.total, 3);
      assert.equal(result.totals.assertions.failed >= 1, true);

      // persistRuns writes both the per-run records and the suite summary under the project.
      const runsDir = join(config.rootDir, '.agentsnap', 'runs');
      for (const record of result.tests.filter((entry) => entry.status !== 'skipped')) {
        const persisted = await readFile(join(runsDir, `${record.runId}.json`), 'utf8');
        assert.equal(JSON.parse(persisted).runId, record.runId);
      }
      assert.equal(JSON.parse(await readFile(join(config.rootDir, '.agentsnap', 'last-run.json'), 'utf8')).totals.total, 3);
    } finally {
      await dispose();
    }
  });

  it('selects tests by tag', async () => {
    const { config, dispose } = await makeProject([
      makeTest({ name: 'tagged', prompt: 'read: a.txt', tags: ['smoke'] }),
      makeTest({ name: 'other', prompt: 'read: a.txt', tags: ['slow'] }),
    ]);
    try {
      const result = await suite({ config, filter: createTestFilter({ tags: ['smoke'] }) });
      assert.deepEqual(
        result.tests.map((record) => record.test),
        ['tagged'],
      );
      assert.equal(result.totals.total, 1);
    } finally {
      await dispose();
    }
  });

  it('stops after the first failure when bailing', async () => {
    const { config, dispose } = await makeProject([
      makeTest({
        assertions: assertions({ file_read: 'missing.txt' }),
        name: 'a fails',
        prompt: 'read: a.txt',
      }),
      makeTest({ name: 'b would pass', prompt: 'read: a.txt' }),
    ]);
    try {
      const result = await suite({ bail: true, config });
      assert.deepEqual(
        result.tests.map((record) => record.test),
        ['a fails'],
      );
      assert.equal(result.totals.failed, 1);
    } finally {
      await dispose();
    }
  });
});