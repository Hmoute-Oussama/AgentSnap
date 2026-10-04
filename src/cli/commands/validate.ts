import { loadConfig } from '../../config/index.js';
import { ExitCode } from '../../core/exit-codes.js';
import { AgentSnapError } from '../../core/errors.js';
import { GLYPH } from '../../utils/color.js';
import type { CliContext } from '../context.js';
import { readFlags } from '../args.js';

const VALIDATE_FLAGS = ['color', 'config', 'debug', 'help', 'no-color', 'quiet', 'verbose', 'version'] as const;

/** `agentsnap validate` — configuration only, no agent, no cost. */
export async function commandValidate(context: CliContext): Promise<number> {
  const flags = readFlags(context.args, VALIDATE_FLAGS);
  const { color, logger } = context;
  try {
    const config = await loadConfig({ configPath: flags.string('config'), cwd: context.cwd });
    const assertions = config.tests.reduce((total, test) => total + test.assertions.length, 0);

    logger.info(`${color.green(GLYPH.pass)} ${config.configPath} is valid`);
    logger.info(
      color.dim(
        `  ${config.tests.length} test(s), ${assertions} assertion(s), provider ${config.agent.provider}, ` +
          `sandbox ${config.sandbox.type}/${config.sandbox.source}`,
      ),
    );
    return ExitCode.Success;
  } catch (error) {
    if (error instanceof AgentSnapError) {
      logger.error(error.format());
      return error.exitCode;
    }
    throw error;
  }
}