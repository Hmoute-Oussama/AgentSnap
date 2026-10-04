import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  CLAUDE_MINIMUMS,
  buildArgv,
  claudeCodeAdapter,
  normalizeAgentPath,
  parseEvent,
  parseResult,
} from '../../src/adapters/claude-code.js';
import { builtinAdapters, ConfigUnknownAdapter, getAdapter } from '../../src/adapters/registry.js';
import { parseVersion, versionAtLeast } from '../../src/adapters/version.js';
import { isKnownProvider, KNOWN_PROVIDERS } from '../../src/adapters/providers.js';
import { fakeAdapter } from '../../src/adapters/fake.js';
import { makeTest } from '../helpers/fixtures.js';
import type { AgentConfig } from '../../src/config/types.js';
import type { AgentRunInput } from '../../src/adapters/types.js';

const AGENT: AgentConfig = {
  args: [],
  bare: false,
  command: 'claude',
  env: {},
  provider: 'claude-code',
};

function runInput(overrides: Partial<AgentRunInput> = {}): AgentRunInput {
  return {
    agent: AGENT,
    env: { PATH: process.env['PATH'] ?? '' },
    maxCostUsd: null,
    prompt: 'do the thing',
    sandbox: {} as AgentRunInput['sandbox'],
    signal: new AbortController().signal,
    test: makeTest(),
    timeoutSeconds: 60,
    ...overrides,
  } as AgentRunInput;
}

describe('parseVersion and versionAtLeast', () => {
  it('extracts the version from decorated output', () => {
    assert.equal(parseVersion('2.1.285 (Claude Code)'), '2.1.285');
    assert.equal(parseVersion('claude 1.2'), '1.2.0');
    assert.equal(parseVersion('no numbers here'), null);
  });

  it('compares versions numerically, not lexically', () => {
    assert.equal(versionAtLeast('2.1.260', '2.1.259'), true);
    assert.equal(versionAtLeast('2.1.100', '2.1.99'), true);
    assert.equal(versionAtLeast('2.0.9', '2.1.0'), false);
    assert.equal(versionAtLeast('3.0.0', '2.1.259'), true);
    assert.equal(versionAtLeast(null, '2.1.0'), false);
    assert.equal(versionAtLeast('2.1.259', '2.1.259'), true);
  });
});

describe('claude-code buildArgv', () => {
  /** A runtime AgentSnap can definitely resolve and whose version is comfortably new. */
  const NEW_RUNTIME = process.execPath;
  const MISSING_RUNTIME = 'agentsnap-no-such-runtime';

  it('always runs in headless streaming mode', async () => {
    const argv = await buildArgv(runInput());
    assert.equal(argv[0], 'claude');
    assert.ok(argv.includes('-p'));
    assert.equal(argv[argv.indexOf('-p') + 1], 'do the thing');
    assert.equal(argv[argv.indexOf('--output-format') + 1], 'stream-json');
    assert.ok(argv.includes('--verbose'));
  });

  it('passes the prompt as one argv entry, so shell metacharacters stay inert', async () => {
    const prompt = 'a prompt with "quotes" & $vars; rm -rf /';
    const argv = await buildArgv(runInput({ prompt }));
    assert.equal(argv[argv.indexOf('-p') + 1], prompt);
    assert.equal(argv.filter((value) => value === prompt).length, 1);
  });

  it('honours a custom command', async () => {
    const argv = await buildArgv(runInput({ agent: { ...AGENT, command: '/opt/claude/bin/claude' } }));
    assert.equal(argv[0], '/opt/claude/bin/claude');
  });

  it('omits version-gated flags when the runtime version cannot be read', async () => {
    // Passing a flag an older CLI does not understand fails with "unknown option", which is
    // indistinguishable from a real agent failure, so an unknown version must stay minimal.
    const argv = await buildArgv(runInput({ agent: { ...AGENT, command: MISSING_RUNTIME }, maxCostUsd: 1 }));
    assert.equal(argv.includes('--max-budget-usd'), false);
    assert.equal(argv.includes('--permission-prompts'), false);
  });

  it('adds the cost ceiling and unattended-permission flag on a new enough runtime', async () => {
    const argv = await buildArgv(runInput({ agent: { ...AGENT, command: NEW_RUNTIME }, maxCostUsd: 0.5 }));
    assert.ok(argv.includes('--permission-prompts'));
    assert.equal(argv[argv.indexOf('--permission-prompts') + 1], 'none');
    assert.ok(argv.includes('--max-budget-usd'));
    assert.equal(argv[argv.indexOf('--max-budget-usd') + 1], '0.5000');
  });

  it('omits the cost ceiling when no budget is configured', async () => {
    const argv = await buildArgv(runInput({ agent: { ...AGENT, command: NEW_RUNTIME }, maxCostUsd: null }));
    assert.equal(argv.includes('--max-budget-usd'), false);
    assert.ok(argv.includes('--permission-prompts'));
  });

  it('restricts tools when the config lists them', async () => {
    const argv = await buildArgv(runInput({ agent: { ...AGENT, allowedTools: ['Read', 'Grep'] } }));
    assert.equal(argv[argv.indexOf('--allowedTools') + 1], 'Read,Grep');
  });

  it('passes model, turn limit and bare mode only when configured', async () => {
    assert.equal((await buildArgv(runInput())).includes('--model'), false);
    const argv = await buildArgv(
      runInput({ agent: { ...AGENT, bare: true, maxTurns: 3, model: 'claude-sonnet-4' } }),
    );
    assert.equal(argv[argv.indexOf('--model') + 1], 'claude-sonnet-4');
    assert.equal(argv[argv.indexOf('--max-turns') + 1], '3');
    assert.ok(argv.includes('--bare'));
  });

  it('appends extra args from configuration after the managed flags', async () => {
    const argv = await buildArgv(runInput({ agent: { ...AGENT, args: ['--extra-flag'] } }));
    assert.equal(argv[argv.length - 1], '--extra-flag');
  });

  it('declares its minimum supported runtime versions', () => {
    assert.match(CLAUDE_MINIMUMS.permissionPrompts, /^\d+\.\d+\.\d+$/);
    assert.match(CLAUDE_MINIMUMS.costLimit, /^\d+\.\d+\.\d+$/);
  });
});

describe('claude-code event parsing', () => {
  it('maps an assistant message', () => {
    const fragments = parseEvent({
      type: 'assistant',
      message: { content: [{ text: 'hello', type: 'text' }] },
    });
    assert.deepEqual(fragments, [{ kind: 'message', role: 'assistant', text: 'hello' }]);
  });

  it('maps a tool_use block into a started fragment', () => {
    const fragments = parseEvent({
      type: 'assistant',
      message: { content: [{ id: 'tu_1', input: { file_path: 'a.ts' }, name: 'Read', type: 'tool_use' }] },
    });
    assert.deepEqual(fragments, [
      { input: { file_path: 'a.ts' }, kind: 'tool_call_started', tool: 'Read', toolUseId: 'tu_1' },
      { kind: 'file_read', path: 'a.ts' },
    ]);
  });

  it('maps a user tool_result block into a finished fragment', () => {
    const fragments = parseEvent({
      type: 'user',
      message: { content: [{ content: 'ok', is_error: false, tool_use_id: 'tu_1', type: 'tool_result' }] },
    });
    assert.equal(fragments.length, 1);
    assert.equal(fragments[0]?.kind, 'tool_call_finished');
    assert.equal((fragments[0] as { ok?: boolean })?.ok, true);
  });

  it('marks a failed tool_result as not ok', () => {
    const fragments = parseEvent({
      type: 'user',
      message: { content: [{ content: 'boom', is_error: true, tool_use_id: 'tu_1', type: 'tool_result' }] },
    });
    assert.equal((fragments[0] as { ok?: boolean })?.ok, false);
  });

  it('turns the init record into agent_started', () => {
    const fragments = parseEvent({ session_id: 's1', subtype: 'init', tools: ['Bash'], type: 'system' });
    assert.equal(fragments.length, 1);
    assert.equal(fragments[0]?.kind, 'agent_started');
    assert.equal((fragments[0] as { sessionId?: string }).sessionId, 's1');
  });

  it('ignores records it does not understand instead of throwing', () => {
    assert.deepEqual(parseEvent({ subtype: 'something_new', type: 'system' }), []);
    assert.deepEqual(parseEvent(null), []);
    assert.deepEqual(parseEvent('nonsense'), []);
    assert.deepEqual(parseEvent({ message: {} }), []);
  });

  it('normalizes reported paths to POSIX without a leading ./', () => {
    assert.equal(normalizeAgentPath('./src/a.ts'), 'src/a.ts');
    assert.equal(normalizeAgentPath('src\\a.ts'), 'src/a.ts');
  });
});

describe('claude-code result parsing', () => {
  it('extracts the result, turns and cost', () => {
    const result = parseResult({
      duration_ms: 4200,
      is_error: false,
      num_turns: 5,
      result: 'final answer',
      subtype: 'success',
      total_cost_usd: 0.0123,
      type: 'result',
      usage: { input_tokens: 10, output_tokens: 20 },
    });
    assert.ok(result);
    assert.equal(result.ok, true);
    assert.equal(result.output, 'final answer');
    assert.equal(result.numTurns, 5);
    assert.equal(result.durationMs, 4200);
    assert.equal(result.usage?.costUsd, 0.0123);
    assert.equal(result.usage?.inputTokens, 10);
  });

  it('maps a non-error result subtype to ok', () => {
    assert.equal(parseResult({ is_error: false, subtype: 'success', type: 'result' })?.ok, true);
  });

  it('keeps an explicit error message', () => {
    const result = parseResult({ error: 'quota exceeded', is_error: true, type: 'result' });
    assert.equal(result?.ok, false);
    assert.deepEqual(result?.errors, ['quota exceeded']);
  });

  it('falls back to the result text so a failure is never silent', () => {
    const result = parseResult({ is_error: true, result: 'Refusing to edit files', type: 'result' });
    assert.equal(result?.ok, false);
    assert.deepEqual(result?.errors, ['Refusing to edit files']);
  });

  it('names the subtype when a failure carries no text at all', () => {
    const result = parseResult({ is_error: true, subtype: 'error_during_execution', type: 'result' });
    assert.deepEqual(result?.errors, ['the runtime reported error_during_execution']);
  });

  it('records permission denials as errors', () => {
    const result = parseResult({
      is_error: false,
      permission_denials: [{ tool_name: 'Bash' }],
      type: 'result',
    });
    assert.deepEqual(result?.errors, ['permission denied: Bash']);
  });

  it('returns null for a non-result record', () => {
    assert.equal(parseResult({ type: 'assistant' }), null);
    assert.equal(parseResult(null), null);
  });
});

describe('adapter registry', () => {
  it('resolves built-in adapters by name', () => {
    assert.equal(getAdapter('fake'), fakeAdapter);
    assert.equal(getAdapter('claude-code'), claudeCodeAdapter);
  });

  it('throws a config error listing the known providers', () => {
    let thrown: unknown;
    try {
      getAdapter('gpt');
    } catch (error) {
      thrown = error;
    }
    assert.ok(thrown instanceof ConfigUnknownAdapter);
    assert.equal(thrown.exitCode, 2);
    assert.match(thrown.message, /Unknown agent provider "gpt"/);
    assert.match((thrown.causes ?? []).join(' '), /claude-code/);
  });

  it('keeps KNOWN_PROVIDERS in sync with the registry', () => {
    assert.deepEqual(
      builtinAdapters().map((adapter) => adapter.name).sort(),
      [...KNOWN_PROVIDERS].sort(),
    );
    for (const name of KNOWN_PROVIDERS) assert.ok(isKnownProvider(name));
    assert.equal(isKnownProvider('gpt'), false);
  });

  it('describes its capabilities honestly', () => {
    assert.equal(claudeCodeAdapter.execution, 'subprocess');
    assert.equal(fakeAdapter.execution, 'in-process');
    assert.equal(claudeCodeAdapter.capabilities().granularEvents, true);
    assert.equal(claudeCodeAdapter.capabilities().reportsUsage, true);
    assert.equal(claudeCodeAdapter.capabilities().supportsModelSelection, true);
  });

  it('ships a docs URL for every adapter', () => {
    for (const adapter of builtinAdapters()) {
      assert.match(adapter.docsUrl, /^https:\/\//);
      assert.ok(adapter.displayName.length > 0);
    }
  });
});