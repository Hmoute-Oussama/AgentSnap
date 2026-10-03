import { loadConfig } from '../../config/index.js';
import { ExitCode } from '../../core/exit-codes.js';
import { assertionsByGroup } from '../../assertions/definitions.js';
import { GLYPH } from '../../utils/color.js';
import type { CliContext } from '../context.js';
import { readFlags } from '../args.js';

const LIST_FLAGS = ['color', 'config', 'debug', 'help', 'json', 'no-color', 'quiet', 'verbose', 'version'] as const;

/** `agentsnap list` — shows what is configured without spending a token. */
export async function commandList(context: CliContext): Promise<number> {
  const flags = readFlags(context.args, LIST_FLAGS);
  if (flags.bool('help')) {
    context.logger.out(context.help);
    return ExitCode.Success;
  }

  const config = await loadConfig({ configPath: flags.string('config'), cwd: context.cwd });
  const { color, logger } = context;
  const verbose = flags.bool('verbose');

  if (flags.bool('json')) {
    logger.out(
      JSON.stringify(
        {
          adapter: config.agent.provider,
          configPath: config.configPath,
          tests: config.tests.map((test) => ({
            assertions: test.assertions.map((assertion) => ({ kind: assertion.kind, spec: assertion.spec })),
            description: test.description,
            name: test.name,
            skip: test.skip,
            skipReason: test.skipReason,
            tags: test.tags,
          })),
          totals: { tests: config.tests.length },
        },
        null,
        2,
      ),
    );
    return ExitCode.Success;
  }

  logger.out(
    `${color.bold('AgentSnap')} ${color.dim(config.configPath)} ${color.dim(`provider: ${config.agent.provider}`)}`,
  );
  logger.out('');

  if (config.tests.length === 0) {
    logger.out(color.yellow(`  ${GLYPH.warn} no tests are configured`));
    return ExitCode.Success;
  }

  for (const test of config.tests) {
    const mark = test.skip ? color.dim(GLYPH.skip) : color.green(GLYPH.pass);
    const tags = test.tags.length > 0 ? color.dim(` [${test.tags.join(', ')}]`) : '';
    logger.out(`  ${mark} ${color.bold(test.name)}${tags}`);
    if (test.description) logger.out(`      ${color.dim(test.description)}`);
    if (test.skip) logger.out(`      ${color.dim(`skipped: ${test.skipReason || 'no reason given'}`)}`);
    if (verbose) {
      for (const assertion of test.assertions) {
        logger.out(`      ${color.cyan(GLYPH.arrow)} ${assertion.kind}: ${JSON.stringify(assertion.spec)}`);
      }
      logger.out(
        `      ${color.dim(`timeout ${test.timeout.total}s, retries ${test.retries}, snapshot ${test.snapshot.update}`)}`,
      );
    }
  }

  logger.out('');
  logger.out(color.dim(`  ${config.tests.length} test(s), ${countAssertions(config)} assertion(s)`));

  if (verbose) {
    logger.out('');
    logger.out(color.bold('  Available assertions:'));
    for (const group of assertionsByGroup()) {
      logger.out(`    ${color.cyan(group.group.padEnd(10))} ${color.dim(group.kinds.join(', '))}`);
    }
  }

  return ExitCode.Success;
}

function countAssertions(config: { tests: Array<{ assertions: unknown[] }> }): number {
  return config.tests.reduce((total, test) => total + test.assertions.length, 0);
}