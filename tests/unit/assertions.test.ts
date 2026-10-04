import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { evaluateAssertions, resolveToolName, type EvaluateOptions } from '../../src/assertions/evaluate.js';
import type { AssertionContext } from '../../src/assertions/definitions.js';
import type { ParsedAssertion } from '../../src/assertions/definitions.js';
import { ALL_TESTS, createTestFilter } from '../../src/runner/filter.js';
import { makeTest } from '../helpers/fixtures.js';

function context(overrides: Partial<AssertionContext> = {}): AssertionContext {
  return {
    commands: [],
    filesChanged: [],
    filesCreated: [],
    filesDeleted: [],
    filesRead: [],
    filesWritten: [],
    forbidden: { execute: [], read: [], write: [] },
    networkAttempts: [],
    output: '',
    permissionRequests: [],
    runCommand: async () => ({ exitCode: 0, output: '', timedOut: false }),
    sandbox: {
      filesystemIsolation: 'copy',
      kind: 'local',
      networkBlocked: false,
      processIsolation: 'none',
      resourceLimits: false,
    },
    steps: 1,
    toolCallCounts: {},
    toolCalls: 0,
    ...overrides,
  };
}

async function evaluate(
  specs: Array<[string, unknown]>,
  ctx: AssertionContext = context(),
  options: EvaluateOptions = {},
) {
  const assertions: ParsedAssertion[] = specs.map(([kind, spec], index) => ({ index, kind, spec }));
  return evaluateAssertions(assertions, ctx, options);
}

describe('evaluateAssertions: files', () => {
  it('passes when a created file matches', async () => {
    const [result] = await evaluate([['file_created', 'docs/report.md']], context({ filesCreated: ['docs/report.md'] }));
    assert.equal(result?.status, 'passed');
    assert.equal(result?.index, 0);
    assert.match(result?.expectation ?? '', /docs\/report\.md/);
  });

  it('fails and names the missing file', async () => {
    const [result] = await evaluate([['file_created', 'docs/report.md']], context());
    assert.equal(result?.status, 'failed');
    assert.match(result?.expectation ?? '', /docs\/report\.md/);
  });

  it('accepts a glob', async () => {
    const [result] = await evaluate([['file_created', 'docs/**/*.md']], context({ filesCreated: ['docs/a/b.md'] }));
    assert.equal(result?.status, 'passed');
  });

  it('matches a deleted file for file_deleted', async () => {
    const [ok] = await evaluate([['file_deleted', 'old.md']], context({ filesDeleted: ['old.md'] }));
    const [bad] = await evaluate([['file_deleted', 'old.md']], context({ filesCreated: ['old.md'] }));
    assert.equal(ok?.status, 'passed');
    assert.equal(bad?.status, 'failed');
  });

  it('inverts for file_not_changed', async () => {
    const [ok] = await evaluate([['file_not_changed', 'src/**']], context());
    const [bad] = await evaluate([['file_not_changed', 'src/**']], context({ filesChanged: ['src/a.ts'] }));
    assert.equal(ok?.status, 'passed');
    assert.equal(bad?.status, 'failed');
  });

  it('accepts a matcher mapping as well as a bare string', async () => {
    const [stringSpec] = await evaluate([['file_changed', 'docs/*.md']], context({ filesChanged: ['docs/a.md'] }));
    const [mapping] = await evaluate(
      [['file_changed', { pattern: 'docs/*.md' }]],
      context({ filesChanged: ['docs/a.md'] }),
    );
    assert.equal(stringSpec?.status, 'passed');
    assert.equal(mapping?.status, 'passed');
  });

  it('supports a regular-expression matcher', async () => {
    const [result] = await evaluate(
      [['file_changed', { pattern: '^src/.*\\.ts$', regex: true }]],
      context({ filesChanged: ['src/a.ts'] }),
    );
    assert.equal(result?.status, 'passed');
  });
});

describe('evaluateAssertions: commands', () => {
  /** `command_must_pass` runs in the post-agent workspace, not in the agent's own history. */
  it('passes when the post-agent command exits 0', async () => {
    const [result] = await evaluate(
      [['command_must_pass', 'npm test']],
      context({ runCommand: async () => ({ exitCode: 0, output: 'ok', timedOut: false }) }),
    );
    assert.equal(result?.status, 'passed');
  });

  it('fails when the post-agent command exits non-zero', async () => {
    const [result] = await evaluate(
      [['command_must_pass', 'npm test']],
      context({ runCommand: async () => ({ exitCode: 1, output: '1 failing', timedOut: false }) }),
    );
    assert.equal(result?.status, 'failed');
    assert.match(result?.observed ?? '', /1 failing/);
  });

  it('fails when the post-agent command times out', async () => {
    const [result] = await evaluate(
      [['command_must_pass', { command: 'npm test', timeout: 5 }]],
      context({ runCommand: async () => ({ exitCode: null, output: '', timedOut: true }) }),
    );
    assert.equal(result?.status, 'failed');
  });

  it('does not confuse the agent command history with the post-agent run', async () => {
    // The agent ran a failing command; `command_must_pass` still passes when the post-agent
    // run is green, because it describes the project's state, not the agent's.
    const [result] = await evaluate(
      [['command_must_pass', 'npm test']],
      context({
        commands: [{ command: 'npm test', exitCode: 1, timedOut: false }],
        runCommand: async () => ({ exitCode: 0, output: '', timedOut: false }),
      }),
    );
    assert.equal(result?.status, 'passed');
  });

  it('runs the project test command for tests_must_pass', async () => {
    const seen: string[] = [];
    const ctx = context({
      runCommand: async (command) => {
        seen.push(command);
        return { exitCode: 0, output: '', timedOut: false };
      },
    });
    const [result] = await evaluate([['tests_must_pass', true]], ctx, { defaultTestCommand: 'npm test' });
    assert.equal(result?.status, 'passed');
    assert.deepEqual(seen, ['npm test']);
  });

  it('skips tests_must_pass when no test command can be resolved', async () => {
    const [result] = await evaluate([['tests_must_pass', true]], context());
    assert.equal(result?.status, 'skipped');
    assert.match(result?.skipReason ?? '', /test command/i);
  });

  it('records that the agent ran a command', async () => {
    const [ok] = await evaluate(
      [['command_executed', 'npm run build']],
      context({ commands: [{ command: 'npm run build', exitCode: 0, timedOut: false }] }),
    );
    const [bad] = await evaluate(
      [['command_executed', 'npm run build']],
      context({ commands: [{ command: 'npm test', exitCode: 0, timedOut: false }] }),
    );
    assert.equal(ok?.status, 'passed');
    assert.equal(bad?.status, 'failed');
  });

  it('requires a successful exit for command_matches', async () => {
    const [ok] = await evaluate(
      [['command_matches', 'npm run build']],
      context({ commands: [{ command: 'npm run build', exitCode: 0, timedOut: false }] }),
    );
    const [failed] = await evaluate(
      [['command_matches', 'npm run build']],
      context({ commands: [{ command: 'npm run build', exitCode: 2, timedOut: false }] }),
    );
    const [neverRan] = await evaluate([['command_matches', 'npm run build']], context());
    assert.equal(ok?.status, 'passed');
    assert.equal(failed?.status, 'failed');
    assert.equal(neverRan?.status, 'failed');
  });

  it('treats a timed-out agent command as not passing', async () => {
    const [result] = await evaluate(
      [['command_matches', 'npm test']],
      context({ commands: [{ command: 'npm test', exitCode: null, timedOut: true }] }),
    );
    assert.equal(result?.status, 'failed');
  });

  it('supports command_not_executed', async () => {
    const [ok] = await evaluate(
      [['command_not_executed', 'git push']],
      context({ commands: [{ command: 'npm test', exitCode: 0, timedOut: false }] }),
    );
    const [bad] = await evaluate(
      [['command_not_executed', 'git push*']],
      context({ commands: [{ command: 'git push --force', exitCode: 0, timedOut: false }] }),
    );
    assert.equal(ok?.status, 'passed');
    assert.equal(bad?.status, 'failed');
  });
});

describe('evaluateAssertions: behavior and output', () => {
  it('bounds tool calls', async () => {
    const [ok] = await evaluate([['max_tool_calls', 5]], context({ toolCalls: 5 }));
    const [bad] = await evaluate([['max_tool_calls', 5]], context({ toolCalls: 6 }));
    assert.equal(ok?.status, 'passed');
    assert.equal(bad?.status, 'failed');
  });

  it('bounds steps', async () => {
    const [result] = await evaluate([['max_steps', 2]], context({ steps: 3 }));
    assert.equal(result?.status, 'failed');
  });

  it('counts a specific tool by name', async () => {
    const [result] = await evaluate(
      [['max_tool_calls', { Read: 2 }]],
      context({ toolCallCounts: { Read: 3, Write: 1 } }),
    );
    assert.equal(result?.status, 'failed');
  });

  it('checks output substrings and regular expressions', async () => {
    const ctx = context({ output: 'All 42 tests passed.' });
    const [contains] = await evaluate([['output_contains', 'passed']], ctx);
    const [missing] = await evaluate([['output_not_contains', 'failed']], ctx);
    const [matches] = await evaluate([['output_matches', '\\d+ tests passed']], ctx);
    const [noMatch] = await evaluate([['output_matches', '^FAILED']], ctx);
    assert.equal(contains?.status, 'passed');
    assert.equal(missing?.status, 'passed');
    assert.equal(matches?.status, 'passed');
    assert.equal(noMatch?.status, 'failed');
  });

  it('truncates a very long output in the observed field', async () => {
    const [result] = await evaluate([['output_contains', 'nope']], context({ output: 'x'.repeat(5000) }));
    assert.equal(result?.status, 'failed');
    assert.ok((result?.observed?.length ?? 0) < 1000);
  });

  it('checks tool usage by name', async () => {
    const [ok] = await evaluate([['tool_used', 'Write']], context({ toolCallCounts: { Write: 1 } }));
    const [bad] = await evaluate([['tool_not_used', 'Bash']], context({ toolCallCounts: { Write: 1 } }));
    assert.equal(ok?.status, 'passed');
    assert.equal(bad?.status, 'passed');
  });

  it('resolves a loose tool reference to the only candidate', () => {
    assert.equal(resolveToolName({ Read: 1 }, 'Read'), 'Read');
  });
});

describe('evaluateAssertions: security', () => {
  const enforcing = {
    filesystemIsolation: 'copy' as const,
    kind: 'docker' as const,
    networkBlocked: true,
    processIsolation: 'container' as const,
    resourceLimits: true,
  };

  it('flags a network attempt under a sandbox that can block egress', async () => {
    const [result] = await evaluate(
      [['network_access_forbidden', true]],
      context({ networkAttempts: ['https://evil.example.com'], sandbox: enforcing }),
    );
    assert.equal(result?.status, 'failed');
    assert.match(result?.observed ?? '', /evil\.example\.com/);
  });

  it('passes when an enforcing sandbox saw no network access', async () => {
    const [result] = await evaluate([['network_access_forbidden', true]], context({ sandbox: enforcing }));
    assert.equal(result?.status, 'passed');
  });

  it('reports skipped rather than passed when the sandbox cannot enforce it', async () => {
    // Claiming "no network access" from a sandbox that never blocked anything would be a lie
    // that hides a real security regression.
    const [result] = await evaluate(
      [['network_access_forbidden', true]],
      context({ networkAttempts: [], sandbox: { ...enforcing, networkBlocked: false } }),
    );
    assert.equal(result?.status, 'skipped');
    assert.match(result?.skipReason ?? '', /docker|network/i);
  });

  it('flags a forbidden read', async () => {
    const [result] = await evaluate(
      [['must_not_read', '**/.env']],
      context({ filesRead: ['.env'] }),
    );
    assert.equal(result?.status, 'failed');
    assert.match(result?.observed ?? '', /\.env/);
  });

  it('flags a forbidden write', async () => {
    const [result] = await evaluate(
      [['must_not_write', 'dist/**']],
      context({ filesWritten: ['dist/bundle.js'] }),
    );
    assert.equal(result?.status, 'failed');
  });

  it('passes when nothing forbidden was touched', async () => {
    const [read] = await evaluate([['must_not_read', '**/.env']], context({ filesRead: ['src/a.ts'] }));
    const [write] = await evaluate([['must_not_write', 'dist/**']], context({ filesWritten: ['src/a.ts'] }));
    assert.equal(read?.status, 'passed');
    assert.equal(write?.status, 'passed');
  });

  it('flags a forbidden command', async () => {
    const [result] = await evaluate(
      [['must_not_execute', 'git push*']],
      context({ commands: [{ command: 'git push origin main', exitCode: 0, timedOut: false }] }),
    );
    assert.equal(result?.status, 'failed');
  });

  it('records a denied permission request', async () => {
    const [result] = await evaluate(
      [['must_ask_confirmation', 'Bash']],
      context({ permissionRequests: [{ decision: 'denied', tool: 'Bash' }] }),
    );
    assert.equal(result?.status, 'passed');
  });

  it('flags an approval that was granted when none should be', async () => {
    const [result] = await evaluate(
      [['must_not_ask_confirmation', 'Bash']],
      context({ permissionRequests: [{ decision: 'granted', tool: 'Bash' }] }),
    );
    assert.equal(result?.status, 'failed');
  });
});
describe('evaluateAssertions: determinism and ordering', () => {
  it('keeps results in assertion order', async () => {
    const results = await evaluate(
      [
        ['max_tool_calls', 1],
        ['output_contains', 'hello'],
        ['max_steps', 1],
      ],
      context({ output: 'hello', steps: 1, toolCalls: 1 }),
    );
    assert.deepEqual(
      results.map((result) => result.index),
      [0, 1, 2],
    );
  });

  it('returns an empty list for no assertions', async () => {
    assert.deepEqual(await evaluate([]), []);
  });

  it('reports an unknown kind instead of throwing', async () => {
    const results = await evaluate([['not_a_real_assertion', 1]]);
    assert.equal(results.length, 1);
    assert.notEqual(results[0]?.status, 'passed');
  });

  it('is pure: evaluating twice gives identical results', async () => {
    const ctx = context({ filesCreated: ['a.md'], output: 'done' });
    const first = await evaluate([['file_created', 'a.md'], ['output_contains', 'done']], ctx);
    const second = await evaluate([['file_created', 'a.md'], ['output_contains', 'done']], ctx);
    assert.deepEqual(first, second);
  });
});

describe('createTestFilter', () => {
  const web = makeTest({ name: 'web: renders', tags: ['smoke', 'web'] });
  const api = makeTest({ name: 'api: responds', tags: ['web'] });
  const db = makeTest({ name: 'db: migrates', tags: ['slow'] });

  it('matches everything when no filter is given', () => {
    assert.equal(createTestFilter({}).matches(web), true);
    assert.equal(ALL_TESTS.matches(db), true);
  });

  it('matches names as globs', () => {
    const filter = createTestFilter({ name: 'web:*' });
    assert.equal(filter.matches(web), true);
    assert.equal(filter.matches(api), false);
  });

  it('treats a bare name as an exact match, not a prefix', () => {
    const filter = createTestFilter({ name: 'api: responds' });
    assert.equal(filter.matches(api), true);
    assert.equal(filter.matches(web), false);
  });

  it('unions tags', () => {
    const filter = createTestFilter({ tags: ['smoke', 'slow'] });
    assert.equal(filter.matches(web), true);
    assert.equal(filter.matches(db), true);
    assert.equal(filter.matches(api), false);
  });

  it('intersects name and tag filters', () => {
    const filter = createTestFilter({ name: 'web:*', tags: ['smoke'] });
    assert.equal(filter.matches(web), true);
    assert.equal(filter.matches(api), false);
  });

  it('applies exclude after includes', () => {
    const filter = createTestFilter({ name: '*', exclude: '*:* migrates' });
    assert.equal(filter.matches(web), true);
    assert.equal(filter.matches(db), false);
  });

  it('excludes by tag too', () => {
    const filter = createTestFilter({ tags: ['web'], exclude: '*slow*' });
    assert.equal(filter.matches(api), true);
    assert.equal(filter.matches(db), false);
  });

  it('describes the active filters for diagnostics', () => {
    const filter = createTestFilter({ exclude: 'db:*', name: 'web:*', tags: ['smoke'] });
    assert.deepEqual(filter.describe(), { exclude: 'db:*', name: 'web:*', tags: ['smoke'] });
  });
});