import type { Snapshot, SnapshotPayload } from './normalize.js';

export type SnapshotDiffStatus = 'created' | 'matched' | 'different' | 'missing' | 'disabled';

export interface SnapshotCategoryDiff {
  /** Entries present in this run but not in the stored snapshot. */
  added: string[];
  /** Entries present in the stored snapshot but not in this run. */
  removed: string[];
}

export interface SnapshotDiff {
  status: SnapshotDiffStatus;
  /** Human-readable lines describing what changed, ready for a reporter. */
  changes: string[];
  files: SnapshotCategoryDiff;
  commands: SnapshotCategoryDiff;
  reads: SnapshotCategoryDiff;
  tools: SnapshotCategoryDiff;
  /** True when, under the configured comparison mode, this run must fail. */
  isRegression: boolean;
  stored: Snapshot | null;
}

export type CompareMode = 'strict' | 'loose' | 'off';

export interface CompareOptions {
  mode: CompareMode;
  /** `never` refuses to create a missing snapshot. */
  update: 'auto' | 'never';
}

/** The empty diff, used when snapshotting is disabled. */
export function disabledDiff(): SnapshotDiff {
  return {
    changes: [],
    commands: emptyCategory(),
    files: emptyCategory(),
    isRegression: false,
    reads: emptyCategory(),
    status: 'disabled',
    stored: null,
    tools: emptyCategory(),
  };
}

export function missingDiff(stored: Snapshot | null, options: CompareOptions): SnapshotDiff {
  const created = options.update === 'auto';
  return {
    ...emptyAgainst(stored),
    changes: created
      ? [`no snapshot existed, so one was recorded as the baseline for "${stored?.test ?? 'this test'}"`]
      : [
          `no snapshot exists for this test and \`snapshot.update\` is \`never\`, so nothing was recorded`,
          `record it deliberately with \`agentsnap run --update-snapshots\` or \`snapshot.update: auto\``,
        ],
    isRegression: !created,
    status: created ? 'created' : 'missing',
  };
}

/**
 * Compares a run payload against the stored snapshot.
 *
 * Mode semantics, chosen because agent behaviour is noisy by nature:
 *   - `strict`: any difference in any category fails the test.
 *   - `loose`  (default): only *new* side effects fail. An agent that starts touching a new
 *               file or running a new command is a genuine finding; an agent that skipped a
 *               step it used to take is usually just variance.
 *   - `off`   : snapshots are recorded but never compared.
 */
export function diffSnapshot(
  payload: SnapshotPayload,
  stored: Snapshot | null,
  options: CompareOptions,
): SnapshotDiff {
  if (options.mode === 'off') return disabledDiff();
  if (stored === null) return missingDiff(null, options);

  const files = categoryDiff(stored.payload.files, payload.files);
  const commands = categoryDiff(stored.payload.commands, payload.commands);
  const reads = categoryDiff(stored.payload.reads, payload.reads);
  const tools = categoryDiff(stored.payload.tools, payload.tools);

  const categories = { commands, files, reads, tools };
  const changed = Object.entries(categories).filter(([, value]) => value.added.length > 0 || value.removed.length > 0);

  if (changed.length === 0) {
    return {
      changes: [],
      commands,
      files,
      isRegression: false,
      reads,
      status: 'matched',
      stored,
      tools,
    };
  }

  const changes: string[] = [];
  for (const [name, value] of changed) {
    for (const entry of value.added) changes.push(`new ${singular(name)}: ${entry}`);
    for (const entry of value.removed) changes.push(`no longer ${name.slice(0, -1)}: ${entry}`);
  }

  const anyAdded = changed.some(([, value]) => value.added.length > 0);
  const isRegression = options.mode === 'strict' ? changed.length > 0 : anyAdded;

  return {
    changes,
    commands,
    files,
    isRegression,
    reads,
    status: 'different',
    stored,
    tools,
  };
}

function categoryDiff(stored: readonly string[], current: readonly string[]): SnapshotCategoryDiff {
  const storedSet = new Set(stored);
  const currentSet = new Set(current);
  return {
    added: current.filter((entry) => !storedSet.has(entry)),
    removed: stored.filter((entry) => !currentSet.has(entry)),
  };
}

function emptyCategory(): SnapshotCategoryDiff {
  return { added: [], removed: [] };
}

function emptyAgainst(stored: Snapshot | null): Omit<SnapshotDiff, 'changes' | 'isRegression' | 'status'> {
  return {
    commands: emptyCategory(),
    files: emptyCategory(),
    reads: emptyCategory(),
    stored,
    tools: emptyCategory(),
  };
}

function singular(name: string): string {
  return name.endsWith('s') ? name.slice(0, -1) : name;
}

/** Renders one line per change, capped so a huge divergence cannot flood the report. */
export function renderChanges(diff: SnapshotDiff, limit = 20): string[] {
  if (diff.changes.length === 0) return [];
  const shown = diff.changes.slice(0, limit).map((change) => `  ${change}`);
  if (diff.changes.length > limit) {
    shown.push(`  … and ${diff.changes.length - limit} more change(s)`);
  }
  return shown;
}