import type { SuiteResult } from '../core/types.js';
import type { Reporter } from './types.js';
import { stableStringify } from '../utils/hash.js';
import type { SuiteStartInfo, TestEndInfo, TestStartInfo } from './types.js';

export interface JsonReporterOptions {
  /**
   * Emit one JSON document per event instead of a single document at the end.
   *
   * Newline-delimited JSON is the only format that stays useful when a run is interrupted:
   * a partially failed CI job still has every completed test on disk.
   */
  stream: boolean;
  write: (text: string) => void;
}

export interface JsonReporter extends Reporter {
  /** Last completed suite, or `null` when the run aborted before `suiteEnd`. */
  result(): SuiteResult | null;
}

/**
 * Machine-readable output.
 *
 * The shape is the same `SuiteResult` written to `.agentsnap/last-run.json`, so a CI job can
 * diff the two without a translation step. Events are omitted by default because they can be
 * megabytes; `--include-events` opts in.
 */
export function createJsonReporter(options: JsonReporterOptions): JsonReporter {
  let buffered: SuiteResult | null = null;

  const emit = (value: unknown): void => {
    options.write(`${stableStringify(value)}\n`);
  };

  return {
    name: 'json',

    result: () => buffered,

    suiteStart(info: SuiteStartInfo) {
      if (options.stream) emit({ event: 'suite-start', ...info });
    },

    testStart(info: TestStartInfo) {
      if (options.stream) emit({ event: 'test-start', ...info });
    },

    testEnd(info: TestEndInfo) {
      if (!options.stream) return;
      emit({
        assertions: info.record.assertions,
        attempt: info.record.attempt,
        durationMs: info.record.durationMs,
        event: 'test',
        exitReason: info.record.exitReason,
        fileChanges: info.record.fileChanges,
        sandbox: info.record.sandbox,
        status: info.record.status,
        summary: info.record.summary,
        test: info.record.test,
        unstable: info.unstable,
        usage: info.record.usage,
      });
    },

    suiteEnd(result: SuiteResult) {
      buffered = result;
      if (options.stream) {
        emit({ event: 'suite', suite: result });
        return;
      }
      options.write(`${stableStringify(result, 2)}\n`);
    },
  };
}