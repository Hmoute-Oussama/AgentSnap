import { readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { AgentSnapError, UsageError } from '../core/errors.js';
import { ExitCode } from '../core/exit-codes.js';
import { createColorizer, shouldUseColor } from '../utils/color.js';
import { createLogger, resolveLogLevel } from '../utils/logger.js';
import { parseArgs, peekFlags, readFlags } from './args.js';
import { COMMAND_ALIASES, renderHelp } from './help.js';
import { commandDoctor } from './commands/doctor.js';
import { commandInit } from './commands/init.js';
import { commandList } from './commands/list.js';
import { commandRun } from './commands/run.js';
import { commandValidate } from './commands/validate.js';
import type { CliContext } from './context.js';

export interface MainOptions {
  argv: readonly string[];
  cwd: string;
  signal: AbortSignal;
  stdout?: NodeJS.WritableStream;
  stderr?: NodeJS.WritableStream;
}

/**
 * CLI entrypoint.
 *
 * Returns an exit code instead of calling `process.exit`, which keeps every command testable
 * and guarantees that stdout is flushed before the process ends.
 */
export async function main(options: MainOptions): Promise<number> {
  const stdout = options.stdout ?? process.stdout;
  const stderr = options.stderr ?? process.stderr;
  const toolVersion = await readToolVersion();
  const parsed = parseArgs(options.argv);
  const global = peekFlags(parsed);

  // `--no-color` is stored as `color=false`, so the negation must be read back from there.
  const colorValues = parsed.flags.get('color');
  const colorFlag = colorValues === undefined ? undefined : colorValues[colorValues.length - 1] !== 'false';

  const color = createColorizer(shouldUseColor({ colorFlag, isTTY: isTty(stdout) }));
  const logger = createLogger({
    color,
    level: resolveLogLevel({
      ci: isCi(),
      debug: global.bool('debug'),
      quiet: global.bool('quiet'),
      verbose: global.bool('verbose'),
    }),
    stream: stdout,
    stderr,
  });

  const help = renderHelp(toolVersion);
  const context: CliContext = {
    args: parsed,
    color,
    cwd: resolve(options.cwd),
    help,
    logger,
    signal: options.signal,
    stdout,
    toolVersion,
  };

  if (global.bool('version') || parsed.command === 'version') {
    stdout.write(`${toolVersion}\n`);
    return ExitCode.Success;
  }

  const raw = parsed.command;
  const command = raw === null ? undefined : COMMAND_ALIASES[raw] ?? raw;

  if (parsed.command === null && global.bool('help')) {
    stdout.write(help);
    return ExitCode.Success;
  }

  if (command === undefined) {
    // Bare `agentsnap` with no arguments should explain itself rather than error out.
    stdout.write(help);
    return parsed.positionals.length > 0 || parsed.provided.size > 0 ? ExitCode.ConfigError : ExitCode.Success;
  }

  try {
    switch (command) {
      case 'run':
        return await commandRun(context);
      case 'init':
        return await commandInit(context);
      case 'list':
        return await commandList(context);
      case 'validate':
        return await commandValidate(context);
      case 'doctor':
        return await commandDoctor(context);
      case 'help':
        stdout.write(help);
        return ExitCode.Success;
      default:
        throw new UsageError(`Unknown command \`${raw}\`.`, {
          fixes: ['Run `agentsnap help` to see the available commands.'],
        });
    }
  } catch (error) {
    return reportFailure(error, context);
  }
}

/** Prints an error and maps it to its documented exit code. */
function reportFailure(error: unknown, context: CliContext): number {
  if (isInterrupt(error)) return ExitCode.Interrupted;

  if (error instanceof AgentSnapError) {
    context.logger.error(error.message);
    if (error.causes.length > 0) {
      context.logger.error('possible causes:');
      for (const cause of error.causes) context.logger.error(`  ${context.color.dim('-')} ${cause}`);
    }
    if (error.fixes.length > 0) {
      context.logger.error('try:');
      for (const fix of error.fixes) context.logger.error(`  ${context.color.dim('-')} ${fix}`);
    }
    if (error.hint) context.logger.error(`run \`${error.hint}\` for a full diagnostic.`);
    return error.exitCode;
  }

  const message = error instanceof Error ? error.message : String(error);
  context.logger.error(`AgentSnap hit an unexpected error: ${message}`);
  if (error instanceof Error && error.stack) context.logger.debug(error.stack);
  context.logger.error('This is a bug. Please report it with the output of `agentsnap --debug run`.');
  return ExitCode.RuntimeError;
}

function isInterrupt(error: unknown): boolean {
  return error instanceof Error && (error.name === 'AbortError' || error.name === 'InterruptedError');
}

function isCi(): boolean {
  return process.env.CI !== undefined && process.env.CI !== 'false' && process.env.CI !== '0';
}

/** `isTTY` only exists on Node's own streams, so a custom test stream reports false. */
function isTty(stream: NodeJS.WritableStream): boolean {
  return 'isTTY' in stream && (stream as { isTTY?: boolean }).isTTY === true;
}

/**
 * Reads the version from the nearest `package.json`.
 *
 * Walking up from the compiled file keeps the published package self-contained: there is no
 * generated version constant that can drift out of sync with `package.json`.
 */
export async function readToolVersion(): Promise<string> {
  const here = dirname(fileURLToPath(import.meta.url));
  let dir = here;
  for (let depth = 0; depth < 6; depth += 1) {
    try {
      const raw = await readFile(join(dir, 'package.json'), 'utf8');
      const parsed = JSON.parse(raw) as { name?: string; version?: string };
      if (parsed.name === 'agentsnap' && typeof parsed.version === 'string') return parsed.version;
    } catch {
      // Keep walking: this is normal when the package is installed under a scoped path.
    }
    const parent = resolve(dir, '..');
    if (parent === dir) break;
    dir = parent;
  }
  return '0.0.0-unknown';
}

export { readFlags, parseArgs };