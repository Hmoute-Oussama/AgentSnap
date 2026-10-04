import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  assertionsByGroup,
  describeAssertion,
  getAssertionDefinition,
  listAssertionKinds,
  parseAssertions,
  validateForbiddenPolicy,
} from '../../src/assertions/definitions.js';
import { validateConfig } from '../../src/config/validate-config.js';
import { loadConfig, resolveConfigPath } from '../../src/config/index.js';
import { DEFAULT_CONFIG_FILENAME } from '../../src/config/index.js';
import { renderIssues } from '../../src/config/loader.js';
import { ConfigError } from '../../src/core/errors.js';
import { makeTempDir } from '../helpers/fixtures.js';
import type { Issue } from '../../src/utils/validate.js';

const MINIMAL = `version: 1
agent:
  provider: fake
tests:
  - name: does a thing
    prompt: Do the thing.
    assertions:
      - output_contains: done
`;

/**
 * A test entry with the one field AgentSnap insists on.
 *
 * `assertions` is mandatory by design: a test with no expectations can never fail, so
 * silently allowing one would hide a broken config behind a green run.
 */
function testCase(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { assertions: [{ max_tool_calls: 5 }], name: 'does a thing', prompt: 'Do the thing.', ...overrides };
}

/** `validateConfig` always returns a defaulted config plus every problem it found. */
function check(document: Record<string, unknown>): { issues: Issue[]; messages: string } {
  const result = validateConfig(document, { configPath: 'agentsnap.yaml', rootDir: '/repo' });
  const messages = result.issues.map((entry) => `${entry.path}: ${entry.message}`).join('\n');
  return { issues: result.issues, messages };
}

function validate(document: Record<string, unknown>) {
  return validateConfig(document, { configPath: 'agentsnap.yaml', rootDir: '/repo' });
}

describe('validateConfig', () => {
  it('accepts a minimal config with no issues', () => {
    const result = validate({ agent: { provider: 'fake' }, tests: [testCase()], version: 1 });
    assert.deepEqual(result.issues, []);
    assert.equal(result.config.tests.length, 1);
    assert.equal(result.config.agent.provider, 'fake');
  });

  it('rejects a non-1 version', () => {
    assert.match(check({ agent: { provider: 'fake' }, tests: [], version: 2 }).messages, /version/i);
  });

  it('rejects an unknown provider and hints at the known ones', () => {
    const { issues } = check({ agent: { provider: 'gpt' }, tests: [], version: 1 });
    assert.ok(issues.length > 0);
    assert.ok(issues.some((entry) => /claude-code|fake/.test(`${entry.message} ${entry.hint ?? ''}`)));
  });

  it('rejects duplicate test names', () => {
    const { messages } = check({
      agent: { provider: 'fake' },
      tests: [
        testCase({ name: 'same' }),
        testCase({ name: 'same' }),
      ],
      version: 1,
    });
    assert.match(messages, /duplicate/i);
  });

  it('rejects a test with no prompt', () => {
    assert.ok(check({ agent: { provider: 'fake' }, tests: [testCase({ name: 'x', prompt: undefined })], version: 1 }).issues.length > 0);
  });

  it('points at the exact path of the offending value', () => {
    const { issues } = check({
      agent: { provider: 'fake' },
      tests: [testCase({ assertions: [{ file_created: 5 }] })],
      version: 1,
    });
    assert.ok(issues.length > 0);
    assert.ok(issues.every((entry) => entry.path.startsWith('tests[0]')));
  });

  it('rejects unknown top-level keys', () => {
    assert.match(check({ agent: { provider: 'fake' }, tests: [], typoed: true, version: 1 }).messages, /typoed/);
  });

  it('rejects unknown keys inside a test', () => {
    assert.match(
      check({ agent: { provider: 'fake' }, tests: [testCase({ retrys: 2 })], version: 1 }).messages,
      /retrys/,
    );
  });

  it('rejects negative timeouts and negative retries', () => {
    const { messages } = check({
      agent: { provider: 'fake' },
      tests: [testCase({ retries: -1, timeout: { total: -5 } })],
      version: 1,
    });
    assert.match(messages, /retries/);
    assert.match(messages, /total/);
  });

  it('applies defaults to omitted fields', () => {
    const config = validate({ agent: { provider: 'fake' }, tests: [testCase()], version: 1 }).config;
    const test = config.tests[0];
    assert.equal(test?.snapshot.compare, 'loose');
    assert.equal(test?.snapshot.update, 'auto');
    assert.equal(test?.snapshot.variant, 'default');
    assert.deepEqual(test?.tags, []);
    assert.equal(test?.retries, 0);
    assert.equal(config.security.network, 'forbid');
    assert.equal(config.sandbox.type, 'local');
  });

  it('honours an explicit snapshot compare mode', () => {
    const config = validate({ agent: { provider: 'fake' }, tests: [testCase({ snapshot: { compare: 'strict' } })], version: 1 }).config;
    assert.equal(config.tests[0]?.snapshot.compare, 'strict');
  });

  it('rejects an unknown snapshot compare mode', () => {
    const { messages } = check({
      agent: { provider: 'fake' },
      tests: [testCase({ snapshot: { compare: 'sideways' } })],
      version: 1,
    });
    assert.match(messages, /compare/);
  });

  it('inherits a global snapshot default when the test omits it', () => {
    const config = validate({
      agent: { provider: 'fake' },
      snapshot: { compare: 'off' },
      tests: [testCase()],
      version: 1,
    }).config;
    assert.equal(config.tests[0]?.snapshot.compare, 'off');
  });

  it('lets a test override the global snapshot update policy', () => {
    const config = validate({
      agent: { provider: 'fake' },
      snapshot: { update: 'never' },
      tests: [testCase({ snapshot: { update: 'auto' } })],
      version: 1,
    }).config;
    assert.equal(config.tests[0]?.snapshot.update, 'auto');
  });

  it('collects every problem instead of stopping at the first', () => {
    const { issues } = check({
      agent: { provider: 'nope' },
      tests: [testCase({ retrys: 'many' })],
      version: 9,
    });
    assert.ok(issues.length >= 3, `expected several issues, got ${issues.length}`);
  });

  it('renders issues as human-readable lines', () => {
    const lines = renderIssues([{ message: 'broken', path: 'tests[0].prompt' }]);
    assert.equal(lines.length, 1);
    assert.match(lines[0] as string, /tests\[0\]\.prompt/);
    assert.match(lines[0] as string, /broken/);
  });
});

describe('validateForbiddenPolicy', () => {
  it('accepts a well-formed policy', () => {
    assert.deepEqual(validateForbiddenPolicy({ execute: ['rm -rf *'], read: ['.env'], write: ['**/*.pem'] }, 'x'), []);
  });

  it('rejects a non-array matcher list only when it is not a single string', () => {
    assert.deepEqual(validateForbiddenPolicy({ read: '.env' }, 'x'), []);
    assert.ok(validateForbiddenPolicy({ read: 42 }, 'x').length > 0);
  });

  it('names the allowed keys when a field is unknown', () => {
    const issues = validateForbiddenPolicy({ paths: ['.env'] }, 'x');
    assert.match(issues[0]?.message ?? '', /unknown option `paths`/);
    assert.match(issues[0]?.hint ?? '', /read/);
  });

  it('rejects a non-object policy', () => {
    assert.ok(validateForbiddenPolicy('nope', 'x').length > 0);
  });
});

describe('assertion definitions', () => {
  it('exposes every kind grouped for documentation', () => {
    const flattened = assertionsByGroup().flatMap((group) => group.kinds);
    assert.ok(flattened.length > 0);
    assert.deepEqual([...flattened].sort(), [...listAssertionKinds()].sort());
  });

  it('defines the core assertion kinds', () => {
    for (const kind of [
      'command_executed',
      'command_must_pass',
      'command_not_executed',
      'file_changed',
      'file_created',
      'file_read',
      'max_steps',
      'max_tool_calls',
      'network_access_forbidden',
      'output_contains',
      'output_matches',
      'tool_not_used',
      'tool_used',
    ]) {
      assert.ok(getAssertionDefinition(kind), `missing definition: ${kind}`);
    }
  });

  it('returns undefined for an unknown kind', () => {
    assert.equal(getAssertionDefinition('does_not_exist'), undefined);
  });

  it('describes a value for failure messages', () => {
    assert.match(describeAssertion('file_created', 'src/a.ts'), /src\/a\.ts/);
    assert.match(describeAssertion('output_matches', '^ok$'), /\^ok\$/);
  });
});

describe('parseAssertions', () => {
  it('rejects a mapping instead of a list', () => {
    const parsed = parseAssertions({ file_created: 'a.md' }, 'p');
    assert.equal(parsed.assertions.length, 0);
    assert.match(parsed.issues[0]?.message ?? '', /expected a list/);
  });

  it('parses the list form', () => {
    const parsed = parseAssertions([{ output_contains: 'hello' }, { file_created: 'a.md' }], 'p');
    assert.deepEqual(parsed.issues, []);
    assert.equal(parsed.assertions.length, 2);
  });

  it('rejects a list entry with two assertion names', () => {
    const parsed = parseAssertions([{ output_contains: 'a', output_matches: 'b' }], 'p');
    assert.equal(parsed.assertions.length, 0);
    assert.ok(parsed.issues.length > 0);
  });

  it('reports a malformed entry as an issue instead of throwing', () => {
    const parsed = parseAssertions([{ bogus_kind: 1 }], 'p');
    assert.equal(parsed.assertions.length, 0);
    assert.ok(parsed.issues.length > 0);
  });

  it('flags an unknown assertion kind', () => {
    assert.ok(parseAssertions([{ no_such_assertion: 1 }], 'p').issues.length > 0);
  });

  it('rejects a value that is neither a list nor an object', () => {
    assert.ok(parseAssertions('nope', 'p').issues.length > 0);
  });
});

describe('loadConfig and discovery', () => {
  it('finds the default file name when walking up from a directory', async () => {
    const temp = await makeTempDir();
    try {
      await writeFile(join(temp.path, DEFAULT_CONFIG_FILENAME), MINIMAL, 'utf8');
      assert.equal(await resolveConfigPath(temp.path), join(temp.path, DEFAULT_CONFIG_FILENAME));
    } finally {
      await temp.dispose();
    }
  });

  it('returns null when no config exists anywhere up the tree', async () => {
    const temp = await makeTempDir();
    try {
      assert.equal(await resolveConfigPath(join(temp.path, 'nested')), null);
    } finally {
      await temp.dispose();
    }
  });

  it('applies defaults from the config to each test', async () => {
    const temp = await makeTempDir();
    try {
      const path = join(temp.path, DEFAULT_CONFIG_FILENAME);
      await writeFile(path, MINIMAL.replace('tests:', 'defaults:\n  retries: 2\n  maxToolCalls: 7\ntests:'), 'utf8');
      const config = await loadConfig({ configPath: path, cwd: temp.path });
      assert.equal(config.tests[0]?.retries, 2);
      assert.equal(config.tests[0]?.maxToolCalls, 7);
    } finally {
      await temp.dispose();
    }
  });

  it('throws a ConfigError on a YAML syntax error', async () => {
    const temp = await makeTempDir();
    try {
      const path = join(temp.path, DEFAULT_CONFIG_FILENAME);
      await writeFile(path, 'version: 1\nagent: [unclosed\n', 'utf8');
      await assert.rejects(() => loadConfig({ configPath: path, cwd: temp.path }));
    } finally {
      await temp.dispose();
    }
  });

  it('throws a ConfigError listing invalid values', async () => {
    const temp = await makeTempDir();
    try {
      const path = join(temp.path, DEFAULT_CONFIG_FILENAME);
      await writeFile(path, 'version: 3\nagent:\n  provider: nope\n', 'utf8');
      await assert.rejects(
        () => loadConfig({ configPath: path, cwd: temp.path }),
        (error: unknown) => {
          assert.ok(error instanceof ConfigError);
          assert.match(`${error.message}\n${(error.causes ?? []).join('\n')}`, /version|provider/i);
          return true;
        },
      );
    } finally {
      await temp.dispose();
    }
  });

  it('resolves the config path from the working directory when omitted', async () => {
    const temp = await makeTempDir();
    try {
      await writeFile(join(temp.path, DEFAULT_CONFIG_FILENAME), MINIMAL, 'utf8');
      const config = await loadConfig({ cwd: temp.path });
      assert.equal(config.agent.provider, 'fake');
      assert.equal(config.tests.length, 1);
    } finally {
      await temp.dispose();
    }
  });
});