import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { EventRecorder } from '../../src/core/events.js';
import type { AgentEvent } from '../../src/core/events.js';
import { projectRun } from '../../src/runner/project.js';
import { emitFragment } from '../../src/runner/run-test.js';
import type { FileChanges } from '../../src/core/types.js';

const NO_CHANGES: FileChanges = { created: [], deleted: [], modified: [], unchangedCount: 0 };

describe('EventRecorder', () => {
  it('assigns dense, monotonically increasing sequence numbers', () => {
    const recorder = new EventRecorder();
    recorder.emit({ role: 'assistant', text: 'a', type: 'message' });
    recorder.emit({ role: 'assistant', text: 'b', type: 'message' });
    recorder.emit({ path: 'x.ts', type: 'file_read' });
    assert.deepEqual(
      recorder.events.map((event) => event.seq),
      [0, 1, 2],
    );
  });

  it('stamps a timestamp on every event', () => {
    const recorder = new EventRecorder();
    const event = recorder.emit({ role: 'assistant', text: 'a', type: 'message' });
    assert.match(event.at, /^\d{4}-\d{2}-\d{2}T/);
  });

  it('accepts per-event fields the union would otherwise drop', () => {
    const recorder = new EventRecorder();
    const event = recorder.emit({ input: { path: 'a' }, tool: 'Read', type: 'tool_call_started' });
    assert.equal(event.type, 'tool_call_started');
    assert.equal((event as { tool: string }).tool, 'Read');
  });
});

describe('emitFragment', () => {
  it('maps every fragment kind onto a stored event type', () => {
    const recorder = new EventRecorder();
    const kinds = [
      { kind: 'agent_started', model: 'm' },
      { kind: 'agent_finished', numTurns: 2, ok: true },
      { kind: 'tool_call_started', input: {}, tool: 'Read' },
      { kind: 'tool_call_finished', ok: true, tool: 'Read' },
      { kind: 'file_read', path: 'a.ts' },
      { kind: 'file_written', path: 'b.ts' },
      { kind: 'command_started', command: 'ls' },
      { kind: 'command_finished', command: 'ls', exitCode: 0 },
      { kind: 'network_request', url: 'https://example.com' },
      { kind: 'message', role: 'assistant', text: 'done' },
      { kind: 'error', fatal: false, message: 'warn' },
      { kind: 'permission_request', decision: 'granted', tool: 'Bash' },
    ] as const;

    const types = kinds.map((fragment) => emitFragment(recorder, fragment).type);
    assert.deepEqual(types, [
      'agent_started',
      'agent_finished',
      'tool_call_started',
      'tool_call_finished',
      'file_read',
      'file_written',
      'command_started',
      'command_finished',
      'network_request',
      'message',
      'error',
      'permission_request',
    ]);
  });

  it('advances the sequence for each fragment', () => {
    const recorder = new EventRecorder();
    emitFragment(recorder, { kind: 'file_read', path: 'a' });
    emitFragment(recorder, { kind: 'file_read', path: 'b' });
    assert.deepEqual(
      recorder.events.map((event) => event.seq),
      [0, 1],
    );
  });
});

describe('projectRun', () => {
  it('counts tool calls per tool and in total', () => {
    const events: AgentEvent[] = [
      { at: '', seq: 0, tool: 'Read', input: {}, type: 'tool_call_started' },
      { at: '', seq: 1, tool: 'Write', input: {}, type: 'tool_call_started' },
      { at: '', seq: 2, tool: 'Read', input: {}, type: 'tool_call_started' },
    ];
    const { summary } = projectRun(events, { delta: NO_CHANGES, output: '', root: '' });
    assert.equal(summary.toolCalls, 3);
    assert.deepEqual(summary.toolCallCounts, { Read: 2, Write: 1 });
  });

  it('merges the filesystem delta with declared writes for filesWritten', () => {
    const events: AgentEvent[] = [{ at: '', seq: 0, kind: 'modified', path: 'src/a.ts', type: 'file_written' }];
    const { filesWritten, summary } = projectRun(events, {
      delta: { created: ['new.md'], deleted: [], modified: ['src/a.ts'], unchangedCount: 3 },
      output: '',
      root: '',
    });
    assert.deepEqual(summary.filesChanged, ['new.md', 'src/a.ts']);
    assert.deepEqual(filesWritten, ['new.md', 'src/a.ts']);
    assert.equal(summary.filesCreated.length, 1);
  });

  it('resolves absolute agent paths against the sandbox root', () => {
    const events: AgentEvent[] = [{ at: '', seq: 0, path: '/tmp/abc123/src/index.ts', type: 'file_read' }];
    const { summary } = projectRun(events, { delta: NO_CHANGES, output: '', root: '/tmp/abc123' });
    assert.deepEqual(summary.filesRead, ['src/index.ts']);
  });

  it('drops paths that escape the sandbox root', () => {
    const events: AgentEvent[] = [{ at: '', seq: 0, path: '/etc/passwd', type: 'file_read' }];
    const { summary } = projectRun(events, { delta: NO_CHANGES, output: '', root: '/tmp/abc123' });
    assert.deepEqual(summary.filesRead, []);
  });

  it('prefers the agent-reported numTurns for steps', () => {
    const events: AgentEvent[] = [
      { at: '', durationMs: 3, numTurns: 7, ok: true, seq: 0, type: 'agent_finished' },
    ];
    const { summary } = projectRun(events, { delta: NO_CHANGES, output: '', root: '' });
    assert.equal(summary.steps, 7);
  });

  it('falls back to counting assistant messages for steps', () => {
    const events: AgentEvent[] = [
      { at: '', seq: 0, role: 'assistant', text: 'one', type: 'message' },
      { at: '', seq: 1, role: 'user', text: 'prompt', type: 'message' },
      { at: '', seq: 2, role: 'assistant', text: 'two', type: 'message' },
    ];
    const { summary } = projectRun(events, { delta: NO_CHANGES, output: '', root: '' });
    assert.equal(summary.steps, 2);
  });

  it('collects errors, permissions and network attempts', () => {
    const events: AgentEvent[] = [
      { at: '', seq: 0, fatal: false, message: 'flaky read', type: 'error' },
      { at: '', seq: 1, decision: 'denied', tool: 'Bash', type: 'permission_request' },
      { at: '', seq: 2, url: 'https://api.example.com', type: 'network_request' },
    ];
    const { summary } = projectRun(events, { delta: NO_CHANGES, output: '', root: '' });
    assert.deepEqual(summary.errors, ['flaky read']);
    assert.deepEqual(summary.permissions, [{ decision: 'denied', tool: 'Bash' }]);
    assert.equal(summary.network.length, 1);
    assert.equal(summary.network[0]?.url, 'https://api.example.com');
    assert.equal(summary.network[0]?.blocked, false);
  });

  it('pairs commands with their exit codes', () => {
    const events: AgentEvent[] = [
      { at: '', seq: 0, command: 'npm test', cwd: '/w', type: 'command_started' },
      { at: '', seq: 1, command: 'npm test', durationMs: 5, exitCode: 1, type: 'command_finished' },
    ];
    const { summary } = projectRun(events, { delta: NO_CHANGES, output: '', root: '' });
    assert.equal(summary.commands.length, 1);
    assert.equal(summary.commands[0]?.command, 'npm test');
    assert.equal(summary.commands[0]?.exitCode, 1);
  });

  it('names the real tool on a finished event when the adapter left it unknown', () => {
    const events: AgentEvent[] = [
      { at: '', seq: 0, input: {}, tool: 'Read', toolUseId: 'u1', type: 'tool_call_started' },
      { at: '', durationMs: 2, ok: true, seq: 1, tool: 'unknown', toolUseId: 'u1', type: 'tool_call_finished' },
    ];
    const { summary } = projectRun(events, { delta: NO_CHANGES, output: '', root: '' });
    assert.deepEqual(summary.toolCallCounts, { Read: 1 });
  });
});