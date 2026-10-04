import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createRedactor, REDACTION_PLACEHOLDER, secretEnvNames } from '../../src/utils/redact.js';
import {
  BASE_ENV_ALLOWLIST,
  buildChildEnv,
  DEFAULT_DENY_LIST,
  expandEnvValue,
} from '../../src/sandbox/env.js';
import { CommandSyntaxError, tokenizeCommand } from '../../src/sandbox/exec.js';
import { assertSafeExecutableName, isInside, relativePosix, resolveWithin, toPosixPath } from '../../src/utils/paths.js';

describe('createRedactor', () => {
  it('masks a value whose variable name says it is a secret', () => {
    const redactor = createRedactor({ MY_API_KEY: 'sk-live-abcdef012345' });
    assert.equal(redactor.text('token is sk-live-abcdef012345'), `token is ${REDACTION_PLACEHOLDER}`);
  });

  it('masks credential-shaped values regardless of variable name', () => {
    const redactor = createRedactor({ SOMETHING: 'ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ012345' });
    assert.equal(redactor.text('saw ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ012345'), `saw ${REDACTION_PLACEHOLDER}`);
  });

  it('does not mask locations, which would corrupt every path it prints', () => {
    const temp = 'C:\\Users\\Someone\\AppData\\Local\\Temp';
    const redactor = createRedactor({ PATH: temp, TEMP: temp, USERPROFILE: temp });
    assert.equal(redactor.text(`workspace ${temp}`), `workspace ${temp}`);
  });

  it('masks an assignment written into text', () => {
    const redactor = createRedactor({});
    assert.match(redactor.text('ANTHROPIC_API_KEY=abcd1234efgh'), /ANTHROPIC_API_KEY=/);
    assert.doesNotMatch(redactor.text('ANTHROPIC_API_KEY=abcd1234efgh'), /abcd1234efgh/);
  });

  it('masks explicit extra secrets', () => {
    const redactor = createRedactor({}, ['hunter2-hunter2']);
    assert.equal(redactor.text('pw=hunter2-hunter2'), `pw=${REDACTION_PLACEHOLDER}`);
  });

  it('masks secrets recursively inside objects and arrays', () => {
    const redactor = createRedactor({ API_TOKEN: 'abcd1234efgh' });
    const masked = redactor.value({ nested: { list: ['abcd1234efgh', 'safe'] }, top: 'abcd1234efgh' }) as {
      nested: { list: string[] };
      top: string;
    };
    assert.equal(masked.top, REDACTION_PLACEHOLDER);
    assert.equal(masked.nested.list[0], REDACTION_PLACEHOLDER);
    assert.equal(masked.nested.list[1], 'safe');
  });

  it('ignores very short values so ordinary words are not mangled', () => {
    const redactor = createRedactor({ SOME_KEY: 'abc' });
    assert.equal(redactor.text('abc'), 'abc');
  });

  it('is safe on non-string and deeply nested input', () => {
    const redactor = createRedactor({});
    assert.equal(redactor.text(''), '');
    assert.equal(redactor.value(42), 42);
    assert.equal(redactor.value(null), null);
  });

  it('lists secret-looking variable names without their values', () => {
    const names = secretEnvNames({ API_KEY: 'x', AUTH_TOKEN: 'y', PATH: 'z', MY_PASSWORD: 'p' });
    assert.deepEqual(names, ['API_KEY', 'AUTH_TOKEN', 'MY_PASSWORD']);
  });
});

describe('buildChildEnv', () => {
  const host = {
    HOME: '/home/me',
    MY_API_KEY: 'secret-value',
    NODE_ENV: 'production',
    PATH: '/usr/bin',
    TEMP: '/tmp',
  };

  it('forwards only the base allow-list plus configured extras', () => {
    const env = buildChildEnv({ base: BASE_ENV_ALLOWLIST, deny: [], inherit: ['MY_API_KEY'], overrides: {} }, host);
    assert.equal(env['MY_API_KEY'], 'secret-value');
    assert.equal(env['HOME'], '/home/me');
    // NODE_ENV is not on the allow-list: an unlisted host variable is never forwarded.
    assert.equal(env['NODE_ENV'], undefined);
  });

  it('drops host variables that are not allow-listed', () => {
    const env = buildChildEnv({ base: [], deny: [], inherit: [], overrides: {} }, host);
    assert.equal(env['PATH'], undefined);
    assert.equal(env['MY_API_KEY'], undefined);
  });

  it('applies overrides and expands $VAR references', () => {
    const env = buildChildEnv(
      { base: [], deny: [], inherit: [], overrides: { API_URL: 'https://x/$NODE_ENV', PLAIN: 'v1' } },
      host,
    );
    assert.equal(env['API_URL'], 'https://x/production');
    assert.equal(env['PLAIN'], 'v1');
  });

  it('never forwards a denied variable, even when inherited', () => {
    const env = buildChildEnv(
      { base: [], deny: ['MY_API_KEY'], inherit: ['MY_API_KEY'], overrides: {} },
      host,
    );
    assert.equal(env['MY_API_KEY'], undefined);
  });

  it('ships a deny list that covers the usual credential variables', () => {
    for (const name of ['GITHUB_TOKEN', 'NPM_TOKEN', 'SSH_AUTH_SOCK']) {
      assert.ok(DEFAULT_DENY_LIST.includes(name), `expecting ${name} on the deny list`);
    }
  });

  it('expands an unset variable to an empty string rather than the literal name', () => {
    assert.equal(expandEnvValue('$NOT_SET_ANYWHERE/x', {}), '/x');
    assert.equal(expandEnvValue('${NOT_SET_ANYWHERE}', {}), '');
    assert.equal(expandEnvValue('no dollars', {}), 'no dollars');
  });
});

describe('tokenizeCommand', () => {
  it('splits plain arguments', () => {
    assert.deepEqual(tokenizeCommand('npm run build'), ['npm', 'run', 'build']);
  });

  it('keeps quoted arguments together', () => {
    assert.deepEqual(tokenizeCommand('grep -n "foo bar" src'), ['grep', '-n', 'foo bar', 'src']);
    assert.deepEqual(tokenizeCommand("grep -n 'foo bar' src"), ['grep', '-n', 'foo bar', 'src']);
  });

  it('honours backslash escapes', () => {
    assert.deepEqual(tokenizeCommand('echo a\\ b'), ['echo', 'a b']);
  });

  it('refuses shell features instead of silently ignoring them', () => {
    for (const command of ['cat a | grep b', 'echo $HOME', 'a && b', 'a > out.txt', 'a; b', '`whoami`']) {
      assert.throws(() => tokenizeCommand(command), CommandSyntaxError, `expected rejection: ${command}`);
    }
  });

  it('explains why the command was rejected and what to do instead', () => {
    let thrown: unknown;
    try {
      tokenizeCommand('a | b');
    } catch (error) {
      thrown = error;
    }
    assert.ok(thrown instanceof CommandSyntaxError);
    assert.match(thrown.message, /needs a shell/);
    assert.match((thrown.causes ?? []).join(' '), /never runs commands through a shell/);
    assert.ok((thrown.fixes ?? []).length > 0);
  });

  it('rejects an empty command', () => {
    assert.throws(() => tokenizeCommand('   '), /is empty/);
  });

  it('rejects an unbalanced quote', () => {
    assert.throws(() => tokenizeCommand('echo "unclosed'), CommandSyntaxError);
  });
});

describe('path safety', () => {
  it('normalizes separators to POSIX', () => {
    assert.equal(toPosixPath('src\\a\\b.ts'), 'src/a/b.ts');
  });

  it('resolves a relative path inside the root', () => {
    assert.match(resolveWithin('/repo', 'src/a.ts').replace(/\\/g, '/'), /\/repo\/src\/a\.ts$/);
  });

  it('refuses to escape the root', () => {
    assert.throws(() => resolveWithin('/repo', '../etc/passwd'));
    assert.throws(() => resolveWithin('/repo', '/etc/passwd'));
    assert.throws(() => resolveWithin('/repo', 'a/../../b'));
  });

  it('detects containment', () => {
    assert.equal(isInside('/repo', '/repo/src/a.ts'), true);
    assert.equal(isInside('/repo', '/repo'), true);
    assert.equal(isInside('/repo', '/repository/src/a.ts'), false);
  });

  it('produces a POSIX relative path or null when outside', () => {
    assert.equal(relativePosix('/repo', '/repo/src/a.ts')?.replace(/\\/g, '/'), 'src/a.ts');
    assert.equal(relativePosix('/repo', '/other/a.ts'), null);
  });

  it('rejects an executable name that could smuggle arguments', () => {
    assert.throws(() => assertSafeExecutableName('claude; rm -rf /'));
    assert.throws(() => assertSafeExecutableName('claude && evil'));
    assert.throws(() => assertSafeExecutableName(''));
    assert.doesNotThrow(() => assertSafeExecutableName('claude'));
    assert.doesNotThrow(() => assertSafeExecutableName('C:\\tools\\claude.exe'));
  });
});