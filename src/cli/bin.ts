#!/usr/bin/env node
import { main } from './index.js';

/**
 * Process wrapper.
 *
 * Everything interesting lives in `main`, which returns an exit code. This file only wires up
 * signal handling and guarantees the process exits with that code after stdout drains, so
 * piped output is never truncated.
 */
const controller = new AbortController();

const onSignal = (signal: NodeJS.Signals): void => {
  controller.abort(new Error(`received ${signal}`));
  process.exitCode = 130;
};

process.once('SIGINT', () => onSignal('SIGINT'));
process.once('SIGTERM', () => onSignal('SIGTERM'));

process.once('unhandledRejection', (reason) => {
  process.stderr.write(`agentsnap: unhandled rejection: ${String(reason)}\n`);
  process.exitCode = 3;
});

try {
  const code = await main({
    argv: process.argv.slice(2),
    cwd: process.cwd(),
    signal: controller.signal,
  });
  process.exitCode = code;
} catch (error) {
  process.stderr.write(`agentsnap: ${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exitCode = 3;
}