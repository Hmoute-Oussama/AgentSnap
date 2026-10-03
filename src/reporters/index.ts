import { UsageError } from '../core/errors.js';
import { createConsoleReporter } from './console.js';
import { createJsonReporter } from './json.js';
import type { Reporter } from './types.js';

export const REPORTER_NAMES = ['console', 'json'] as const;
export type ReporterName = (typeof REPORTER_NAMES)[number];

export interface CreateReporterOptions {
  color: import('../utils/color.js').Colorizer;
  logger: import('../utils/logger.js').Logger;
  name: string;
  showEvents: boolean;
  showUsage: boolean;
  stream: boolean;
  verboseAssertions: boolean;
  write: (text: string) => void;
}

export function createReporter(options: CreateReporterOptions): Reporter {
  if (options.name === 'console') {
    return createConsoleReporter({
      color: options.color,
      logger: options.logger,
      showEvents: options.showEvents,
      showUsage: options.showUsage,
      verboseAssertions: options.verboseAssertions,
    });
  }
  if (options.name === 'json') {
    return createJsonReporter({ stream: options.stream, write: options.write });
  }
  throw new UsageError(`unknown reporter "${options.name}".`, {
    fixes: [`Use one of: ${REPORTER_NAMES.join(', ')}.`],
  });
}

export { createConsoleReporter, createJsonReporter };
export * from './types.js';