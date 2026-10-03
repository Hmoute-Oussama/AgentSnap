import { isAbsolute, relative, resolve, sep } from 'node:path';

/** Converts any platform path to a stable POSIX-style path for storage and matching. */
export function toPosixPath(input: string): string {
  return sep === '/' ? input : input.split(sep).join('/');
}

/**
 * Resolves `candidate` against `root` and guarantees the result stays inside `root`.
 *
 * This is the single choke point protecting AgentSnap from path traversal in
 * user-supplied glob/assertion patterns and in test fixtures. It rejects:
 *   - absolute paths that escape the root
 *   - `..` segments that climb out of the root
 *   - NUL bytes (poison value for syscalls)
 */
export function resolveWithin(root: string, candidate: string): string {
  if (candidate.includes('\0')) {
    throw new Error(`Path contains a NUL byte: ${JSON.stringify(candidate)}`);
  }
  const absoluteRoot = resolve(root);
  const absolute = isAbsolute(candidate) ? resolve(candidate) : resolve(absoluteRoot, candidate);
  const rel = relative(absoluteRoot, absolute);
  if (rel === '') return absoluteRoot;
  const outside = rel.startsWith('..') || isAbsolute(rel);
  if (outside) {
    throw new Error(`Path escapes the allowed root: ${JSON.stringify(candidate)}`);
  }
  return absolute;
}

/** True when `child` is the same as or nested inside `parent`. */
export function isInside(parent: string, child: string): boolean {
  try {
    resolveWithin(parent, child);
    return true;
  } catch {
    return false;
  }
}

/** Relative POSIX path from `root`, or `null` when `target` is outside `root`. */
export function relativePosix(root: string, target: string): string | null {
  const rel = relative(resolve(root), resolve(target));
  if (rel === '') return '';
  if (rel.startsWith('..') || isAbsolute(rel)) return null;
  return toPosixPath(rel);
}

/** Rejects obviously unsafe executable names before they reach `spawn`. */
const UNSAFE_EXECUTABLE = /[^\w.@+:\-\\/]/;

export function assertSafeExecutableName(command: string): void {
  if (command.length === 0) throw new Error('Executable name is empty.');
  if (UNSAFE_EXECUTABLE.test(command)) {
    throw new Error(
      `Executable ${JSON.stringify(command)} contains characters that are not valid in a program name. ` +
        'Configure a bare executable name (for example "claude") or an absolute path.',
    );
  }
}
