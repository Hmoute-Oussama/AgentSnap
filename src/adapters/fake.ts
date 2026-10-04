import { setTimeout as delay } from 'node:timers/promises';
import { relativePosix, toPosixPath } from '../utils/paths.js';
import { tokenizeCommand } from '../sandbox/exec.js';
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
 * Deterministic stub agent used to test AgentSnap itself.
 *
 * This is not a mock of an AI: it is a real, fully working agent loop that performs actual
 * reads, writes and command executions inside the sandbox, driven by directives written in
 * the test prompt. That makes AgentSnap's own test suite deterministic and free, which in
 * turn means CI can assert on real behaviour instead of on AgentSnap's own bugs.
 *
 * Directives are single lines in the prompt:
 *
 *   read: <path>              read a file and report it
 *   write: <path> = <text>    create or overwrite a file
 *   append: <path> = <text>   append to a file
 *   delete: <path>            delete a file
 *   exec: <command>           run a command in the sandbox workspace
 *   ask: <tool>               request permission for a tool
 *   network: <url>            record a network access attempt
 *   fail: <message>           end the run with a non-fatal error
 *   text: <message>           append assistant text to the final output
 *   hang                     block until the run timeout fires
 *
 * Everything not written as a directive is treated as the agent's final message, so a
 * prompt with no directives simply produces that message.
 */
export const FAKE_DIRECTIVE = /^\s*(read|write|append|delete|exec|ask|network|fail|text|hang)\s*:\s*(.*)$/i;

/**
 * `hang` is the one directive that reads naturally without a colon, so both `hang` and
 * `hang:` are accepted.
 */
const FAKE_HANG = /^\s*hang\s*:?\s*$/i;

/** Parses one prompt line into a directive, or `null` when the line is plain assistant text. */
function parseDirective(line: string): { action: string; value: string } | null {
  if (FAKE_HANG.test(line)) return { action: 'hang', value: '' };
  const match = FAKE_DIRECTIVE.exec(line);
  if (!match) return null;
  return { action: (match[1] ?? '').toLowerCase(), value: (match[2] ?? '').trim() };
}

export const fakeAdapter: AgentAdapter = {
  buildArgv: async () => {
    throw new Error('The fake adapter runs in-process and does not build a command line.');
  },
  capabilities(): AgentCapabilities {
    return {
      granularEvents: true,
      reportsPermissionDecisions: true,
      reportsUsage: false,
      supportsCostLimit: false,
      supportsModelSelection: false,
      supportsToolRestrictions: false,
    };
  },
  detect: detectFake,
  displayName: 'Fake (deterministic stub)',
  docsUrl: 'https://github.com/Hmoute-Oussama/AgentSnap/blob/main/docs/adapters.md#fake',
  execution: 'in-process',
  name: 'fake',
  parseEvent: () => [],
  parseResult: () => null,
  run: runFakeAgent,
};

async function detectFake(context: DetectContext): Promise<DetectionResult> {
  void context;
  return {
    available: true,
    executablePath: null,
    notes: ['runs inside AgentSnap; performs real sandbox reads, writes and commands'],
    problems: [],
    version: '1.0.0',
  };
}

/**
 * Executes a scripted fake-agent run against a real sandbox.
 *
 * Kept separate from the adapter object so unit and integration tests can drive it without
 * constructing a full `AgentRunInput`.
 */
export async function runFakeAgent(input: AgentRunInput): Promise<AgentResultFragment> {
  const { sandbox, prompt } = input;
  const api = sandbox.api();
  const root = sandbox.root;
  const relative = (path: string): string => {
    const cleaned = toPosixPath(path.trim());
    const rel = relativePosix(root, cleaned);
    return rel ?? cleaned;
  };

  const errors: string[] = [];
  const outputParts: string[] = [];
  let ok = true;
  let actions = 0;
  let toolIndex = 0;
  let timedOut = false;

  const emit = (fragment: AgentEventFragment): void => {
    input.emit(fragment);
  };

  for (const rawLine of prompt.split(/\r?\n/)) {
    const line = rawLine.trim();
    const directive = parseDirective(rawLine);

    if (!directive) {
      if (line !== '' && !isDirectiveLike(line)) outputParts.push(line);
      continue;
    }

    const { action, value } = directive;
    toolIndex += 1;
    const toolUseId = `fake_${toolIndex}`;

    switch (action) {
      case 'read': {
        actions += 1;
        const path = relative(value);
        let contents = '';
        let readOk = true;
        try {
          contents = await api.readTextFile(path);
        } catch (error) {
          readOk = false;
          contents = error instanceof Error ? error.message : String(error);
        }
        emit({ input: { file_path: path }, kind: 'tool_call_started', tool: 'Read', toolUseId });
        emit({ kind: 'file_read', path });
        emit({ kind: 'tool_call_finished', ok: readOk, output: contents, tool: 'Read', toolUseId });
        outputParts.push(`${readOk ? 'read' : 'failed to read'} ${path}`);
        break;
      }

      case 'write':
      case 'append': {
        actions += 1;
        const separator = value.indexOf('=');
        const path = relative(separator === -1 ? value : value.slice(0, separator).trim());
        const text = separator === -1 ? '' : value.slice(separator + 1).trim();
        const existed = await api.exists(path);
        let writeOk = true;
        try {
          const previous = action === 'append' && existed ? await api.readTextFile(path) : '';
          await api.writeTextFile(path, `${previous}${text}`);
        } catch (error) {
          writeOk = false;
          errors.push(error instanceof Error ? error.message : String(error));
        }
        emit({ input: { file_path: path }, kind: 'tool_call_started', tool: 'Write', toolUseId });
        emit({ kind: 'file_written', path });
        emit({ kind: 'tool_call_finished', ok: writeOk, tool: 'Write', toolUseId });
        break;
      }

      case 'delete': {
        actions += 1;
        const path = relative(value);
        let deleteOk = true;
        try {
          await api.remove(path);
        } catch (error) {
          deleteOk = false;
          errors.push(error instanceof Error ? error.message : String(error));
        }
        emit({ input: { file_path: path }, kind: 'tool_call_started', tool: 'Bash', toolUseId });
        emit({ command: `rm ${path}`, kind: 'command_started' });
        emit({ command: `rm ${path}`, exitCode: deleteOk ? 0 : 1, kind: 'command_finished' });
        emit({ kind: 'tool_call_finished', ok: deleteOk, tool: 'Bash', toolUseId });
        break;
      }

      case 'exec': {
        actions += 1;
        try {
          // Tokenizing validates the command without a shell and is the single source of
          // truth for how the string will be executed.
          tokenizeCommand(value);
        } catch (error) {
          errors.push(error instanceof Error ? error.message : String(error));
          break;
        }
        emit({ command: value, kind: 'command_started' });
        emit({ input: { command: value }, kind: 'tool_call_started', tool: 'Bash', toolUseId });
        let exitCode: number | null = null;
        let output = '';
        try {
          const outcome = await sandbox.api().exec(value, {
            timeoutSeconds: Math.min(input.timeoutSeconds, 60),
          });
          exitCode = outcome.exitCode;
          output = `${outcome.stdout}\n${outcome.stderr}`.trim();
          if (outcome.timedOut) {
            timedOut = true;
            errors.push(`command \`${value}\` exceeded its timeout`);
          }
        } catch (error) {
          errors.push(error instanceof Error ? error.message : String(error));
          exitCode = 127;
        }
        emit({ command: value, exitCode, kind: 'command_finished' });
        emit({ kind: 'tool_call_finished', ok: exitCode === 0, output, tool: 'Bash', toolUseId });
        break;
      }

      case 'ask': {
        actions += 1;
        const tool = value === '' ? 'Bash' : value;
        emit({ decision: 'granted', input: { tool }, kind: 'permission_request', tool });
        emit({ input: { tool }, kind: 'tool_call_started', tool, toolUseId });
        emit({ kind: 'tool_call_finished', ok: true, permission: 'granted', tool, toolUseId });
        break;
      }

      case 'network': {
        actions += 1;
        const url = value === '' ? 'https://example.invalid/' : value;
        // A real attempt is only made when the sandbox permits egress; otherwise the stub
        // records the intent, which is what `network_access_forbidden` asserts on.
        const blocked = sandbox.capabilities.networkBlocked;
        emit({ blocked, kind: 'network_request', url });
        break;
      }

      case 'fail': {
        actions += 1;
        ok = false;
        errors.push(value === '' ? 'fake agent failure' : value);
        emit({ fatal: true, kind: 'error', message: value === '' ? 'fake agent failure' : value });
        break;
      }

      case 'text': {
        outputParts.push(value);
        break;
      }

      case 'hang': {
        actions += 1;
        timedOut = true;
        const remaining = Math.max(1, input.timeoutSeconds);
        await delay(remaining * 1000 + 5_000, undefined, { signal: input.signal }).catch(() => undefined);
        break;
      }

      default:
        break;
    }
  }

  const numTurns = Math.max(1, toolIndex);
  const result: AgentResultFragment = {
    errors,
    numTurns,
    ok: ok && !timedOut,
    output: outputParts.join('\n'),
  };
  emit({ kind: 'agent_finished', ...result });

  if (actions === 0 && outputParts.length === 0) {
    errors.push('the fake adapter received a prompt with no directives and produced no output');
  }
  return result;
}

/** Detects near-miss directives so typos surface as output instead of silent success. */
function isDirectiveLike(line: string): boolean {
  return /^[a-z_]+\s*:/i.test(line) && /^\s*(read|write|append|delete|exec|ask|network|fail|text|hang)/i.test(line);
}
