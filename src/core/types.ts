import type { AgentEvent, UsageInfo } from './events.js';

/** Terminal outcome of a single test execution attempt. */
export const RUN_STATUSES = ['passed', 'failed', 'skipped', 'errored', 'timed-out'] as const;
export type RunStatus = (typeof RUN_STATUSES)[number];

export const ASSERTION_STATUSES = ['passed', 'failed', 'skipped', 'warning'] as const;
export type AssertionStatus = (typeof ASSERTION_STATUSES)[number];

export interface AssertionResult {
  /** Assertion kind, e.g. `file_changed`. */
  kind: string;
  /** Human-readable, fully resolved statement of the expectation. */
  expectation: string;
  /** What was actually observed, or `null` when not applicable. */
  observed: string | null;
  status: AssertionStatus;
  /** Assertion index inside the test, for stable ordering in reports. */
  index: number;
  /** Assertion-specific structured detail (matched paths, counts, exit codes). */
  details?: Record<string, unknown>;
  /**
   * Set when the assertion could not be evaluated at all (for example a security
   * assertion that requires sandbox capabilities the active sandbox lacks).
   */
  skipReason?: string;
}

/** Normalized filesystem outcome of one agent run. */
export interface FileChanges {
  created: string[];
  deleted: string[];
  modified: string[];
  unchangedCount: number;
}

export interface CommandRecord {
  command: string;
  exitCode: number | null;
  durationMs: number;
  timedOut: boolean;
}

export interface PermissionRecord {
  tool: string;
  decision: 'granted' | 'denied' | 'skipped';
}

export interface NetworkRecord {
  url: string;
  blocked: boolean;
  method?: string;
}

export interface RunSummary {
  /** Total tool calls (started), i.e. "agentic actions". */
  toolCalls: number;
  toolCallCounts: Record<string, number>;
  /** Assistant turns / agentic loop iterations as reported by the adapter. */
  steps: number;
  filesRead: string[];
  filesChanged: string[];
  filesCreated: string[];
  filesDeleted: string[];
  commands: CommandRecord[];
  permissions: PermissionRecord[];
  network: NetworkRecord[];
  errors: string[];
  /** Final assistant text, already redacted and truncated. */
  output: string;
}

/** The durable record of one execution. Written to `.agentsnap/runs/<runId>.json`. */
export interface RunRecord {
  schemaVersion: number;
  runId: string;
  test: string;
  adapter: string;
  model: string | null;
  status: RunStatus;
  exitReason: ExitReason;
  startedAt: string;
  durationMs: number;
  attempt: number;
  summary: RunSummary;
  fileChanges: FileChanges;
  assertions: AssertionResult[];
  usage: UsageInfo | null;
  sandbox: SandboxInfo;
  /** Full event stream. Always redacted; may be large. */
  events: AgentEvent[];
}

export const EXIT_REASONS = [
  'completed',
  'assertions-failed',
  'agent-error',
  'timeout',
  'spawn-failure',
  'sandbox-error',
  'cancelled',
  'internal-error',
] as const;
export type ExitReason = (typeof EXIT_REASONS)[number];

export interface SandboxInfo {
  kind: 'local' | 'docker';
  /** Filesystem isolation actually provided by this sandbox. */
  filesystemIsolation: 'copy' | 'in-place';
  /** True only when egress is actually blocked by the sandbox. */
  networkBlocked: boolean;
  /** True only when the sandbox is documented to enforce memory/CPU limits. */
  resourceLimits: boolean;
}

/** Suite-level verdict. */
export type SuiteStatus = 'pass' | 'fail' | 'error' | 'interrupted';

export interface SuiteResult {
  schemaVersion: number;
  status: SuiteStatus;
  startedAt: string;
  durationMs: number;
  toolVersion: string;
  adapter: string;
  configPath: string | null;
  tests: RunRecord[];
  totals: SuiteTotals;
  flakiness: FlakinessReport;
  diagnostics: DiagnosticEntry[];
}

export interface SuiteTotals {
  total: number;
  passed: number;
  failed: number;
  skipped: number;
  errored: number;
  timedOut: number;
  assertions: { total: number; passed: number; failed: number; skipped: number; warning: number };
  toolCalls: number;
  regressions: number;
}

export interface FlakinessReport {
  /** Tests whose outcomes differed across attempts. */
  unstable: Array<{ test: string; statuses: RunStatus[] }>;
  retriesObserved: number;
}

export type DiagnosticStatus = 'ok' | 'warn' | 'fail' | 'info';

export interface DiagnosticEntry {
  name: string;
  status: DiagnosticStatus;
  detail: string;
  hint?: string;
}
