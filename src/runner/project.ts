import type { AgentEvent } from '../core/events.js';
import type { CommandRecord, FileChanges, NetworkRecord, PermissionRecord, RunSummary } from '../core/types.js';
import { relativePosix, toPosixPath } from '../utils/paths.js';

export interface ProjectOptions {
  /** Sandbox workspace root, used to relativize agent-reported absolute paths. */
  root: string;
  /** Filesystem delta measured by the runner. Authoritative for changes. */
  delta: FileChanges;
  /** Final assistant output. */
  output: string;
}

export interface ProjectedRun {
  summary: RunSummary;
  /** Paths the agent declared it wrote, normalized to workspace-relative form. */
  declaredWrites: string[];
  declaredReads: string[];
  /** Union of filesystem changes and declared writes: everything the agent may have written. */
  filesWritten: string[];
}

/**
 * Folds a normalized event stream into the summary assertions evaluate against.
 *
 * Pure and adapter-agnostic: every assertion reads only this projection, which is why a new
 * adapter cannot change assertion semantics.
 */
export function projectRun(events: readonly AgentEvent[], options: ProjectOptions): ProjectedRun {
  const toolCallCounts: Record<string, number> = {};
  const declaredReads = new Set<string>();
  const declaredWrites = new Set<string>();
  const commands: CommandRecord[] = [];
  const permissions: PermissionRecord[] = [];
  const network: NetworkRecord[] = [];
  const errors: string[] = [];

  let toolCalls = 0;
  let steps = 0;

  // Pairs a `tool_call_started` with its result so finished events can name the real tool.
  const pendingTools = new Map<string, { tool: string; startedAt: number }>();
  const startedOrder: string[] = [];

  // Pairs command starts with results in FIFO order per command string.
  const openCommands = new Map<string, Array<{ cwd: string; startedAt: number }>>();

  for (const event of events) {
    switch (event.type) {
      case 'tool_call_started': {
        toolCalls += 1;
        toolCallCounts[event.tool] = (toolCallCounts[event.tool] ?? 0) + 1;
        const key = event.toolUseId ?? `anon-${startedOrder.length}`;
        pendingTools.set(key, { startedAt: Date.parse(event.at), tool: event.tool });
        startedOrder.push(key);
        break;
      }

      case 'tool_call_finished': {
        const key = event.toolUseId ?? startedOrder.shift();
        const started = key === undefined ? undefined : pendingTools.get(key);
        if (key !== undefined) pendingTools.delete(key);
        if (started && event.tool === 'unknown') event.tool = started.tool;
        break;
      }

      case 'file_read': {
        const path = relativize(event.path, options.root);
        if (path) declaredReads.add(path);
        break;
      }

      case 'file_written': {
        const path = relativize(event.path, options.root);
        if (path) declaredWrites.add(path);
        break;
      }

      case 'command_started': {
        const queue = openCommands.get(event.command) ?? [];
        queue.push({ cwd: event.cwd, startedAt: Date.parse(event.at) });
        openCommands.set(event.command, queue);
        break;
      }

      case 'command_finished': {
        const queue = openCommands.get(event.command);
        const started = queue?.shift();
        commands.push({
          command: event.command,
          durationMs: event.durationMs,
          exitCode: event.exitCode,
          timedOut: false,
        });
        void started;
        break;
      }

      case 'permission_request': {
        permissions.push({ decision: event.decision, tool: event.tool });
        break;
      }

      case 'network_request': {
        network.push({ blocked: event.blocked === true, method: event.method, url: event.url });
        break;
      }

      case 'message': {
        if (event.role === 'assistant') steps += 1;
        break;
      }

      case 'error': {
        errors.push(event.message);
        break;
      }

      case 'agent_finished': {
        if (typeof event.numTurns === 'number') steps = event.numTurns;
        break;
      }

      default:
        break;
    }
  }

  const changed = [...new Set([...options.delta.created, ...options.delta.modified, ...options.delta.deleted])].sort();
  const filesWritten = [...new Set([...changed, ...declaredWrites])].sort();

  const summary: RunSummary = {
    commands: commands.map((entry) => ({ ...entry })),
    errors,
    filesChanged: changed,
    filesCreated: [...options.delta.created],
    filesDeleted: [...options.delta.deleted],
    filesRead: [...declaredReads].sort(),
    network,
    output: options.output,
    permissions,
    steps,
    toolCallCounts: sortRecord(toolCallCounts),
    toolCalls,
  };

  return {
    declaredReads: [...declaredReads].sort(),
    declaredWrites: [...declaredWrites].sort(),
    filesWritten,
    summary,
  };
}

function relativize(path: string, root: string): string | null {
  const cleaned = toPosixPath(path).replace(/^\.\//, '');
  const relative = relativePosix(root, cleaned);
  if (relative !== null) return relative;
  // Agent-reported paths may already be project-relative even when the sandbox root differs
  // (for example `src/index.ts`). Reject only obvious escapes.
  if (cleaned.startsWith('..') || cleaned.startsWith('/')) return null;
  return cleaned;
}

function sortRecord(record: Record<string, number>): Record<string, number> {
  const out: Record<string, number> = {};
  for (const key of Object.keys(record).sort()) out[key] = record[key] ?? 0;
  return out;
}


