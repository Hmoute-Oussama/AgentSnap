import { nowIso } from '../utils/time.js';

/**
 * Stable event model.
 *
 * Every adapter translates its runtime-specific stream into these events, and every
 * downstream subsystem (assertions, snapshots, diff, replay tooling) reads only these.
 * Adding a new adapter therefore cannot break the assertion engine, and adding a new
 * consumer cannot break an adapter.
 *
 * Contract:
 *   - `seq` is monotonically increasing within a single run, starting at 0.
 *   - `at` is an ISO-8601 wall-clock timestamp; it is stripped before snapshotting.
 *   - All strings in `input`/`output` are already redacted by the adapter boundary.
 */
export const EVENT_TYPES = [
  'agent_started',
  'agent_finished',
  'tool_call_started',
  'tool_call_finished',
  'file_read',
  'file_written',
  'command_started',
  'command_finished',
  'network_request',
  'permission_request',
  'message',
  'error',
] as const;

export type EventType = (typeof EVENT_TYPES)[number];

export type FileChangeKind = 'created' | 'modified' | 'deleted';

export interface EventBase {
  at: string;
  seq: number;
  type: EventType;
}

export interface AgentStartedEvent extends EventBase {
  adapter: string;
  cwd: string;
  model?: string;
  sessionId?: string;
  type: 'agent_started';
}

export interface AgentFinishedEvent extends EventBase {
  ok: boolean;
  durationMs: number;
  numTurns?: number;
  type: 'agent_finished';
  usage?: UsageInfo;
}

export interface ToolCallStartedEvent extends EventBase {
  tool: string;
  input: Record<string, unknown>;
  toolUseId?: string;
  type: 'tool_call_started';
}

export interface ToolCallFinishedEvent extends EventBase {
  tool: string;
  ok: boolean;
  durationMs: number;
  output?: string;
  toolUseId?: string;
  type: 'tool_call_finished';
}

export interface FileReadEvent extends EventBase {
  path: string;
  type: 'file_read';
}

export interface FileWrittenEvent extends EventBase {
  path: string;
  kind: FileChangeKind;
  type: 'file_written';
}

export interface CommandStartedEvent extends EventBase {
  command: string;
  cwd: string;
  type: 'command_started';
}

export interface CommandFinishedEvent extends EventBase {
  command: string;
  exitCode: number | null;
  durationMs: number;
  type: 'command_finished';
}

export interface NetworkRequestEvent extends EventBase {
  url: string;
  blocked?: boolean;
  method?: string;
  type: 'network_request';
}

/**
 * A permission decision.
 *
 * `decision: 'granted' | 'denied' | 'skipped'` where `skipped` means the sandbox answered
 * the prompt automatically (used by non-interactive CI runs).
 */
export interface PermissionRequestEvent extends EventBase {
  tool: string;
  decision: 'granted' | 'denied' | 'skipped';
  input?: Record<string, unknown>;
  type: 'permission_request';
}

export interface MessageEvent extends EventBase {
  role: 'user' | 'assistant' | 'system';
  text: string;
  type: 'message';
}

export interface ErrorEvent extends EventBase {
  message: string;
  fatal: boolean;
  type: 'error';
}

export interface UsageInfo {
  costUsd?: number;
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheCreationTokens?: number;
}

export type AgentEvent =
  | AgentStartedEvent
  | AgentFinishedEvent
  | ToolCallStartedEvent
  | ToolCallFinishedEvent
  | FileReadEvent
  | FileWrittenEvent
  | CommandStartedEvent
  | CommandFinishedEvent
  | NetworkRequestEvent
  | PermissionRequestEvent
  | MessageEvent
  | ErrorEvent;

/**
 * Anything that can emit events. Adapters and sandboxes implement this.
 *
 * The distributive conditional matters: a plain `Omit<AgentEvent, 'at' | 'seq'>` collapses to
 * the keys common to every member and would silently drop per-event fields such as `tool` or
 * `path`, so every `recorder.emit({ ... })` would stop type-checking.
 */
type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;

export type EventInput = DistributiveOmit<AgentEvent, 'at' | 'seq'> &
  Partial<Pick<AgentEvent, 'at' | 'seq'>>;

export type EventEmitter = (event: EventInput) => void;

/** Assigns sequence numbers and timestamps so adapters never have to. */
export class EventRecorder {
  #seq = 0;
  readonly events: AgentEvent[] = [];

  emit(input: EventInput): AgentEvent {
    const seq = input.seq ?? this.#seq;
    if (input.seq === undefined) this.#seq += 1;
    const event = { ...input, at: input.at ?? nowIso(), seq } as AgentEvent;
    this.events.push(event);
    return event;
  }

  get size(): number {
    return this.events.length;
  }

  toArray(): AgentEvent[] {
    return [...this.events];
  }
}

export function isEventType(value: string): value is EventType {
  return (EVENT_TYPES as readonly string[]).includes(value);
}
