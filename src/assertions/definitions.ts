import type { SandboxCapabilities } from '../sandbox/types.js';
import {
  describeMatcher,
  matchesAny,
  type MatcherSpec,
  validateMatcherSpec,
} from '../utils/matching.js';
import { toPosixPath } from '../utils/paths.js';
import {
  isPlainObject,
  rejectUnknownKeys,
  requireBoolean,
  requireEnum,
  requireNonNegativeNumber,
  requireString,
  type Issue,
} from '../utils/validate.js';

/** An assertion exactly as it appears in YAML: a single-key mapping. */
export type RawAssertion = Record<string, unknown>;

export type AssertionGroup = 'files' | 'commands' | 'behavior' | 'output' | 'tests' | 'security';

/**
 * Everything an assertion needs to decide pass/fail.
 *
 * The context is intentionally read-only and adapter-agnostic: assertions only ever see
 * normalized data produced by the runner, never raw adapter output.
 */
export interface AssertionContext {
  /** Files actually changed during the run (created + modified + deleted). */
  filesChanged: string[];
  filesCreated: string[];
  filesDeleted: string[];
  /** Every file the agent read, resolved relative to the project root. */
  filesRead: string[];
  /** Every file the agent wrote (created or modified). */
  filesWritten: string[];
  commands: Array<{ command: string; exitCode: number | null; timedOut: boolean }>;
  toolCalls: number;
  toolCallCounts: Record<string, number>;
  steps: number;
  permissionRequests: Array<{ tool: string; decision: 'granted' | 'denied' | 'skipped' }>;
  /** Path patterns that the sandbox or config declared forbidden. */
  forbidden: { read: MatcherSpec[]; write: MatcherSpec[]; execute: MatcherSpec[] };
  /** URLs the agent attempted to reach, as reported by the runtime or sandbox. */
  networkAttempts: string[];
  /** Final assistant output, already redacted. */
  output: string;
  /** Runs a command in the post-agent workspace; used by `*_must_pass` assertions. */
  runCommand: (command: string, timeoutSeconds: number) => Promise<{
    exitCode: number | null;
    output: string;
    timedOut: boolean;
  }>;
  sandbox: SandboxCapabilities;
}

export interface AssertionDefinition<S = unknown> {
  kind: string;
  group: AssertionGroup;
  /** One-line summary used by `agentsnap list --verbose`. */
  summary: string;
  /**
   * Returns a skip reason when the active sandbox cannot support the assertion
   * (e.g. network assertions under the local sandbox). `null` means evaluable.
   */
  unavailable?: (capabilities: SandboxCapabilities) => string | null;
  validate(spec: unknown): Issue[];
  describe(spec: S): string;
}

const DEFINITIONS = new Map<string, AssertionDefinition<never>>();

function define<S>(definition: AssertionDefinition<S>): void {
  DEFINITIONS.set(definition.kind, definition as unknown as AssertionDefinition<never>);
}

export function getAssertionDefinition(kind: string): AssertionDefinition | undefined {
  return DEFINITIONS.get(kind);
}

export function listAssertionKinds(): string[] {
  return [...DEFINITIONS.keys()].sort();
}

export function assertionsByGroup(): Array<{ group: AssertionGroup; kinds: string[] }> {
  const groups: AssertionGroup[] = ['files', 'commands', 'behavior', 'output', 'tests', 'security'];
  return groups.map((group) => ({
    group,
    kinds: [...DEFINITIONS.values()]
      .filter((definition) => definition.group === group)
      .map((definition) => definition.kind)
      .sort(),
  }));
}

export function describeAssertion(kind: string, spec: unknown): string {
  const definition = DEFINITIONS.get(kind);
  if (!definition) return kind;
  return definition.describe(spec as never);
}

// ---------------------------------------------------------------------------
// Files
// ---------------------------------------------------------------------------

interface CountSpec {
  pattern: string;
  regex?: boolean;
  ignoreCase?: boolean;
  min?: number;
  max?: number;
}

const COUNT_KEYS = ['pattern', 'regex', 'ignoreCase', 'min', 'max'] as const;

function validateCountSpec(spec: unknown): Issue[] {
  if (typeof spec === 'string') return validateMatcherSpec(spec).map((m) => ({ path: '', message: m }));
  if (!isPlainObject(spec)) {
    return [{ path: '', message: 'expected a glob pattern string or a mapping with `pattern`.' }];
  }
  const problems: Issue[] = rejectUnknownKeys(spec, COUNT_KEYS, '');
  if (spec.pattern === undefined) problems.push({ path: 'pattern', message: 'is required.' });
  problems.push(...validateMatcherSpec(spec.pattern).map((m) => ({ path: 'pattern', message: m })));
  if (spec.min !== undefined) {
    problems.push(
      ...requireNonNegativeNumber(spec.min, 'min', { integer: true }).map((i) => ({
        ...i,
        message: i.message,
      })),
    );
  }
  if (spec.max !== undefined) {
    problems.push(...requireNonNegativeNumber(spec.max, 'max', { integer: true }));
  }
  if (spec.regex !== undefined) problems.push(...requireBoolean(spec.regex, 'regex'));
  if (spec.ignoreCase !== undefined) problems.push(...requireBoolean(spec.ignoreCase, 'ignoreCase'));
  return problems;
}

function countLabel(spec: CountSpec): string {
  const matcher = describeMatcher(spec);
  if (spec.min !== undefined && spec.max !== undefined) return `${spec.min}-${spec.max} files matching ${matcher}`;
  if (spec.min !== undefined) return `at least ${spec.min} file(s) matching ${matcher}`;
  if (spec.max !== undefined) return `at most ${spec.max} file(s) matching ${matcher}`;
  return `a file matching ${matcher}`;
}

function validateMatcherList(spec: unknown, key: string): Issue[] {
  const problems: Issue[] = [];
  const list = Array.isArray(spec) ? spec : [spec];
  list.forEach((entry, index) => {
    const path = list === spec ? key : `${key}[${index}]`;
    const entryProblems = validateCountSpec(entry);
    for (const problem of entryProblems) problems.push({ ...problem, path: `${path}.${problem.path}`.replace(/\.$/, '') });
  });
  return problems;
}

define<CountSpec>({
  describe: (spec) => `${countLabel(normalizeCountSpec(spec))} must be created or modified`,
  group: 'files',
  kind: 'file_changed',
  summary: 'Files matching a pattern are created or modified by the agent.',
  validate: (spec) => validateCountSpec(spec),
});

define<CountSpec>({
  describe: (spec) => `${countLabel(normalizeCountSpec(spec))} must be created`,
  group: 'files',
  kind: 'file_created',
  summary: 'Files matching a pattern are newly created.',
  validate: (spec) => validateCountSpec(spec),
});

define<CountSpec>({
  describe: (spec) => `${countLabel(normalizeCountSpec(spec))} must be deleted`,
  group: 'files',
  kind: 'file_deleted',
  summary: 'Files matching a pattern are removed.',
  validate: (spec) => validateCountSpec(spec),
});

define<CountSpec>({
  describe: (spec) => `no file matching ${describeMatcher(normalizeCountSpec(spec))} may change`,
  group: 'files',
  kind: 'file_not_changed',
  summary: 'No file matching a pattern may be created, modified, or deleted.',
  validate: (spec) => validateCountSpec(spec),
});

define<CountSpec>({
  describe: (spec) => `the agent must read ${countLabel(normalizeCountSpec(spec))}`,
  group: 'files',
  kind: 'file_read',
  summary: 'The agent reads at least one file matching a pattern.',
  validate: (spec) => validateCountSpec(spec),
});

define<CountSpec>({
  describe: (spec) => `the agent must not read any file matching ${describeMatcher(normalizeCountSpec(spec))}`,
  group: 'files',
  kind: 'file_not_read',
  summary: 'The agent never reads a file matching a pattern.',
  validate: (spec) => validateCountSpec(spec),
});

function normalizeCountSpec(spec: unknown): CountSpec {
  if (typeof spec === 'string') return { pattern: spec };
  const source = isPlainObject(spec) ? spec : {};
  return {
    ignoreCase: source.ignoreCase === true,
    max: typeof source.max === 'number' ? source.max : undefined,
    min: typeof source.min === 'number' ? source.min : undefined,
    pattern: typeof source.pattern === 'string' ? source.pattern : '',
    regex: source.regex === true,
  };
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------

define<CountSpec>({
  describe: (spec) => `the agent must run ${countLabel(normalizeCountSpec(spec))}`,
  group: 'commands',
  kind: 'command_executed',
  summary: 'The agent executes a shell command matching a pattern.',
  validate: (spec) => validateCountSpec(spec),
});

define<CountSpec>({
  describe: (spec) => `the agent must not run any command matching ${describeMatcher(normalizeCountSpec(spec))}`,
  group: 'commands',
  kind: 'command_not_executed',
  summary: 'The agent never executes a command matching a pattern.',
  validate: (spec) => validateCountSpec(spec),
});

define<CountSpec>({
  describe: (spec) => `the agent must run ${countLabel(normalizeCountSpec(spec))} and it must succeed`,
  group: 'commands',
  kind: 'command_matches',
  summary: 'The agent executes a matching command and it exits successfully.',
  validate: (spec) => validateCountSpec(spec),
});

define<CountSpec>({
  describe: (spec) => `no command matching ${describeMatcher(normalizeCountSpec(spec))} may be executed`,
  group: 'commands',
  kind: 'command_forbidden',
  summary: 'Security: a command pattern is forbidden.',
  validate: (spec) => validateCountSpec(spec),
});

define<CountSpec>({
  describe: (spec) => `the agent must not execute any command matching ${describeMatcher(normalizeCountSpec(spec))}`,
  group: 'security',
  kind: 'must_not_execute',
  summary: 'Security: the agent must not execute a command matching a pattern.',
  validate: (spec) => validateCountSpec(spec),
});

// ---------------------------------------------------------------------------
// Behavior
// ---------------------------------------------------------------------------

define<number>({
  describe: (spec) => `the agent must make at most ${spec} tool calls`,
  group: 'behavior',
  kind: 'max_tool_calls',
  summary: 'Caps the number of agentic tool calls.',
  validate: (spec) => requireNonNegativeNumber(spec, '', { integer: true, min: 0 }),
});

define<number>({
  describe: (spec) => `the agent must make at least ${spec} tool calls`,
  group: 'behavior',
  kind: 'min_tool_calls',
  summary: 'Requires a minimum amount of agent activity.',
  validate: (spec) => requireNonNegativeNumber(spec, '', { integer: true, min: 0 }),
});

define<number>({
  describe: (spec) => `the agent must take at most ${spec} steps`,
  group: 'behavior',
  kind: 'max_steps',
  summary: 'Caps the number of assistant turns in the agent loop.',
  validate: (spec) => requireNonNegativeNumber(spec, '', { integer: true, min: 0 }),
});

define<true>({
  describe: () => 'the agent must ask the user for confirmation before acting',
  group: 'behavior',
  kind: 'must_ask_confirmation',
  summary: 'The agent requests permission at least once.',
  validate: (spec) => (spec === true ? [] : [{ path: '', message: 'expected `true`.' }]),
});

define<true>({
  describe: () => 'the agent must not ask the user for confirmation',
  group: 'behavior',
  kind: 'must_not_ask_confirmation',
  summary: 'The agent runs fully autonomously.',
  validate: (spec) => (spec === true ? [] : [{ path: '', message: 'expected `true`.' }]),
});

interface ToolNameSpec {
  name: string;
  min?: number;
}

define<ToolNameSpec>({
  describe: (spec) => `the agent must use the ${spec.name} tool`,
  group: 'behavior',
  kind: 'tool_used',
  summary: 'The agent invokes a named tool.',
  validate: (spec) => {
    const value = typeof spec === 'string' ? { name: spec } : spec;
    if (!isPlainObject(value)) return [{ path: '', message: 'expected a tool name or `{ name: ... }`.' }];
    return [...rejectUnknownKeys(value, ['name', 'min'], ''), ...requireString(value.name, 'name')];
  },
});

define<ToolNameSpec>({
  describe: (spec) => `the agent must not use the ${spec.name} tool`,
  group: 'behavior',
  kind: 'tool_not_used',
  summary: 'The agent never invokes a named tool.',
  validate: (spec) => {
    const value = typeof spec === 'string' ? { name: spec } : spec;
    if (!isPlainObject(value)) return [{ path: '', message: 'expected a tool name or `{ name: ... }`.' }];
    return [...rejectUnknownKeys(value, ['name'], ''), ...requireString(value.name, 'name')];
  },
});

// ---------------------------------------------------------------------------
// Output
// ---------------------------------------------------------------------------

interface TextSpec {
  text: string;
  ignoreCase?: boolean;
}

define<TextSpec>({
  describe: (spec) => `the agent output must contain ${JSON.stringify(normalizeTextSpec(spec).text)}`,
  group: 'output',
  kind: 'output_contains',
  summary: 'Substring check on the final agent message.',
  validate: (spec) => validateTextSpec(spec),
});

define<TextSpec>({
  describe: (spec) => `the agent output must not contain ${JSON.stringify(normalizeTextSpec(spec).text)}`,
  group: 'output',
  kind: 'output_not_contains',
  summary: 'Forbidden substring check on the final agent message.',
  validate: (spec) => validateTextSpec(spec),
});

define<TextSpec>({
  describe: (spec) => `the agent output must match /${normalizeTextSpec(spec).text}/`,
  group: 'output',
  kind: 'output_matches',
  summary: 'Regular-expression check on the final agent message.',
  validate: (spec) => {
    const problems = validateTextSpec(spec);
    const text = normalizeTextSpec(spec).text;
    if (text) {
      try {
        new RegExp(text, 'i');
      } catch (error) {
        problems.push({
          path: 'text',
          message: `invalid regular expression: ${error instanceof Error ? error.message : String(error)}`,
        });
      }
    }
    return problems;
  },
});

function validateTextSpec(spec: unknown): Issue[] {
  if (typeof spec === 'string') return spec.trim() === '' ? [{ path: '', message: 'must not be empty.' }] : [];
  if (!isPlainObject(spec)) {
    return [{ path: '', message: 'expected a string or a mapping with `text`.' }];
  }
  const problems = rejectUnknownKeys(spec, ['text', 'ignoreCase'], '');
  problems.push(...requireString(spec.text, 'text'));
  if (spec.ignoreCase !== undefined) problems.push(...requireBoolean(spec.ignoreCase, 'ignoreCase'));
  return problems;
}

function normalizeTextSpec(spec: unknown): TextSpec {
  if (typeof spec === 'string') return { text: spec };
  const source = isPlainObject(spec) ? spec : {};
  return {
    ignoreCase: source.ignoreCase === true,
    text: typeof source.text === 'string' ? source.text : '',
  };
}

// ---------------------------------------------------------------------------
// Tests / post-run commands
// ---------------------------------------------------------------------------

const COMMAND_RUN_KEYS = ['command', 'timeout'] as const;

interface CommandRunSpec {
  command: string;
  timeout?: number;
}

define<CommandRunSpec>({
  describe: (spec) => `\`${spec.command}\` must exit 0 after the agent finishes`,
  group: 'tests',
  kind: 'command_must_pass',
  summary: 'Runs a command in the post-agent workspace and requires exit code 0.',
  validate: (spec) => {
    const value = isPlainObject(spec) ? spec : typeof spec === 'string' ? { command: spec } : {};
    const problems = isPlainObject(spec) ? rejectUnknownKeys(spec, COMMAND_RUN_KEYS, '') : [];
    problems.push(...requireString(value.command, 'command'));
    if (value.timeout !== undefined) {
      problems.push(...requireNonNegativeNumber(value.timeout, 'timeout', { min: 1 }));
    }
    return problems;
  },
});

define<CommandRunSpec>({
  describe: (spec) => `the project's test suite (\`${spec.command}\`) must pass after the agent finishes`,
  group: 'tests',
  kind: 'tests_must_pass',
  summary:
    'Runs the project test command (auto-detected, or `command`) after the agent finishes and requires exit code 0.',
  validate: (spec) => {
    if (spec === true) return [];
    const value = isPlainObject(spec) ? spec : typeof spec === 'string' ? { command: spec } : {};
    const problems = isPlainObject(spec) ? rejectUnknownKeys(spec, COMMAND_RUN_KEYS, '') : [];
    problems.push(...requireString(value.command, 'command'));
    if (value.timeout !== undefined) {
      problems.push(...requireNonNegativeNumber(value.timeout, 'timeout', { min: 1 }));
    }
    return problems;
  },
});

// ---------------------------------------------------------------------------
// Security
// ---------------------------------------------------------------------------

define<CountSpec>({
  describe: (spec) => `the agent must not read any file matching ${describeMatcher(normalizeCountSpec(spec))}`,
  group: 'security',
  kind: 'must_not_read',
  summary: 'Security: the agent must not read a path pattern.',
  validate: (spec) => validateCountSpec(spec),
});

define<CountSpec>({
  describe: (spec) => `the agent must not write any file matching ${describeMatcher(normalizeCountSpec(spec))}`,
  group: 'security',
  kind: 'must_not_write',
  summary: 'Security: the agent must not create or modify a path pattern.',
  validate: (spec) => validateCountSpec(spec),
});

define<true>({
  describe: () => 'the agent must not access the network',
  group: 'security',
  kind: 'network_access_forbidden',
  summary: 'Security: requires a sandbox that can block network egress.',
  unavailable: (capabilities) =>
    capabilities.networkBlocked
      ? null
      : 'the active sandbox cannot block network egress; use `sandbox.type: docker` with `network: none` to enforce this',
  validate: (spec) => (spec === true ? [] : [{ path: '', message: 'expected `true`.' }]),
});

/** Declared forbidden-path policy, validated with the same rules as assertions. */
export function validateForbiddenPolicy(policy: unknown, path: string): Issue[] {
  if (policy === undefined) return [];
  if (!isPlainObject(policy)) return [{ path, message: 'expected a mapping.' }];
  const problems: Issue[] = rejectUnknownKeys(policy, ['read', 'write', 'execute', 'network'], path);
  for (const key of ['read', 'write', 'execute'] as const) {
    if (policy[key] === undefined) continue;
    problems.push(...validateMatcherList(policy[key], joinLocal(path, key)));
  }
  if (policy.network !== undefined && policy.network !== 'forbid' && policy.network !== 'allow') {
    problems.push(
      ...requireEnum(policy.network, ['forbid', 'allow'] as const, joinLocal(path, 'network')),
    );
  }
  return problems;
}

function joinLocal(base: string, key: string): string {
  return base ? `${base}.${key}` : key;
}

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

export interface ParsedAssertion {
  kind: string;
  spec: unknown;
  index: number;
}

/** Validates a list of raw assertions, returning parsed entries plus issues. */
export function parseAssertions(raw: unknown, basePath: string): {
  assertions: ParsedAssertion[];
  issues: Issue[];
} {
  const assertions: ParsedAssertion[] = [];
  const issues: Issue[] = [];

  if (raw === undefined) return { assertions, issues };
  if (!Array.isArray(raw)) {
    issues.push({ path: basePath, message: 'expected a list of assertions.' });
    return { assertions, issues };
  }

  raw.forEach((entry, index) => {
    const path = `${basePath}[${index}]`;
    if (!isPlainObject(entry)) {
      issues.push({ path, message: 'expected a mapping with exactly one assertion name.' });
      return;
    }
    const keys = Object.keys(entry);
    if (keys.length !== 1) {
      issues.push({
        path,
        message:
          keys.length === 0
            ? 'is empty; every assertion must name exactly one expectation, e.g. `- file_changed: "src/**"`.'
            : `must name exactly one expectation, found ${keys.length} (${keys.join(', ')}). Split them into separate list entries.`,
      });
      return;
    }
    const kind = keys[0] ?? '';
    const spec = entry[kind];
    const definition = DEFINITIONS.get(kind);
    if (!definition) {
      issues.push({
        hint: `Known assertions: ${listAssertionKinds().map((k) => `\`${k}\``).join(', ')}.`,
        message: `unknown assertion \`${kind}\`.`,
        path: joinLocal(path, kind),
      });
      return;
    }
    const specIssues = definition.validate(spec).map((problem) => ({
      ...problem,
      path: joinLocal(joinLocal(path, kind), problem.path).replace(/\.$/, ''),
    }));
    if (specIssues.length > 0) {
      issues.push(...specIssues);
      return;
    }
    assertions.push({ index, kind, spec });
  });

  return { assertions, issues };
}

/** Sorted unique helper shared by evaluators. */
export function uniqueSorted(values: Iterable<string>): string[] {
  return [...new Set(values)].map(toPosixPath).sort();
}

/** Convenience re-exports so evaluators do not import matching directly. */
export { describeMatcher, matchesAny, type MatcherSpec };
