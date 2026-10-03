import type { AssertionResult, AssertionStatus } from '../core/types.js';
import { createMatcher, describeMatcher, type MatcherSpec } from '../utils/matching.js';
import { isPlainObject } from '../utils/validate.js';
import {
  getAssertionDefinition,
  type AssertionContext,
  type ParsedAssertion,
} from './definitions.js';

const MAX_OBSERVED_CHARS = 600;

export interface EvaluateOptions {
  /** Resolves the project test command for `tests_must_pass: true`. */
  defaultTestCommand?: string | null;
}

/**
 * Evaluates parsed assertions against a normalized run.
 *
 * Pure by construction: given the same context every assertion yields the same result.
 * No assertion can execute a process except the two `*_must_pass` kinds, which do so
 * through the sandbox-provided `runCommand` hook.
 */
export async function evaluateAssertions(
  assertions: readonly ParsedAssertion[],
  context: AssertionContext,
  options: EvaluateOptions = {},
): Promise<AssertionResult[]> {
  const results: AssertionResult[] = [];
  for (const assertion of assertions) {
    results.push(await evaluateAssertion(assertion, context, options));
  }
  return results;
}

async function evaluateAssertion(
  assertion: ParsedAssertion,
  context: AssertionContext,
  options: EvaluateOptions,
): Promise<AssertionResult> {
  const definition = getAssertionDefinition(assertion.kind);
  const expectation = definition
    ? definition.describe(assertion.spec as never)
    : assertion.kind;

  const base = { expectation, index: assertion.index, kind: assertion.kind };

  if (!definition) {
    return { ...base, observed: null, status: 'skipped', skipReason: `unknown assertion \`${assertion.kind}\`` };
  }

  const unavailable = definition.unavailable?.(context.sandbox);
  if (unavailable) {
    return { ...base, observed: null, skipReason: unavailable, status: 'skipped' };
  }

  try {
    return await evaluate(assertion.kind, assertion.spec, context, options, base);
  } catch (error) {
    return {
      ...base,
      details: { error: error instanceof Error ? error.message : String(error) },
      observed: null,
      status: 'skipped',
      skipReason: 'the assertion could not be evaluated (this is a bug in AgentSnap)',
    };
  }
}

type Base = { expectation: string; index: number; kind: string };

interface Outcome {
  status: AssertionStatus;
  observed: string | null;
  details?: Record<string, unknown>;
  skipReason?: string;
}

async function evaluate(
  kind: string,
  rawSpec: unknown,
  context: AssertionContext,
  options: EvaluateOptions,
  base: Base,
): Promise<AssertionResult> {
  const outcome = await dispatch(kind, rawSpec, context, options);
  return {
    ...base,
    details: outcome.details,
    observed: truncate(outcome.observed),
    skipReason: outcome.skipReason,
    status: outcome.status,
  };
}

async function dispatch(
  kind: string,
  rawSpec: unknown,
  context: AssertionContext,
  options: EvaluateOptions,
): Promise<Outcome> {
  switch (kind) {
    // --- files -------------------------------------------------------------
    case 'file_changed':
      return countOutcome(select(context.filesChanged, rawSpec), rawSpec, 'changed');
    case 'file_created':
      return countOutcome(select(context.filesCreated, rawSpec), rawSpec, 'created');
    case 'file_deleted':
      return countOutcome(select(context.filesDeleted, rawSpec), rawSpec, 'deleted');
    case 'file_not_changed':
      return noneOutcome(select(context.filesChanged, rawSpec), 'modified');
    case 'file_read':
      return countOutcome(select(context.filesRead, rawSpec), rawSpec, 'read');
    case 'file_not_read':
      return noneOutcome(select(context.filesRead, rawSpec), 'read');

    // --- commands ----------------------------------------------------------
    case 'command_executed':
      return countOutcome(
        context.commands.map((entry) => entry.command).filter((command) => matchOne(rawSpec, command)),
        rawSpec,
        'executed',
      );
    case 'command_not_executed':
      return noneOutcome(
        context.commands.map((entry) => entry.command).filter((command) => matchOne(rawSpec, command)),
        'executed',
      );
    case 'command_matches': {
      const matched = context.commands.filter((entry) => matchOne(rawSpec, entry.command));
      const failing = matched.filter((entry) => entry.exitCode !== 0 || entry.timedOut);
      const count = countOutcome(matched.map((entry) => entry.command), rawSpec, 'executed and succeeded');
      if (count.status !== 'passed') return count;
      if (failing.length === 0) {
        return { details: { matched: matched.map((entry) => entry.command) }, observed: `${matched.length} succeeded`, status: 'passed' };
      }
      return {
        details: {
          commands: failing.map((entry) => ({
            command: entry.command,
            exitCode: entry.exitCode,
            timedOut: entry.timedOut,
          })),
        },
        observed: `${failing.length} of ${matched.length} failed (${failing
          .map((entry) => `${entry.command} -> ${entry.exitCode ?? 'timeout'}`)
          .join('; ')})`,
        status: 'failed',
      };
    }
    case 'command_forbidden':
    case 'must_not_execute':
      return noneOutcome(
        context.commands.map((entry) => entry.command).filter((command) => matchOne(rawSpec, command)),
        'executed',
      );

    // --- behavior ----------------------------------------------------------
    case 'max_tool_calls': {
      const limit = rawSpec as number;
      return context.toolCalls <= limit
        ? { details: { limit, toolCalls: context.toolCalls }, observed: `${context.toolCalls} tool calls`, status: 'passed' }
        : { details: { limit, toolCalls: context.toolCalls }, observed: `${context.toolCalls} tool calls (limit ${limit})`, status: 'failed' };
    }
    case 'min_tool_calls': {
      const limit = rawSpec as number;
      return context.toolCalls >= limit
        ? { details: { limit, toolCalls: context.toolCalls }, observed: `${context.toolCalls} tool calls`, status: 'passed' }
        : { details: { limit, toolCalls: context.toolCalls }, observed: `${context.toolCalls} tool calls (need ${limit})`, status: 'failed' };
    }
    case 'max_steps': {
      const limit = rawSpec as number;
      return context.steps <= limit
        ? { details: { limit, steps: context.steps }, observed: `${context.steps} steps`, status: 'passed' }
        : { details: { limit, steps: context.steps }, observed: `${context.steps} steps (limit ${limit})`, status: 'failed' };
    }
    case 'must_ask_confirmation': {
      const asked = context.permissionRequests.length;
      return asked > 0
        ? {
            details: { permissions: context.permissionRequests },
            observed: `${asked} permission request(s): ${context.permissionRequests.map((entry) => entry.tool).join(', ')}`,
            status: 'passed',
          }
        : { details: { permissions: [] }, observed: 'no permission request was recorded', status: 'failed' };
    }
    case 'must_not_ask_confirmation': {
      const asked = context.permissionRequests.length;
      return asked === 0
        ? { details: { permissions: [] }, observed: 'no permission request was recorded', status: 'passed' }
        : {
            details: { permissions: context.permissionRequests },
            observed: `asked for permission ${asked} time(s): ${context.permissionRequests.map((entry) => entry.tool).join(', ')}`,
            status: 'failed',
          };
    }
    case 'tool_used':
    case 'tool_not_used': {
      const name = resolveToolName(context.toolCallCounts, rawSpec);
      const wanted = kind === 'tool_used';
      const count = context.toolCallCounts[name] ?? 0;
      if (wanted === count > 0) {
        return { details: { tool: name, count }, observed: count === 0 ? 'never used' : `used ${count} time(s)`, status: 'passed' };
      }
      return {
        details: { tool: name, count },
        observed: wanted ? `used 0 times` : `used ${count} time(s)`,
        status: 'failed',
      };
    }

    // --- output ------------------------------------------------------------
    case 'output_contains': {
      const spec = normalizeText(rawSpec);
      const found = contains(context.output, spec.text, spec.ignoreCase === true);
      return found
        ? { observed: `found ${JSON.stringify(spec.text)}`, status: 'passed' }
        : { observed: truncate(context.output) ?? '(empty output)', status: 'failed' };
    }
    case 'output_not_contains': {
      const spec = normalizeText(rawSpec);
      const found = contains(context.output, spec.text, spec.ignoreCase === true);
      return found
        ? { observed: `found ${JSON.stringify(spec.text)}`, status: 'failed' }
        : { observed: 'not present', status: 'passed' };
    }
    case 'output_matches': {
      const spec = normalizeText(rawSpec);
      const expression = new RegExp(spec.text, spec.ignoreCase === true ? 'i' : '');
      return expression.test(context.output)
        ? { observed: `matched /${spec.text}/`, status: 'passed' }
        : { observed: truncate(context.output) ?? '(empty output)', status: 'failed' };
    }

    // --- post-run commands -------------------------------------------------
    case 'command_must_pass':
    case 'tests_must_pass': {
      const spec = normalizeRunCommand(rawSpec);
      const command = spec.command ?? options.defaultTestCommand ?? null;
      if (command === null) {
        return {
          observed: null,
          skipReason:
            'no command was configured and AgentSnap could not detect a project test command. Set `command:` explicitly.',
          status: 'skipped',
        };
      }
      const outcome = await context.runCommand(command, spec.timeout ?? 120);
      return {
        details: { command, durationBucket: undefined, exitCode: outcome.exitCode, timedOut: outcome.timedOut },
        observed:
          outcome.exitCode === 0
            ? `\`${command}\` exited 0`
            : `\`${command}\` exited ${outcome.timedOut ? 'timeout' : String(outcome.exitCode)}\n${truncate(outcome.output) ?? ''}`,
        status: outcome.exitCode === 0 ? 'passed' : 'failed',
      };
    }

    // --- security ----------------------------------------------------------
    case 'must_not_read':
      return noneOutcome(select(context.filesRead, rawSpec), 'read');
    case 'must_not_write':
      return noneOutcome(select(context.filesWritten, rawSpec), 'written');
    case 'network_access_forbidden': {
      const attempts = context.networkAttempts;
      return attempts.length === 0
        ? {
            details: { enforcement: context.sandbox.networkBlocked ? 'container network isolation' : 'declared by agent' },
            observed: 'no network access recorded',
            status: 'passed',
          }
        : { details: { urls: attempts }, observed: `network access to ${attempts.join(', ')}`, status: 'failed' };
    }

    default:
      return { observed: null, skipReason: `no evaluator is registered for \`${kind}\``, status: 'skipped' };
  }
}

function select(values: readonly string[], rawSpec: unknown): string[] {
  return values.filter((value) => matchOne(rawSpec, value));
}

function matchOne(rawSpec: unknown, value: string): boolean {
  const matcher = createMatcher(toMatcherSpec(rawSpec));
  return matcher.isMatch(value);
}

function toMatcherSpec(rawSpec: unknown): MatcherSpec {
  if (typeof rawSpec === 'string') return { pattern: rawSpec };
  if (isPlainObject(rawSpec) && typeof rawSpec['pattern'] === 'string') {
    return {
      ignoreCase: rawSpec['ignoreCase'] === true,
      pattern: rawSpec['pattern'],
      regex: rawSpec['regex'] === true,
    };
  }
  return { pattern: '' };
}

function countOutcome(matched: string[], rawSpec: unknown, verb: string): Outcome {
  const spec = toMatcherSpec(rawSpec);
  const count = matched.length;
  const min = readBound(rawSpec, 'min', 1) ?? 1;
  const max = readBound(rawSpec, 'max');

  if (count < min) {
    return {
      details: { matched, pattern: spec.pattern },
      observed: `${count} file/command(s) ${verb}, expected at least ${min}`,
      status: 'failed',
    };
  }
  if (max !== undefined && count > max) {
    return {
      details: { matched, pattern: spec.pattern },
      observed: `${count} file/command(s) ${verb}, expected at most ${max}`,
      status: 'failed',
    };
  }
  return {
    details: { matched, pattern: spec.pattern },
    observed: `${count} ${verb}: ${summarize(matched)}`,
    status: 'passed',
  };
}

function noneOutcome(matched: string[], verb: string): Outcome {
  if (matched.length === 0) {
    return { details: { matched: [] }, observed: `none ${verb}`, status: 'passed' };
  }
  return {
    details: { matched },
    observed: `${matched.length} ${verb}: ${summarize(matched)}`,
    status: 'failed',
  };
}

function readBound(rawSpec: unknown, key: 'min' | 'max', fallback?: number): number | undefined {
  if (isPlainObject(rawSpec) && typeof rawSpec[key] === 'number') return rawSpec[key];
  return fallback;
}

function normalizeText(rawSpec: unknown): { text: string; ignoreCase: boolean } {
  if (typeof rawSpec === 'string') return { ignoreCase: false, text: rawSpec };
  const source = isPlainObject(rawSpec) ? rawSpec : {};
  return {
    ignoreCase: source['ignoreCase'] === true,
    text: typeof source['text'] === 'string' ? source['text'] : '',
  };
}

function normalizeRunCommand(rawSpec: unknown): { command: string | null; timeout: number | undefined } {
  if (rawSpec === true) return { command: null, timeout: undefined };
  if (typeof rawSpec === 'string') return { command: rawSpec, timeout: undefined };
  if (isPlainObject(rawSpec)) {
    return {
      command: typeof rawSpec['command'] === 'string' ? rawSpec['command'] : null,
      timeout: typeof rawSpec['timeout'] === 'number' ? rawSpec['timeout'] : undefined,
    };
  }
  return { command: null, timeout: undefined };
}

/** Extracts the requested tool name from either shorthand or `{ name }` form. */
function normalizeToolName(rawSpec: unknown): string {
  const source = typeof rawSpec === 'string' ? rawSpec : isPlainObject(rawSpec) ? rawSpec['name'] : undefined;
  return typeof source === 'string' ? source : '';
}

/**
 * Resolves a tool-name assertion to the concrete key used in `toolCallCounts`.
 *
 * Adapters disagree on casing conventions, so an exact match wins and a case-insensitive
 * match is the fallback. This keeps `tool_used: read` working against an adapter that
 * reports `Read`.
 */
export function resolveToolName(counts: Record<string, number>, rawSpec: unknown): string {
  const requested = normalizeToolName(rawSpec);
  if (Object.prototype.hasOwnProperty.call(counts, requested)) return requested;
  const lower = requested.toLowerCase();
  const found = Object.keys(counts).find((key) => key.toLowerCase() === lower);
  return found ?? requested;
}

function contains(haystack: string, needle: string, ignoreCase: boolean): boolean {
  if (ignoreCase) return haystack.toLowerCase().includes(needle.toLowerCase());
  return haystack.includes(needle);
}

function summarize(values: string[], limit = 5): string {
  if (values.length === 0) return '[]';
  const shown = values.slice(0, limit).join(', ');
  return values.length > limit ? `${shown}, +${values.length - limit} more` : shown;
}

function truncate(value: string | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  if (value.length <= MAX_OBSERVED_CHARS) return value;
  return `${value.slice(0, MAX_OBSERVED_CHARS)}\u2026 (${value.length - MAX_OBSERVED_CHARS} more characters)`;
}

export { describeMatcher };
