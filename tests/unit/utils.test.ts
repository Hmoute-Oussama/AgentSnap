import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { join } from 'node:path';
import { computeDelta, copyDirFiltered, hashFile, readJson, scanTree, writeJsonAtomic } from '../../src/utils/fsx.js';
import { createRunId, hashValue, stableStringify } from '../../src/utils/hash.js';
import { EXIT_CODE_DESCRIPTIONS, ExitCode, isExitCode } from '../../src/core/exit-codes.js';
import { ConfigError, isAgentSnapError } from '../../src/core/errors.js';
import { makeTempDir, writeFileTree } from '../helpers/fixtures.js';

describe('hashing', () => {
  it('hashes structurally, not textually', () => {
    assert.equal(hashValue({ a: 1, b: [2, 3] }), hashValue({ b: [2, 3], a: 1 }));
    assert.notEqual(hashValue({ a: 1 }), hashValue({ a: 2 }));
  });

  it('prefixes hashes so their provenance is obvious', () => {
    assert.match(hashValue('x'), /^sha256:[0-9a-f]{32}$/);
  });

  it('sorts keys at every depth when stringifying', () => {
    assert.equal(stableStringify({ b: { d: 1, c: 2 }, a: 3 }), '{"a":3,"b":{"c":2,"d":1}}');
  });

  it('generates unique run ids', () => {
    const ids = new Set(Array.from({ length: 100 }, () => createRunId()));
    assert.equal(ids.size, 100);
    assert.match(createRunId(), /^[0-9a-f]{16}$/);
  });
});

describe('scanTree and computeDelta', () => {
  it('reports created, modified and deleted files', async () => {
    const temp = await makeTempDir();
    try {
      await writeFileTree(temp.path, { 'a.txt': 'one', 'b.txt': 'two', 'gone.txt': 'bye' });
      const before = await scanTree(temp.path);
      await writeFileTree(temp.path, { 'a.txt': 'one', 'b.txt': 'changed', 'new.txt': 'fresh' });
      await (await import('node:fs/promises')).rm(join(temp.path, 'gone.txt'));
      const after = await scanTree(temp.path);

      const delta = computeDelta(before, after);
      assert.deepEqual(delta.created, ['new.txt']);
      assert.deepEqual(delta.modified, ['b.txt']);
      assert.deepEqual(delta.deleted, ['gone.txt']);
    } finally {
      await temp.dispose();
    }
  });

  it('normalizes paths to POSIX so reports are platform independent', async () => {
    const temp = await makeTempDir();
    try {
      await writeFileTree(temp.path, { 'src/deep/a.ts': 'x' });
      const entries = await scanTree(temp.path);
      assert.equal(entries[0]?.path, 'src/deep/a.ts');
    } finally {
      await temp.dispose();
    }
  });

  it('skips excluded directories', async () => {
    const temp = await makeTempDir();
    try {
      await writeFileTree(temp.path, { 'keep/a.txt': 'x', 'node_modules/pkg/index.js': 'y' });
      const entries = await scanTree(temp.path, { exclude: (relative) => relative.startsWith('node_modules') });
      assert.deepEqual(
        entries.map((entry) => entry.path),
        ['keep/a.txt'],
      );
    } finally {
      await temp.dispose();
    }
  });

  it('counts unchanged files rather than listing them', async () => {
    const temp = await makeTempDir();
    try {
      await writeFileTree(temp.path, { 'a.txt': 'one', 'b.txt': 'two' });
      const before = await scanTree(temp.path);
      const delta = computeDelta(before, before);
      assert.equal(delta.unchangedCount, 2);
      assert.deepEqual(delta.created, []);
    } finally {
      await temp.dispose();
    }
  });

  it('treats an identical-content rewrite as unchanged', async () => {
    const temp = await makeTempDir();
    try {
      await writeFileTree(temp.path, { 'a.txt': 'one' });
      const before = await scanTree(temp.path);
      await writeFileTree(temp.path, { 'a.txt': 'one' });
      const after = await scanTree(temp.path);
      assert.deepEqual(computeDelta(before, after).modified, []);
    } finally {
      await temp.dispose();
    }
  });
});

describe('copyDirFiltered', () => {
  it('copies the workspace while honouring exclusions', async () => {
    const source = await makeTempDir();
    const destination = await makeTempDir();
    try {
      await writeFileTree(source.path, {
        'src/a.ts': 'export const a = 1;',
        'node_modules/dep/index.js': 'module.exports = 1;',
      });
      await copyDirFiltered(source.path, destination.path, {
        exclude: (relative) => relative.startsWith('node_modules'),
      });
      const copied = await scanTree(destination.path);
      assert.deepEqual(
        copied.map((entry) => entry.path),
        ['src/a.ts'],
      );
    } finally {
      await Promise.all([source.dispose(), destination.dispose()]);
    }
  });

  it('hashes identical content identically across copies', async () => {
    const source = await makeTempDir();
    const destination = await makeTempDir();
    try {
      await writeFileTree(source.path, { 'a.txt': 'same bytes' });
      await copyDirFiltered(source.path, destination.path, {});
      assert.equal(await hashFile(join(source.path, 'a.txt')), await hashFile(join(destination.path, 'a.txt')));
    } finally {
      await Promise.all([source.dispose(), destination.dispose()]);
    }
  });
});

describe('atomic writes', () => {
  it('round-trips JSON', async () => {
    const temp = await makeTempDir();
    try {
      const target = join(temp.path, 'nested', 'state.json');
      await writeJsonAtomic(target, { b: 1, a: [1, 2] });
      assert.deepEqual(await readJson<{ a: number[] }>(target), { a: [1, 2], b: 1 });
    } finally {
      await temp.dispose();
    }
  });

  it('replaces an existing file without leaving a partial one', async () => {
    const temp = await makeTempDir();
    try {
      const target = join(temp.path, 'state.json');
      await writeJsonAtomic(target, { generation: 1 });
      await writeJsonAtomic(target, { generation: 2 });
      assert.equal((await readJson<{ generation: number }>(target))?.generation, 2);
    } finally {
      await temp.dispose();
    }
  });
});

describe('exit codes', () => {
  it('uses the documented code for each outcome', () => {
    assert.equal(ExitCode.Success, 0);
    assert.equal(ExitCode.TestFailure, 1);
    assert.equal(ExitCode.ConfigError, 2);
    assert.equal(ExitCode.RuntimeError, 3);
    assert.equal(ExitCode.Timeout, 4);
    assert.equal(ExitCode.Interrupted, 130);
  });

  it('recognises only its own codes', () => {
    assert.equal(isExitCode(0), true);
    assert.equal(isExitCode(4), true);
    assert.equal(isExitCode(130), true);
    assert.equal(isExitCode(7), false);
  });

  it('documents every code it defines', () => {
    for (const value of Object.values(ExitCode)) {
      const documented = EXIT_CODE_DESCRIPTIONS.find((entry) => entry.code === value);
      assert.ok(documented, `exit code ${value} is undocumented`);
      assert.ok(documented.description.length > 0);
    }
  });

  it('has no duplicate codes in the documentation table', () => {
    const codes = EXIT_CODE_DESCRIPTIONS.map((entry) => entry.code);
    assert.equal(new Set(codes).size, codes.length);
  });
});

describe('errors', () => {
  it('carries causes, fixes and an exit code', () => {
    const error = new ConfigError('bad config', { causes: ['the reason'], fixes: ['do the thing'] });
    assert.equal(error.exitCode, 2);
    assert.equal(error.message, 'bad config');
    assert.deepEqual(error.causes, ['the reason']);
    assert.deepEqual(error.fixes, ['do the thing']);
  });

  it('identifies AgentSnap errors and leaves foreign ones alone', () => {
    assert.equal(isAgentSnapError(new ConfigError('x')), true);
    assert.equal(isAgentSnapError(new Error('x')), false);
  });
});