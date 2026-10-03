import type { RunRecord } from '../core/types.js';
import { relativePosix, toPosixPath } from '../utils/paths.js';

/**
 * The comparable shape of one agent run.
 *
 * This is deliberately *behavior*, not bytes. Agents are non-deterministic: two runs of the
 * same prompt routinely produce different file contents, different prose and different tool
 * counts. Snapshotting file hashes would therefore fail on essentially every run and teach
 * users to ignore the diff.
 *
 * What is stable across runs of the same prompt is the agent's *reach*: which files it
 * touched, which commands it ran, which tools it used. Those are what a snapshot records and
 * what a diff compares.
 */
export interface SnapshotPayload {
  /** Files created, modified or deleted, sorted, workspace-relative. */
  files: string[];
  /** Shell commands the agent ran, sorted and normalized. */
  commands: string[];
  /** Tool names the agent used, sorted. */
  tools: string[];
  /** Files the agent read, sorted. Included because surprise reads leak context. */
  reads: string[];
}

export const SNAPSHOT_SCHEMA_VERSION = 1;

export interface Snapshot {
  schemaVersion: number;
  /** Test name this snapshot belongs to. */
  test: string;
  /** Per-test variant, so `variant: strict` and `variant: lenient` coexist. */
  variant: string;
  adapter: string;
  model: string | null;
  createdAt: string;
  /** sha256 over the canonical payload, used to detect hand-edited snapshots. */
  hash: string;
  payload: SnapshotPayload;
}

export const EMPTY_PAYLOAD: SnapshotPayload = { commands: [], files: [], reads: [], tools: [] };

/**
 * Projects a run record onto the comparable payload.
 *
 * Pure and total: given any record it produces a payload, so a missing or malformed snapshot
 * can never crash a run.
 */
export function normalizeRun(record: RunRecord, root: string): SnapshotPayload {
  const files = new Set<string>();
  for (const path of record.fileChanges.created) files.add(relativize(path, root));
  for (const path of record.fileChanges.modified) files.add(relativize(path, root));
  for (const path of record.fileChanges.deleted) files.add(relativize(path, root));

  return {
    commands: uniqueSorted(record.summary.commands.map((entry) => normalizeCommand(entry.command))),
    files: uniqueSorted([...files]),
    reads: uniqueSorted(record.summary.filesRead.map((path) => relativize(path, root))),
    tools: uniqueSorted(Object.keys(record.summary.toolCallCounts)),
  };
}

function uniqueSorted(values: string[]): string[] {
  return [...new Set(values.filter((value) => value !== ''))].sort();
}

/**
 * Strips run-specific noise from a command so the same logical command compares equal.
 *
 * Absolute paths become `<path>` and the sandbox root becomes `<root>`; without this, every
 * run would differ purely because it used a different temporary directory.
 */
export function normalizeCommand(command: string): string {
  return command
    .replace(/\r?\n/g, ' ')
    .replace(/(["'])[^"']*\1/g, '"…"')
    .replace(/[A-Za-z]:\\[^\s"']+/g, '<path>')
    .replace(/\/(?:tmp|var|home|Users|private)\/[^\s"']+/g, '<path>')
    .replace(/\s+/g, ' ')
    .trim();
}

function relativize(path: string, root: string): string {
  const cleaned = toPosixPath(path);
  if (root === '') return cleaned;
  const relative = relativePosix(root, cleaned);
  return relative ?? cleaned;
}