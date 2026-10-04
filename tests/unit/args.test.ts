import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { parseArgs, peekFlags, readFlags } from '../../src/cli/args.js';
import { UsageError } from '../../src/core/errors.js';

describe('parseArgs', () => {
  it('reads the command and positionals', () => {
    const parsed = parseArgs(['run', 'web/*', 'extra']);
    assert.equal(parsed.command, 'run');
    assert.deepEqual(parsed.positionals, ['web/*', 'extra']);
  });

  it('records bare flags as true and --no-x as false', () => {
    const parsed = parseArgs(['run', '--bail', '--no-color']);
    assert.equal(peekFlags(parsed).bool('bail'), true);
    assert.equal(peekFlags(parsed).bool('color'), false);
  });

  it('consumes the next token for known value flags', () => {
    const parsed = parseArgs(['run', '--provider', 'claude-code', '--config', 'a.yaml']);
    const flags = peekFlags(parsed);
    assert.equal(flags.string('provider'), 'claude-code');
    assert.equal(flags.string('config'), 'a.yaml');
    assert.deepEqual(parsed.positionals, []);
  });

  it('supports --key=value', () => {
    const flags = peekFlags(parseArgs(['run', '--reporter=json']));
    assert.equal(flags.string('reporter'), 'json');
  });

  it('reads every value-taking run flag without swallowing the next token', () => {
    const parsed = parseArgs([
      'run',
      '--snapshot-mode',
      'strict',
      '--output',
      'out.json',
      '--timeout',
      '30',
    ]);
    const flags = peekFlags(parsed);
    assert.equal(flags.string('snapshot-mode'), 'strict');
    assert.equal(flags.string('output'), 'out.json');
    assert.equal(flags.number('timeout'), 30);
    // A value flag must never be parsed as a boolean plus a stray positional.
    assert.deepEqual(parsed.positionals, []);
  });

  it('collects repeatable flags into a list', () => {
    const flags = peekFlags(parseArgs(['run', '--tag', 'a', '--tag', 'b']));
    assert.deepEqual(flags.list('tag'), ['a', 'b']);
  });

  it('maps short value flags to their long names', () => {
    const parsed = parseArgs(['run', '-t', 'smoke', '-r', 'json']);
    const flags = peekFlags(parsed);
    assert.deepEqual(flags.list('tag'), ['smoke']);
    assert.equal(flags.string('reporter'), 'json');
  });

  it('treats everything after -- as positional', () => {
    const parsed = parseArgs(['run', '--', '--not-a-flag']);
    assert.deepEqual(parsed.positionals, ['--not-a-flag']);
  });

  it('throws a UsageError-shaped error when a value flag is last', () => {
    assert.throws(() => parseArgs(['run', '--provider']), /needs a value/);
  });
});

describe('readFlags', () => {
  it('rejects options the command does not accept', () => {
    assert.throws(() => readFlags(parseArgs(['run', '--provider', 'x']), ['bail']), /Unknown option/);
  });

  it('suggests the closest known option as a fix', () => {
    let thrown: unknown;
    try {
      readFlags(parseArgs(['run', '--repoter', 'json']), ['reporter', 'bail']);
    } catch (error) {
      thrown = error;
    }
    assert.ok(thrown instanceof UsageError);
    assert.match(thrown.message, /Unknown option `--repoter`/);
    assert.deepEqual(thrown.fixes, ['Did you mean `--reporter`?']);
  });

  it('lists known options when nothing is close', () => {
    assert.throws(
      () => readFlags(parseArgs(['run', '--zzzzzzzzzz']), ['reporter', 'bail']),
      /Unknown option/,
    );
  });

  it('parses numbers', () => {
    const flags = readFlags(parseArgs(['run', '--timeout', '30']), ['timeout']);
    assert.equal(flags.number('timeout'), 30);
  });

  it('rejects non-numeric values when the flag is read', () => {
    const flags = readFlags(parseArgs(['run', '--timeout', 'soon']), ['timeout']);
    assert.throws(() => flags.number('timeout'), /expects a number/);
  });

  it('returns the fallback when a flag is absent', () => {
    const flags = readFlags(parseArgs(['run']), ['concurrency']);
    assert.equal(flags.number('concurrency', 4), 4);
    assert.equal(flags.bool('bail'), false);
    assert.deepEqual(flags.list('tag'), []);
  });
});