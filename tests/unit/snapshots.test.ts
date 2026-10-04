import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { diffSnapshot, disabledDiff, missingDiff, renderChanges } from '../../src/snapshots/diff.js';
import { normalizeCommand, normalizeRun, type SnapshotPayload } from '../../src/snapshots/normalize.js';
import { readSnapshot, slugifyTestName, snapshotPath, writeSnapshot } from '../../src/snapshots/store.js';
import { makeTempDir } from '../helpers/fixtures.js';
import type { RunRecord } from '../../src/core/types.js';

function payload(overrides: Partial<SnapshotPayload> = {}): SnapshotPayload {
  return { commands: [], files: [], reads: [], tools: [], ...overrides };
}

function record(overrides: Partial<RunRecord> = {}): RunRecord {
  return {
    adapter: 'fake',
    assertions: [],
    attempt: 1,
    durationMs: 10,
    events: [],
    exitReason: 'completed',
    fileChanges: { created: [], deleted: [], modified: [], unchangedCount: 0 },
    model: null,
    runId: 'r1',
    sandbox: { filesystemIsolation: 'copy', kind: 'local', networkBlocked: false, resourceLimits: false },
    schemaVersion: 1,
    startedAt: '2026-01-01T00:00:00.000Z',
    status: 'passed',
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
      steps: 1,
      toolCallCounts: {},
      toolCalls: 0,
    },
    test: 'a test',
    usage: null,
    ...overrides,
  };
}

describe('normalizeCommand', () => {
  it('replaces absolute paths so runs compare equal across temp directories', () => {
    assert.equal(normalizeCommand('cat /tmp/abc123/src/index.ts'), 'cat <path>');
    assert.equal(normalizeCommand('type C:\\work\\src\\index.ts'), 'type <path>');
  });

  it('collapses quoted arguments and newlines', () => {
    assert.equal(normalizeCommand('grep  -n   "foo bar"   src'), 'grep -n "…" src');
  });

  it('is idempotent', () => {
    const once = normalizeCommand('cat /tmp/abc/x.txt');
    assert.equal(normalizeCommand(once), once);
  });
});

describe('normalizeRun', () => {
  it('collects created, modified and deleted files', () => {
    const normalized = normalizeRun(
      record({
        fileChanges: { created: ['a.md'], deleted: ['b.md'], modified: ['src/c.ts'], unchangedCount: 5 },
      }),
      '',
    );
    assert.deepEqual(normalized.files, ['a.md', 'b.md', 'src/c.ts']);
  });

  it('relativizes paths against the sandbox root', () => {
    const normalized = normalizeRun(
      record({ fileChanges: { created: ['/tmp/w/src/a.ts'], deleted: [], modified: [], unchangedCount: 0 } }),
      '/tmp/w',
    );
    assert.deepEqual(normalized.files, ['src/a.ts']);
  });

  it('includes commands, tools and reads', () => {
    const run = record({
      summary: {
        commands: [{ command: 'npm test', durationMs: 1, exitCode: 0, timedOut: false }],
        errors: [],
        filesChanged: [],
        filesCreated: [],
        filesDeleted: [],
        filesRead: ['src/a.ts'],
        network: [],
        output: '',
        permissions: [],
        steps: 1,
        toolCallCounts: { Read: 2, Write: 1 },
        toolCalls: 3,
      },
    });
    const normalized = normalizeRun(run, '');
    assert.deepEqual(normalized.commands, ['npm test']);
    assert.deepEqual(normalized.tools, ['Read', 'Write']);
    assert.deepEqual(normalized.reads, ['src/a.ts']);
  });

  it('is sorted and deduplicated so ordering never causes a false diff', () => {
    const run = record({
      fileChanges: { created: ['z.md', 'a.md', 'a.md'], deleted: [], modified: [], unchangedCount: 0 },
    });
    assert.deepEqual(normalizeRun(run, '').files, ['a.md', 'z.md']);
  });
});

describe('diffSnapshot', () => {
  const stored = { payload: payload({ files: ['a.md'], tools: ['Read'] }) } as never;

  it('reports a match when nothing changed', () => {
    const diff = diffSnapshot(payload({ files: ['a.md'], tools: ['Read'] }), stored, { mode: 'loose', update: 'auto' });
    assert.equal(diff.status, 'matched');
    assert.equal(diff.isRegression, false);
  });

  it('treats a new file as a regression in loose mode', () => {
    const diff = diffSnapshot(payload({ files: ['a.md', 'secrets.md'], tools: ['Read'] }), stored, {
      mode: 'loose',
      update: 'auto',
    });
    assert.equal(diff.status, 'different');
    assert.equal(diff.isRegression, true);
    assert.deepEqual(diff.files.added, ['secrets.md']);
  });

  it('does not treat a removed file as a regression in loose mode', () => {
    const diff = diffSnapshot(payload({ tools: ['Read'] }), stored, { mode: 'loose', update: 'auto' });
    assert.equal(diff.status, 'different');
    assert.equal(diff.isRegression, false);
    assert.deepEqual(diff.files.removed, ['a.md']);
  });

  it('treats any difference as a regression in strict mode', () => {
    const diff = diffSnapshot(payload({ tools: ['Read'] }), stored, { mode: 'strict', update: 'auto' });
    assert.equal(diff.isRegression, true);
  });

  it('never compares in off mode', () => {
    const diff = diffSnapshot(payload({ files: ['totally', 'different'] }), stored, { mode: 'off', update: 'auto' });
    assert.equal(diff.status, 'disabled');
    assert.equal(diff.isRegression, false);
  });

  it('creates a baseline when none exists and update is auto', () => {
    const diff = missingDiff(null, { mode: 'loose', update: 'auto' });
    assert.equal(diff.status, 'created');
    assert.equal(diff.isRegression, false);
  });

  it('fails when no baseline exists and update is never', () => {
    const diff = missingDiff(null, { mode: 'loose', update: 'never' });
    assert.equal(diff.status, 'missing');
    assert.equal(diff.isRegression, true);
  });

  it('renders one line per change', () => {
    const diff = diffSnapshot(payload({ commands: ['rm -rf /'], files: ['a.md'], tools: ['Read'] }), stored, {
      mode: 'loose',
      update: 'auto',
    });
    assert.deepEqual(renderChanges(diff), ['  new command: rm -rf /']);
  });

  it('caps rendered changes', () => {
    const many = Array.from({ length: 30 }, (_, index) => `f${index}.md`);
    const diff = diffSnapshot(payload({ files: many }), stored, { mode: 'loose', update: 'auto' });
    const rendered = renderChanges(diff, 5);
    assert.equal(rendered.length, 6);
    assert.match(rendered[5] as string, /and 27 more change\(s\)/);
  });

  it('returns a disabled diff from disabledDiff()', () => {
    assert.equal(disabledDiff().status, 'disabled');
  });
});

describe('slugifyTestName', () => {
  it('produces a safe, readable, collision-resistant slug', () => {
    const slug = slugifyTestName('The agent writes docs / README.md!');
    assert.match(slug, /^[a-z0-9-]+$/);
    assert.ok(!slug.includes('sha256'));
    assert.ok(slug.startsWith('the-agent-writes-docs-readme-md-'));
  });

  it('distinguishes two similar names', () => {
    assert.notEqual(slugifyTestName('test a'), slugifyTestName('test b'));
  });

  it('handles a name with no usable characters', () => {
    assert.match(slugifyTestName('***'), /^test-[0-9a-f]{8}$/);
  });
});

describe('snapshot store', () => {
  it('round-trips a snapshot', async () => {
    const temp = await makeTempDir();
    try {
      const store = { adapter: 'fake', dir: temp.path, model: null, test: 'a test', variant: 'default' };
      assert.equal(await readSnapshot(store), null);

      const written = await writeSnapshot(store, payload({ files: ['a.md'] }), 'auto');
      assert.ok(written);

      const read = await readSnapshot(store);
      assert.deepEqual(read?.payload.files, ['a.md']);
      assert.equal(read?.test, 'a test');
    } finally {
      await temp.dispose();
    }
  });

  it('writes nothing when update is never', async () => {
    const temp = await makeTempDir();
    try {
      const store = { adapter: 'fake', dir: temp.path, model: null, test: 'a test', variant: 'default' };
      assert.equal(await writeSnapshot(store, payload({ files: ['a.md'] }), 'never'), null);
      assert.equal(await readSnapshot(store), null);
    } finally {
      await temp.dispose();
    }
  });

  it('rejects a hand-edited snapshot whose hash no longer matches', async () => {
    const temp = await makeTempDir();
    try {
      const store = { adapter: 'fake', dir: temp.path, model: null, test: 'a test', variant: 'default' };
      const written = await writeSnapshot(store, payload({ files: ['a.md'] }), 'auto');
      assert.ok(written);
      const { writeJsonAtomic } = await import('../../src/utils/fsx.js');
      await writeJsonAtomic(snapshotPath(store), { ...written, payload: payload({ files: ['tampered.md'] }) });

      assert.equal(await readSnapshot(store), null);
    } finally {
      await temp.dispose();
    }
  });

  it('keeps variants in separate files', async () => {
    const temp = await makeTempDir();
    try {
      const base = { adapter: 'fake', dir: temp.path, model: null, test: 'a test' };
      await writeSnapshot({ ...base, variant: 'default' }, payload({ files: ['a'] }), 'auto');
      await writeSnapshot({ ...base, variant: 'strict' }, payload({ files: ['b'] }), 'auto');

      assert.deepEqual((await readSnapshot({ ...base, variant: 'default' }))?.payload.files, ['a']);
      assert.deepEqual((await readSnapshot({ ...base, variant: 'strict' }))?.payload.files, ['b']);
    } finally {
      await temp.dispose();
    }
  });
});