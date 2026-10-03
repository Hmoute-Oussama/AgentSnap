import type { AssertionResult, RunRecord, SuiteResult } from '../core/types.js';
import { GLYPH, RULE, type Colorizer } from '../utils/color.js';
import type { Logger } from '../utils/logger.js';
import type { Reporter, SuiteStartInfo, TestEndInfo, TestStartInfo } from './types.js';

export interface ConsoleReporterOptions {
  color: Colorizer;
  logger: Logger;
  /** Print every assertion of every test, not just failures. */
  verboseAssertions: boolean;
  /** Print the full event stream for failures. */
  showEvents: boolean;
  /** Print usage/cost totals. */
  showUsage: boolean;
}

/**
 * Human-readable output.
 *
 * Design rules:
 *   - status is never conveyed by color alone (glyph + word always accompany it)
 *   - one line per test, with failures detailed afterwards so the summary stays scannable
 *   - diagnostics go to stderr via the logger, so stdout stays copy-pasteable
 */
export function createConsoleReporter(options: ConsoleReporterOptions): Reporter {
  const { color, logger } = options;
  let total = 0;

  return {
    name: 'console',

    suiteStart(info: SuiteStartInfo) {
      total = info.total;
      logger.info(`${color.bold('AgentSnap')} ${color.dim(`v${info.toolVersion}`)} ${color.dim(info.adapter)}`);
      logger.info(
        `${total} test${total === 1 ? '' : 's'}${info.configPath ? color.dim(` from ${info.configPath}`) : ''}`,
      );
    },

    testStart(info: TestStartInfo) {
      const position = color.dim(`[${info.index}/${info.total}]`);
      const attempt = info.attempt > 1 ? color.yellow(` (retry ${info.attempt}/${info.maxAttempts})`) : '';
      logger.out(`${position} ${color.bold(info.test)}${attempt}`);
      if (info.description) logger.out(`       ${color.dim(info.description)}`);
    },

    attemptEnd(record: RunRecord) {
      if (record.status === 'skipped') {
        logger.out(`       ${color.dim(`${GLYPH.skip} skipped`)}`);
      }
    },

    testEnd(info: TestEndInfo) {
      const { record, unstable } = info;
      const head = statusGlyph(record, color);
      const detail = statusDetail(record);
      logger.out(`       ${head} ${color.dim(detail)}`);

      if (unstable) {
        const statuses = info.attempts.map((attempt) => attempt.status).join(' -> ');
        logger.out(`       ${color.yellow(GLYPH.warn)} ${color.dim(`flaky across retries: ${statuses}`)}`);
      }

      if (record.status === 'failed' || record.status === 'timed-out' || record.status === 'errored') {
        printFailure(record, options);
      } else if (options.verboseAssertions) {
        for (const assertion of record.assertions) printAssertion(assertion, color, '       ', logger);
      }
    },

    suiteEnd(result: SuiteResult) {
      logger.out('');
      printSummary(result, options);
    },
  };
}

function statusGlyph(record: RunRecord, color: Colorizer): string {
  if (record.status === 'passed') return color.green(GLYPH.pass);
  if (record.status === 'failed') return color.red(GLYPH.fail);
  if (record.status === 'skipped') return color.dim(GLYPH.skip);
  if (record.status === 'timed-out') return color.yellow(GLYPH.warn);
  return color.red(GLYPH.fail);
}

function statusDetail(record: RunRecord): string {
  const parts = [`${record.summary.toolCalls} tool calls`, `${(record.durationMs / 1000).toFixed(1)}s`];
  if (record.summary.steps > 0) parts.push(`${record.summary.steps} steps`);
  if (record.exitReason !== 'completed') parts.push(record.exitReason);
  return parts.join(`${GLYPH.info} `);
}

function printAssertion(assertion: AssertionResult, color: Colorizer, indent: string, logger: Logger): void {
  const mark =
    assertion.status === 'passed'
      ? color.green(GLYPH.pass)
      : assertion.status === 'failed'
        ? color.red(GLYPH.fail)
        : assertion.status === 'warning'
          ? color.yellow(GLYPH.warn)
          : color.dim(GLYPH.skip);

  logger.out(`${indent}${mark} ${assertion.expectation}`);
  if (assertion.status !== 'passed' && assertion.observed) {
    logger.out(`${indent}  ${color.dim(assertion.observed)}`);
  }
  if (assertion.skipReason) {
    logger.out(`${indent}  ${color.dim(`skipped: ${assertion.skipReason}`)}`);
  }
}

function printFailure(record: RunRecord, options: ConsoleReporterOptions): void {
  const { color, logger } = options;
  const failed = record.assertions.filter((assertion) => assertion.status === 'failed');

  if (failed.length > 0) {
    logger.out('');
    logger.out(color.red(`  ${record.test} — ${failed.length} failed expectation${failed.length === 1 ? '' : 's'}`));
    for (const assertion of failed) {
      printAssertion(assertion, color, '    ', logger);
      const matched = assertion.details?.['matched'];
      if (Array.isArray(matched) && matched.length > 0) {
        for (const path of matched.slice(0, 10)) logger.out(`        ${color.dim(String(path))}`);
      }
    }
  }

  const errors = record.summary.errors;
  if (errors.length > 0) {
    logger.out('');
    for (const error of errors.slice(0, 5)) {
      logger.out(`    ${color.red(GLYPH.fail)} ${error}`);
    }
  }

  if (options.showEvents && record.events.length > 0) {
    logger.out('');
    logger.out(color.dim(RULE));
    for (const event of record.events) {
      logger.out(color.dim(`  ${String(event.seq).padStart(3, ' ')} ${event.type}`));
    }
    logger.out(color.dim(RULE));
  }

  if (record.summary.output) {
    logger.out('');
    logger.out(color.dim('  final output:'));
    for (const line of record.summary.output.split('\n').slice(0, 12)) {
      logger.out(color.dim(`    ${line}`));
    }
  }
}

function printSummary(result: SuiteResult, options: ConsoleReporterOptions): void {
  const { color, logger } = options;
  const { totals } = result;

  const verdict =
    result.status === 'pass'
      ? color.green(`PASS ${totals.passed}/${totals.total}`)
      : result.status === 'interrupted'
        ? color.yellow('INTERRUPTED')
        : color.red(result.status.toUpperCase());

  logger.out(`  ${verdict}`);
  logger.out(
    color.dim(
      `${totals.passed} passed` +
        `${totals.failed ? `${GLYPH.info} ${totals.failed} failed` : ''}` +
        `${totals.timedOut ? `${GLYPH.info} ${totals.timedOut} timed out` : ''}` +
        `${totals.errored ? `${GLYPH.info} ${totals.errored} errored` : ''}` +
        `${totals.skipped ? `${GLYPH.info} ${totals.skipped} skipped` : ''}` +
        `${GLYPH.info} ${totals.assertions.passed}/${totals.assertions.total} assertions` +
        `${GLYPH.info} ${totals.toolCalls} tool calls`,
    ),
  );

  if (options.showUsage) {
    const cost = result.tests.reduce((sum, record) => sum + (record.usage?.costUsd ?? 0), 0);
    if (cost > 0) logger.out(color.dim(`  estimated cost: $${cost.toFixed(4)}`));
  }

  if (totals.regressions > 0) {
    logger.out('');
    logger.out(
      color.red(
        `  ${GLYPH.warn} ${totals.regressions} security expectation${totals.regressions === 1 ? '' : 's'} violated`,
      ),
    );
  }

  if (result.flakiness.unstable.length > 0) {
    logger.out('');
    logger.out(color.yellow(`  ${GLYPH.warn} ${result.flakiness.unstable.length} test(s) were flaky:`));
    for (const entry of result.flakiness.unstable) {
      logger.out(color.dim(`    ${entry.test}: ${entry.statuses.join(' -> ')}`));
    }
  }

  const failing = result.diagnostics.filter((entry) => entry.status === 'warn' || entry.status === 'fail');
  if (failing.length > 0) {
    logger.out('');
    logger.out(color.yellow(`  ${GLYPH.warn} diagnostics:`));
    for (const entry of failing) {
      logger.out(`    ${color.yellow(entry.status)} ${entry.name}: ${entry.detail}`);
      if (entry.hint) logger.out(color.dim(`      ${entry.hint}`));
    }
  }
}