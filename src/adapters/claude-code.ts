import { toPosixPath } from '../utils/paths.js';
import { resolveExecutable } from './executable.js';
import { probeVersion, versionAtLeast } from './version.js';
import type {
  AgentAdapter,
  AgentCapabilities,
  AgentEventFragment,
  AgentResultFragment,
  AgentRunInput,
  DetectContext,
  DetectionResult,
} from './types.js';

/**
 * Minimum Claude Code versions for individual flags.
 *
 * Passing an unknown flag makes `claude -p` fail immediately with an option error, which is
 * indistinguishable from a genuine agent failure. Version gating keeps older installs
 * working, and `agentsnap doctor` reports which flags were enabled or skipped.
 */
export const CLAUDE_MINIMUMS = {
  costLimit: '2.1.217',
  forwardSubagentText: '2.1.211',
  permissionPrompts: '2.1.259',
} as const;

export const DEFAULT_CLAUDE_COMMAND = 'claude';

const DOCS_URL = 'https://code.claude.com/docs/en/cli-reference';

/**
 * Adapter for the Claude Code command-line agent.
 *
 * AgentSnap drives the documented headless interface only:
 *   `claude -p <prompt> --output-format stream-json --verbose`
 * and normalizes the resulting newline-delimited JSON stream into AgentSnap events.
 *
 * Deliberate choices:
 *   - bare mode is never enabled automatically, because the point of these tests is to
 *     observe the effect of CLAUDE.md, AGENTS.md, skills and hooks. It is available as
 *     `agent.bare: true` for projects that want CI-strict context.
 *   - `--dangerously-skip-permissions` is never used and is not configurable.
 */
export const claudeCodeAdapter: AgentAdapter = {
  buildArgv,
  capabilities(): AgentCapabilities {
    return {
      granularEvents: true,
      reportsPermissionDecisions: true,
      reportsUsage: true,
      supportsCostLimit: true,
      supportsModelSelection: true,
      supportsToolRestrictions: true,
    };
  },
  detect,
  displayName: 'Claude Code',
  /**
   * The permission-prompt flag is the newest requirement, so it is the floor for the adapter
   * as a whole: below it, unattended runs cannot be made non-interactive.
   */
  minimumVersion: () => CLAUDE_MINIMUMS.permissionPrompts,
  docsUrl: DOCS_URL,
  execution: 'subprocess',
  name: 'claude-code',
  parseEvent,
  parseResult,
};

async function detect(context: DetectContext): Promise<DetectionResult> {
  const command = context.config.command ?? DEFAULT_CLAUDE_COMMAND;
  const executable = await resolveExecutable(command, context.env, context.cwd);
  if (executable === null) {
    return {
      available: false,
      executablePath: null,
      notes: [],
      problems: [
        `\`${command}\` was not found on PATH.`,
        'Install Claude Code, or set `agent.command` to its absolute path.',
      ],
      version: null,
    };
  }

  const probe = await probeVersion(executable.path, context.env);
  const problems: string[] = [];
  const notes: string[] = [`executable: ${executable.path}`];

  if (probe.version === null) {
    problems.push(`\`${command} --version\` did not return a readable version.`);
  } else {
    notes.push(`version: ${probe.version}`);
    if (!versionAtLeast(probe.version, CLAUDE_MINIMUMS.permissionPrompts)) {
      notes.push(
        `older than ${CLAUDE_MINIMUMS.permissionPrompts}: unattended runs cannot use \`--permission-prompts none\`, ` +
          'so a permission prompt may be auto-denied instead of reported',
      );
    }
  }

  if (!hasCredentials(context.env)) {
    notes.push(
      'no ANTHROPIC_* credential found in the forwarded environment; the run will fail unless the CLI is logged in',
    );
  }

  return {
    available: problems.length === 0,
    executablePath: executable.path,
    notes,
    problems,
    version: probe.version,
  };
}

function hasCredentials(env: NodeJS.ProcessEnv): boolean {
  return ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'CLAUDE_CODE_OAUTH_TOKEN'].some(
    (name) => (env[name] ?? '') !== '',
  );
}

/**
 * Builds the full argv for one run.
 *
 * The prompt is passed as a single argv element, never interpolated into a shell string.
 */
export async function buildArgv(input: AgentRunInput): Promise<string[]> {
  const { agent, prompt } = input;
  const argv: string[] = [
    agent.command ?? DEFAULT_CLAUDE_COMMAND,
    '-p',
    prompt,
    '--output-format',
    'stream-json',
    '--verbose',
  ];

  if (agent.model) argv.push('--model', agent.model);
  if (agent.permissionMode) argv.push('--permission-mode', agent.permissionMode);
  if (agent.allowedTools?.length) argv.push('--allowedTools', agent.allowedTools.join(','));
  if (agent.disallowedTools?.length) argv.push('--disallowedTools', agent.disallowedTools.join(','));
  if (agent.appendSystemPrompt) argv.push('--append-system-prompt', agent.appendSystemPrompt);
  if (agent.bare) argv.push('--bare');
  if (agent.maxTurns !== undefined) argv.push('--max-turns', String(agent.maxTurns));
  if (agent.args?.length) argv.push(...agent.args);

  const version = await resolveVersion(input);

  if (input.maxCostUsd !== null && versionAtLeast(version, CLAUDE_MINIMUMS.costLimit)) {
    argv.push('--max-budget-usd', input.maxCostUsd.toFixed(4));
  }

  // An unattended run has nobody to answer an approval prompt. On versions that support
  // it, tell the CLI so explicitly instead of relying on implicit auto-denial.
  if (versionAtLeast(version, CLAUDE_MINIMUMS.permissionPrompts)) {
    argv.push('--permission-prompts', 'none');
  }

  return argv;
}

async function resolveVersion(input: AgentRunInput): Promise<string | null> {
  const probe = await probeVersion(input.agent.command ?? DEFAULT_CLAUDE_COMMAND, input.env);
  return probe.version;
}

// ---------------------------------------------------------------------------
// stream-json translation
// ---------------------------------------------------------------------------

type Record_ = Record<string, unknown>;

const FILE_READ_TOOLS = new Set(['Read', 'NotebookRead']);
const FILE_WRITE_TOOLS = new Set(['Write', 'Edit', 'MultiEdit', 'NotebookEdit']);
const BASH_TOOLS = new Set(['Bash', 'KillShell']);

/**
 * Translates one `stream-json` record into normalized events.
 *
 * Unknown record shapes are ignored rather than treated as failures: the CLI adds event
 * types over time, and a new informational event must never fail a user's test.
 */
export function parseEvent(record: unknown): AgentEventFragment[] {
  if (!isRecord(record)) return [];

  switch (record['type']) {
    case 'system':
      return parseSystem(record);
    case 'assistant':
      return parseAssistant(record);
    case 'user':
      return parseUser(record);
    default:
      return [];
  }
}

function parseSystem(entry: Record_): AgentEventFragment[] {
  const subtype = typeof entry['subtype'] === 'string' ? entry['subtype'] : '';

  if (subtype === 'init') {
    return [
      {
        extra: { mcpServers: entry['mcp_servers'], tools: entry['tools'] },
        kind: 'agent_started',
        model: typeof entry['model'] === 'string' ? entry['model'] : undefined,
        sessionId: typeof entry['session_id'] === 'string' ? entry['session_id'] : undefined,
      },
    ];
  }

  if (subtype === 'permission_denied') {
    const tool = typeof entry['tool_name'] === 'string' ? entry['tool_name'] : 'unknown';
    const toolUseId = typeof entry['tool_use_id'] === 'string' ? entry['tool_use_id'] : undefined;
    return [
      {
        decision: 'denied',
        input: toolUseId ? { toolUseId } : undefined,
        kind: 'permission_request',
        tool,
      },
    ];
  }

  if (subtype === 'api_retry') {
    const attempt = typeof entry['attempt'] === 'number' ? entry['attempt'] : '?';
    return [
      {
        fatal: false,
        kind: 'error',
        message: `API retry (attempt ${attempt}): ${String(entry['error'] ?? 'unknown error')}`,
      },
    ];
  }

  return [];
}

function parseAssistant(entry: Record_): AgentEventFragment[] {
  const fragments: AgentEventFragment[] = [];

  for (const block of contentBlocks(entry)) {
    if (block['type'] === 'text' && typeof block['text'] === 'string') {
      if (block['text'].trim() !== '') fragments.push({ kind: 'message', role: 'assistant', text: block['text'] });
      continue;
    }
    if (block['type'] !== 'tool_use') continue;

    const tool = typeof block['name'] === 'string' ? block['name'] : 'unknown';
    const toolUseId = typeof block['id'] === 'string' ? block['id'] : undefined;
    const input = isRecord(block['input']) ? block['input'] : {};
    fragments.push({ input, kind: 'tool_call_started', tool, toolUseId });

    const path = readString(input, 'file_path') ?? readString(input, 'notebook_path');
    if (path) {
      const normalized = normalizeAgentPath(path);
      if (FILE_READ_TOOLS.has(tool)) fragments.push({ kind: 'file_read', path: normalized });
      if (FILE_WRITE_TOOLS.has(tool)) fragments.push({ kind: 'file_written', path: normalized });
    }

    if (BASH_TOOLS.has(tool)) {
      const command = readString(input, 'command');
      if (command) fragments.push({ command, kind: 'command_started' });
    }
  }

  return fragments;
}

function parseUser(entry: Record_): AgentEventFragment[] {
  const fragments: AgentEventFragment[] = [];

  for (const block of contentBlocks(entry)) {
    if (block['type'] !== 'tool_result') continue;
    const output = flattenToolResult(block['content']);
    fragments.push({
      kind: 'tool_call_finished',
      ok: block['is_error'] !== true,
      output,
      // The matching tool name is filled in by the runner, which pairs calls with results.
      tool: 'unknown',
      toolUseId: typeof block['tool_use_id'] === 'string' ? block['tool_use_id'] : undefined,
    });
  }

  return fragments;
}

export function parseResult(record: unknown): AgentResultFragment | null {
  if (!isRecord(record) || record['type'] !== 'result') return null;

  const isError = record['is_error'] === true || record['subtype'] === 'error_during_execution';
  const errors: string[] = [];

  const denials = record['permission_denials'];
  if (Array.isArray(denials)) {
    for (const denial of denials) {
      if (typeof denial === 'string') errors.push(`permission denied: ${denial}`);
      else if (isRecord(denial)) {
        errors.push(`permission denied: ${readString(denial, 'tool_name') ?? 'unknown tool'}`);
      }
    }
  }
  const errorText = typeof record['error'] === 'string' ? record['error'] : undefined;
  if (errorText) errors.push(errorText);

  const output = typeof record['result'] === 'string' ? record['result'] : undefined;
  if (isError && errors.length === 0) {
    // A failed run that reports no reason is the most frustrating failure mode there is.
    // The CLI usually puts the explanation in `result`, so surface that rather than nothing.
    errors.push(output?.trim() || `the runtime reported ${String(record['subtype'] ?? 'an error')}`);
  }

  const usage = readUsage(record['usage']);
  const cost = typeof record['total_cost_usd'] === 'number' ? record['total_cost_usd'] : undefined;

  const result: AgentResultFragment = {
    errors,
    ok: !isError,
    output,
    usage: cost === undefined ? usage : { ...usage, costUsd: cost },
  };
  if (typeof record['num_turns'] === 'number') result.numTurns = record['num_turns'];
  if (typeof record['duration_ms'] === 'number') result.durationMs = record['duration_ms'];
  if (typeof record['session_id'] === 'string') result.sessionId = record['session_id'];
  if (typeof record['model'] === 'string') result.model = record['model'];
  return result;
}

function readUsage(value: unknown): AgentResultFragment['usage'] {
  if (!isRecord(value)) return undefined;
  const usage = {
    cacheCreationTokens: readNumber(value, 'cache_creation_input_tokens'),
    cacheReadTokens: readNumber(value, 'cache_read_input_tokens'),
    inputTokens: readNumber(value, 'input_tokens'),
    outputTokens: readNumber(value, 'output_tokens'),
  };
  return Object.values(usage).some((entry) => entry !== undefined) ? usage : undefined;
}

function contentBlocks(entry: Record_): Array<Record_> {
  const message = entry['message'];
  if (!isRecord(message)) return [];
  const content = message['content'];
  return Array.isArray(content) ? content.filter(isRecord) : [];
}

function flattenToolResult(content: unknown): string | undefined {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return undefined;
  const parts = content
    .map((entry) => (isRecord(entry) && typeof entry['text'] === 'string' ? entry['text'] : ''))
    .filter((text) => text !== '');
  return parts.length > 0 ? parts.join('\n') : undefined;
}

/**
 * Agent-reported paths become POSIX-style here; the runner converts them to
 * workspace-relative paths once it knows the sandbox root.
 */
export function normalizeAgentPath(path: string): string {
  return toPosixPath(path).replace(/^\.\//, '');
}

function isRecord(value: unknown): value is Record_ {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readString(source: Record_, key: string): string | undefined {
  const value = source[key];
  return typeof value === 'string' && value !== '' ? value : undefined;
}

function readNumber(source: Record_, key: string): number | undefined {
  const value = source[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}
