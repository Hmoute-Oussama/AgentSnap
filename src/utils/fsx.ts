import { constants, type Dirent } from 'node:fs';
import { access, copyFile, mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { dirname, join, resolve } from 'node:path';
import { stableStringify } from './hash.js';
import { relativePosix, toPosixPath } from './paths.js';

export async function pathExists(target: string): Promise<boolean> {
  try {
    await access(target, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

export async function isDirectory(target: string): Promise<boolean> {
  try {
    return (await stat(target)).isDirectory();
  } catch {
    return false;
  }
}

export async function isFile(target: string): Promise<boolean> {
  try {
    return (await stat(target)).isFile();
  } catch {
    return false;
  }
}

export async function ensureDir(target: string): Promise<void> {
  await mkdir(target, { recursive: true });
}

export async function removePath(target: string): Promise<void> {
  await rm(target, { recursive: true, force: true, maxRetries: 3 });
}

export async function readText(target: string): Promise<string> {
  return readFile(target, 'utf8');
}

/** Writes atomically so a crashed run never leaves a half-written config or snapshot. */
export async function writeTextAtomic(target: string, contents: string): Promise<void> {
  await ensureDir(dirname(target));
  const temporary = `${target}.${process.pid.toString(36)}.${Date.now().toString(36)}.tmp`;
  await writeFile(temporary, contents, 'utf8');
  try {
    await rename(temporary, target);
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
}

/** Writes JSON with deterministic key order and a trailing newline (git-friendly diffs). */
export async function writeJsonAtomic(target: string, value: unknown, indent = 2): Promise<void> {
  await writeTextAtomic(target, `${stableStringify(value, indent)}\n`);
}

export async function readJson<T>(target: string): Promise<T> {
  const raw = await readText(target);
  return JSON.parse(raw) as T;
}

export async function hashFile(target: string): Promise<string> {
  const contents = await readFile(target);
  return createHash('sha256').update(contents).digest('hex');
}

export interface CopyOptions {
  exclude?: (relativePath: string, isDirectory: boolean) => boolean;
  /** Never follows symlinks; symlinks are copied as symlinks. */
  includeSymlinks?: boolean;
}

export interface CopyStats {
  directories: number;
  files: number;
  skipped: number;
  symlinks: number;
}

/**
 * Copies a directory tree with filtering, without ever following symlinks out of the tree.
 *
 * Symlinks are recreated as symlinks rather than dereferenced, so a malicious repository
 * cannot use `ln -s /etc/passwd` to exfiltrate host files through a sandbox copy.
 */
export async function copyDirFiltered(
  source: string,
  destination: string,
  options: CopyOptions = {},
): Promise<CopyStats> {
  const stats: CopyStats = { directories: 0, files: 0, skipped: 0, symlinks: 0 };
  const rootStats = await stat(source);

  async function walk(from: string, to: string): Promise<void> {
    const entries = await readdir(from, { withFileTypes: true });
    for (const entry of entries) {
      const fromPath = join(from, entry.name);
      const toPath = join(to, entry.name);
      const rel = toPosixPath(relativePosix(source, fromPath) ?? entry.name);

      if (entry.isSymbolicLink()) {
        if (!options.includeSymlinks) {
          stats.skipped += 1;
          continue;
        }
        const link = await readFile(fromPath, 'utf8').catch(() => undefined);
        if (link === undefined) {
          stats.skipped += 1;
          continue;
        }
        await symlinkOrCopy(link, toPath);
        stats.symlinks += 1;
        continue;
      }

      if (entry.isDirectory()) {
        if (options.exclude?.(rel, true)) {
          stats.skipped += 1;
          continue;
        }
        await ensureDir(toPath);
        stats.directories += 1;
        await walk(fromPath, toPath);
        continue;
      }

      if (!entry.isFile()) {
        stats.skipped += 1;
        continue;
      }
      if (options.exclude?.(rel, false)) {
        stats.skipped += 1;
        continue;
      }
      await ensureDir(dirname(toPath));
      await copyFile(fromPath, toPath);
      stats.files += 1;
    }
  }

  await ensureDir(destination);
  if (rootStats.isDirectory()) await walk(source, destination);
  return stats;
}

async function symlinkOrCopy(target: string, linkPath: string): Promise<void> {
  const { symlink } = await import('node:fs/promises');
  try {
    await symlink(target, linkPath);
  } catch {
    // Windows without Developer Mode: fall back to a regular file holding the link text
    // so the sandbox copy never silently resolves outside the tree.
    await writeFile(linkPath, target, 'utf8');
  }
}

export interface FileEntry {
  /** POSIX-style path relative to the scan root. */
  path: string;
  size: number;
  /** sha256 hex digest, or `null` for unreadable/binary entries. */
  hash: string | null;
}

export interface FileScanOptions {
  exclude?: (relativePath: string, isDirectory: boolean) => boolean;
  maxEntries?: number;
  maxFileBytes?: number;
}

/**
 * Walks a tree and returns a sorted, hash-based inventory.
 *
 * Used to compute the before/after filesystem delta that drives every
 * `file_changed` / `file_created` / `file_deleted` assertion. Binary and huge files are
 * hashed by size+path instead of contents to keep the scan fast and bounded.
 */
export async function scanTree(root: string, options: FileScanOptions = {}): Promise<FileEntry[]> {
  const maxEntries = options.maxEntries ?? 20_000;
  const maxFileBytes = options.maxFileBytes ?? 2 * 1024 * 1024;
  const entries: FileEntry[] = [];
  const truncated = { value: false };

  async function walk(dir: string): Promise<void> {
    if (entries.length >= maxEntries) {
      truncated.value = true;
      return;
    }
    let dirEntries: Dirent[];
    try {
      dirEntries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of dirEntries) {
      if (entries.length >= maxEntries) {
        truncated.value = true;
        return;
      }
      const full = join(dir, entry.name);
      const rel = toPosixPath(relativePosix(root, full) ?? entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        if (options.exclude?.(rel, true)) continue;
        await walk(full);
        continue;
      }
      if (!entry.isFile()) continue;
      if (options.exclude?.(rel, false)) continue;
      const info = await stat(full).catch(() => undefined);
      if (!info) continue;
      let hash: string | null = null;
      try {
        hash =
          info.size <= maxFileBytes
            ? await hashFile(full)
            : createHash('sha256').update(`${rel}:${info.size}`).digest('hex');
      } catch {
        hash = null;
      }
      entries.push({ path: rel, size: info.size, hash });
    }
  }

  if (await isDirectory(root)) await walk(resolve(root));
  entries.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return entries;
}

export interface FileDelta {
  created: string[];
  deleted: string[];
  modified: string[];
  unchangedCount: number;
  truncated: boolean;
}

/** Computes created/deleted/modified paths between two scans. */
export function computeDelta(before: FileEntry[], after: FileEntry[]): FileDelta {
  const beforeMap = new Map(before.map((entry) => [entry.path, entry]));
  const afterMap = new Map(after.map((entry) => [entry.path, entry]));
  const created: string[] = [];
  const modified: string[] = [];
  const deleted: string[] = [];
  let unchangedCount = 0;

  for (const [path, entry] of afterMap) {
    const previous = beforeMap.get(path);
    if (!previous) created.push(path);
    else if (previous.hash !== entry.hash) modified.push(path);
    else unchangedCount += 1;
  }
  for (const path of beforeMap.keys()) {
    if (!afterMap.has(path)) deleted.push(path);
  }

  return {
    created: created.sort(),
    deleted: deleted.sort(),
    modified: modified.sort(),
    unchangedCount,
    truncated: false,
  };
}
