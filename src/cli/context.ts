import type { AgentAdapter, AgentCapabilities, DetectContext } from '../adapters/types.js';
import type { Logger } from '../utils/logger.js';
import type { ParsedArgs } from './args.js';

/** Everything a command needs, injected so commands stay testable without a real process. */
export interface CliContext {
  args: ParsedArgs;
  color: import('../utils/color.js').Colorizer;
  cwd: string;
  help: string;
  logger: Logger;
  signal: AbortSignal;
  stdout: NodeJS.WritableStream;
  toolVersion: string;
}

export interface Command {
  readonly name: string;
  run(context: CliContext): Promise<number>;
}

export type { AgentAdapter, AgentCapabilities, DetectContext, Logger };