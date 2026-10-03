import type { RunRecord, SuiteResult } from '../core/types.js';

/**
 * Reporting contract.
 *
 * Reporters observe results and never influence them: a reporter cannot change an exit code
 * or suppress a failure, which is what makes `agentsnap run --reporter json` safe to pipe into
 * a CI annotation step.
 */
export interface Reporter {
  readonly name: string;
  suiteStart?(info: SuiteStartInfo): void;
  testStart?(info: TestStartInfo): void;
  /** Fired once per attempt, including retries. */
  attemptEnd?(record: RunRecord): void;
  testEnd?(info: TestEndInfo): void;
  suiteEnd?(result: SuiteResult): void;
}

export interface SuiteStartInfo {
  total: number;
  toolVersion: string;
  adapter: string;
  configPath: string | null;
}

export interface TestStartInfo {
  test: string;
  description: string;
  attempt: number;
  maxAttempts: number;
  index: number;
  total: number;
  tags: string[];
}

export interface TestEndInfo {
  /** The attempt whose status counts as the test result. */
  record: RunRecord;
  /** Every attempt, oldest first. Length > 1 means retries happened. */
  attempts: RunRecord[];
  unstable: boolean;
  durationMs: number;
}