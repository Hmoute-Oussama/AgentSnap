import type { UsageInfo } from '../core/events.js';
import type { DiagnosticEntry } from '../core/types.js';
import type { AgentConfig, TestCase } from '../config/types.js';
import type { Sandbox } from '../sandbox/types.js';

/**
 * What a runtime can tell us about a run.
 *
 * Assertions consult this so a test can never claim enforcement the runtime does not
 * provide (for example permission decisions in a runtime that cannot report them).
 */
export interface AgentCapabilities {
  /** Emits structured per-tool-call events rather than only a final message. */
  granularEvents: boolean;
  /** Reports token counts and/or cost. */
  reportsUsage: boolean;
  /** Reports permission prompts and denials. */
  reportsPermissionDecisions: boolean;
  /** Supports restricting which tools the agent may use. */
  supportsToolRestrictions: boolean;
  /** Supports selecting a model from configuration. */
  supportsModelSelection: boolean;
  /** Supports a hard cost ceiling. */
  supportsCostLimit: boolean;
}

export interface DetectContext {
  config: AgentConfig;
  cwd: string;
  env: NodeJS.ProcessEnv;
}

export interface DetectionResult {
  /** True when the runtime appears usable. */
  available: boolean;
  /** Runtime version string when it could be read, otherwise `null`. */
  version: string | null;
  /** Absolute path to the executable when it could be resolved, otherwise `null`. */
  executablePath: string | null;
  /** Human-readable reasons detection failed. Never contains secret values. */
  problems: string[];
  /** Extra facts for `agentsnap doctor`. */
  notes: string[];
}

export interface AgentRunInput {
  test: TestCase;
  prompt: string;
  sandbox: Sandbox;
  /** Resolved `agent:` block from configuration. */
  agent: AgentConfig;
  /** Allow-listed environment for the runtime process. */
  env: Record<string, string>;
  timeoutSeconds: number;
  maxCostUsd: number | null;
  signal: AbortSignal;
  /** Adapters emit fragments; the runner stamps sequence numbers and timestamps. */
  emit: (fragment: AgentEventFragment) => void;
  onUsage?: (usage: UsageInfo) => void;
}

/**
 * Runtime-neutral contract every agent integration implements.
 *
 * Two execution models are supported, and the difference is explicit rather than hidden
 * behind reflection:
 *   - `subprocess`: the runtime is a CLI; AgentSnap builds argv and parses its stream.
 *   - `in-process`: the runtime is linked into AgentSnap and mutates the sandbox directly.
 */
export interface AgentAdapter {
  /** Stable identifier used in configuration (`agent.provider`). */
  readonly name: string;
  /** Name shown to humans. */
  readonly displayName: string;
  /** Where the integration is documented. */
  readonly docsUrl: string;
  readonly execution: 'subprocess' | 'in-process';

  capabilities(): AgentCapabilities;
  detect(context: DetectContext): Promise<DetectionResult>;
  /** Extra `doctor` checks beyond availability. */
  diagnostics?(context: DetectContext): Promise<DiagnosticEntry[]>;
/** Builds the full argv for a subprocess runtime, including the prompt. */
  buildArgv(input: AgentRunInput): Promise<string[]>;
  /** Executes an in-process runtime. Subprocess adapters omit this. */
  run?(input: AgentRunInput): Promise<AgentResultFragment>;
  /** Translates one parsed stdout record into zero or more normalized events. */
  parseEvent(record: unknown, input: AgentRunInput): AgentEventFragment[];
  /** Reads final metadata (usage, outcome) out of the terminal stream record. */
  parseResult(record: unknown): AgentResultFragment | null;
}

/**
 * A normalized event without sequence or timestamp, which the runner assigns.
 *
 * Adapters use the `kind` discriminator instead of the event `type` so that adapters can
 * emit richer payloads (for example a tool's raw arguments) than the stored event carries.
 */
export type AgentEventFragment =
  | { kind: 'agent_started'; model?: string; sessionId?: string; extra?: Record<string, unknown> }
  | {
      kind: 'agent_finished';
      ok: boolean;
      output?: string;
      numTurns?: number;
      durationMs?: number;
      errors?: string[];
      usage?: UsageInfo;
    }
  | { kind: 'tool_call_started'; tool: string; toolUseId?: string; input: Record<string, unknown> }
  | {
      kind: 'tool_call_finished';
      tool: string;
      toolUseId?: string;
      ok: boolean;
      output?: string;
      permission?: 'granted' | 'denied' | 'skipped';
    }
  | { kind: 'file_read'; path: string }
  | { kind: 'file_written'; path: string }
  | { kind: 'command_started'; command: string }
  | { kind: 'command_finished'; command: string; exitCode: number | null }
  | { kind: 'network_request'; url: string; blocked?: boolean }
  | { kind: 'permission_request'; tool: string; decision: 'granted' | 'denied' | 'skipped'; input?: Record<string, unknown> }
  | { kind: 'message'; role: 'user' | 'assistant' | 'system'; text: string }
  | { kind: 'error'; message: string; fatal: boolean };

export interface AgentResultFragment {
  ok: boolean;
  /** Final assistant text, already redacted by the caller. */
  output?: string;
  numTurns?: number;
  durationMs?: number;
  usage?: UsageInfo;
  sessionId?: string;
  model?: string;
  /** Non-fatal problems worth reporting. */
  errors?: string[];
}
