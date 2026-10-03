import { join } from 'node:path';
import { hashValue } from '../utils/hash.js';
import { isFile, pathExists, readJson, writeJsonAtomic } from '../utils/fsx.js';
import { toPosixPath } from '../utils/paths.js';
import {
  EMPTY_PAYLOAD,
  SNAPSHOT_SCHEMA_VERSION,
  type Snapshot,
  type SnapshotPayload,
} from './normalize.js';

/**
 * On-disk snapshot storage.
 *
 * Layout: `<dir>/<slugified test name>/<variant>.json`.
 *
 * Files are committed to git on purpose. A behavioral baseline is a reviewable artifact: a
 * diff in a pull request should show that the agent started touching a new file, which is
 * exactly the kind of change a human needs to see before merging.
 */

/** Filesystem-safe slug that still keeps test names readable and collision-free. */
export function slugifyTestName(name: string): string {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
  // A short hash keeps two similarly-named tests from colliding on disk. The `sha256:`
  // prefix is stripped because it is not a valid path segment on Windows.
  const suffix = hashValue(name).replace(/^sha256:/, '').slice(0, 8);
  return `${slug || 'test'}-${suffix}`;
}

export interface SnapshotStoreOptions {
  /** Absolute path of the snapshot directory. */
  dir: string;
  test: string;
  variant: string;
  adapter: string;
  model: string | null;
}

/** Reads the stored snapshot, or `null` when none exists or it is unreadable. */
export async function readSnapshot(options: SnapshotStoreOptions): Promise<Snapshot | null> {
  const path = snapshotPath(options);
  if (!(await isFile(path))) return null;
  try {
    const parsed = await readJson<Snapshot>(path);
    if (parsed.schemaVersion !== SNAPSHOT_SCHEMA_VERSION) return null;
    if (hashValue(parsed.payload) !== parsed.hash) return null;
    return parsed;
  } catch {
    return null;
  }
}

/**
 * Writes a snapshot atomically.
 *
 * Under `update: never` nothing is written, so a CI run can never silently bless a
 * regression as the new baseline.
 */
export async function writeSnapshot(
  options: SnapshotStoreOptions,
  payload: SnapshotPayload,
  update: 'auto' | 'never',
): Promise<Snapshot | null> {
  const snapshot: Snapshot = {
    adapter: options.adapter,
    createdAt: new Date().toISOString(),
    hash: hashValue(payload),
    model: options.model,
    payload,
    schemaVersion: SNAPSHOT_SCHEMA_VERSION,
    test: options.test,
    variant: options.variant,
  };
  if (update === 'never') return null;
  await writeJsonAtomic(snapshotPath(options), snapshot);
  return snapshot;
}

/** Deletes every snapshot for a test. Used by `agentsnap run --update-snapshots --prune`. */
export async function deleteSnapshots(dir: string, test: string): Promise<void> {
  const { removePath } = await import('../utils/fsx.js');
  await removePath(join(dir, slugifyTestName(test)));
}

export function snapshotPath(options: SnapshotStoreOptions): string {
  return join(options.dir, slugifyTestName(options.test), `${slugifyVariant(options.variant)}.json`);
}

function slugifyVariant(variant: string): string {
  const slug = variant.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  return slug === '' ? 'default' : slug;
}

/** True when a payload is empty, used to skip writing meaningless baselines. */
export function isEmptyPayload(payload: SnapshotPayload): boolean {
  return (
    payload.files.length === 0 &&
    payload.commands.length === 0 &&
    payload.reads.length === 0 &&
    payload.tools.length === 0
  );
}

export { EMPTY_PAYLOAD, SNAPSHOT_SCHEMA_VERSION, toPosixPath, pathExists };
export type { Snapshot, SnapshotPayload };