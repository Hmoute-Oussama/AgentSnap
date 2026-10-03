import { constants } from 'node:fs';
import { access } from 'node:fs/promises';
import { delimiter, isAbsolute, join, resolve } from 'node:path';

export interface ResolvedExecutable {
  /** Filesystem path of the executable that will be spawned. */
  path: string;
  /** Directory used as cwd for version probes. */
  cwd: string;
}

/**
 * Resolves an executable without shelling out to `which`/`where`.
 *
 * AgentSnap never uses a shell, so it cannot rely on `which`. Instead it walks PATH the
 * same way the OS loader does, including PATHEXT resolution on Windows.
 */
export async function resolveExecutable(
  command: string,
  env: NodeJS.ProcessEnv,
  cwd: string = process.cwd(),
): Promise<ResolvedExecutable | null> {
  if (isAbsolute(command)) {
    return (await isRunnable(command, env)) ? { cwd, path: resolve(command) } : null;
  }
  if (command.includes('/') || command.includes('\\')) {
    const candidate = resolve(cwd, command);
    return (await isRunnable(candidate, env)) ? { cwd, path: candidate } : null;
  }

  const pathValue = env['PATH'] ?? env['Path'] ?? env['path'] ?? '';
  const extensions = executableExtensions(env);
  for (const entry of pathValue.split(delimiter)) {
    if (entry.trim() === '') continue;
    const base = join(entry, command);
    for (const candidate of extensions.map((extension) => `${base}${extension}`)) {
      if (await isRunnable(candidate, env)) return { cwd, path: candidate };
    }
    if (extensions.length === 0 && (await isRunnable(base, env))) {
      return { cwd, path: base };
    }
  }
  return null;
}

/** Candidate suffixes to try, most specific first. On POSIX only the bare name. */
function executableExtensions(env: NodeJS.ProcessEnv): string[] {
  if (process.platform !== 'win32') return [''];
  const pathext = env['PATHEXT'] ?? '.COM;.EXE;.BAT;.CMD';
  const extensions = pathext
    .split(';')
    .map((value) => value.trim())
    .filter((value) => value !== '');
  return ['', ...extensions];
}

/**
 * Checks that a path exists and is executable.
 *
 * On Windows "executable" means the extension is executable, because the OS loader decides
 * that; on POSIX the permission bits decide.
 */
async function isRunnable(candidate: string, env: NodeJS.ProcessEnv): Promise<boolean> {
  try {
    // Existence is the portable check; on POSIX `X_OK` additionally requires the bit set.
    await access(candidate, process.platform === 'win32' ? constants.F_OK : constants.X_OK);
    if (process.platform !== 'win32') return true;
    const suffixes = executableExtensions(env).filter((suffix) => suffix !== '');
    return suffixes.some((suffix) => candidate.toLowerCase().endsWith(suffix.toLowerCase()));
  } catch {
    return false;
  }
}
