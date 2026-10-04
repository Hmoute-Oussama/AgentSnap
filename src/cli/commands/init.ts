import { stringify as stringifyYaml } from 'yaml';
import { join } from 'node:path';
import { inspectRepository, readAgentInstructionSummary } from '../../config/discovery.js';
import { DEFAULT_CONFIG_FILENAME } from '../../config/index.js';
import type { RepoProfile } from '../../config/discovery.js';
import { ExitCode } from '../../core/exit-codes.js';
import { UsageError } from '../../core/errors.js';
import { pathExists, writeTextAtomic } from '../../utils/fsx.js';
import { GLYPH } from '../../utils/color.js';
import { readFlags } from '../args.js';

const INIT_FLAGS = [
  'color',
  'config',
  'debug',
  'force',
  'help',
  'no-color',
  'provider',
  'quiet',
  'verbose',
  'version',
] as const;

/**
 * `agentsnap init`
 *
 * Generates a starting config from what is actually in the repository: detected test command,
 * detected instruction files, detected package manager. Nothing is invented, so the generated
 * file is runnable after the user edits the prompts.
 */
export async function commandInit(context: import('../context.js').CliContext): Promise<number> {
  const flags = readFlags(context.args, INIT_FLAGS);
  const target = context.cwd;
  const configPath = flags.string('config') ?? join(target, DEFAULT_CONFIG_FILENAME);
  const force = flags.bool('force');

  if ((await pathExists(configPath)) && !force) {
    throw new UsageError(`${configPath} already exists.`, {
      causes: ['`init` never overwrites an existing configuration unless `--force` is passed.'],
      fixes: ['Pass `--force` to replace it.', 'Or edit the existing file directly.'],
    });
  }

  const profile = await inspectRepository(target);
  const provider = flags.string('provider') ?? 'claude-code';
  const instruction = await readAgentInstructionSummary(target);
  const contents = renderConfig({ instruction, profile, provider });

  await writeTextAtomic(configPath, contents);

  const { color, logger } = context;
  logger.info(`${color.green(GLYPH.pass)} wrote ${configPath}`);
  logger.info('');
  logger.info(color.bold('What was detected:'));
  logger.info(`  provider      ${provider}`);
  logger.info(`  git repo      ${profile.isGitRepo ? 'yes' : 'no'}`);
  if (profile.languages.length > 0) logger.info(`  languages     ${profile.languages.join(', ')}`);
  if (profile.packageManager) logger.info(`  package mgr   ${profile.packageManager}`);
  if (profile.testCommand) logger.info(`  test command  ${profile.testCommand}`);
  if (instruction) logger.info(`  instructions  ${instruction}`);
  if (profile.skills.length > 0) {
    logger.info(`  skills        ${profile.skills.map((skill) => skill.path).join(', ')}`);
  }
  logger.info('');
  logger.info(color.bold('Next:'));
  logger.info('  1. Replace the placeholder prompts with the behavior you actually care about.');
  logger.info('  2. Run `agentsnap validate` to check the file.');
  logger.info('  3. Run `agentsnap run --tag smoke` to execute the smoke tests.');
  logger.info('');
  logger.info(color.dim('  Add `.agentsnap/tmp/` and `.agentsnap/runs/` to .gitignore; commit `.agentsnap/snapshots/`.'));
  return ExitCode.Success;
}

interface RenderConfigInput {
  profile: RepoProfile;
  provider: string;
  instruction: string | null;
}

/** Builds a starter config. Uses the block form of YAML so comments survive. */
export function renderConfig(input: RenderConfigInput): string {
  const { profile, provider } = input;
  const excludes = [
    '.git',
    '**/node_modules',
    '**/.venv',
    '**/__pycache__',
    'dist',
    'build',
    'coverage',
    '.agentsnap/tmp',
    '.agentsnap/runs',
  ];

  const document = {
    agent: {
      allowedTools: ['Read', 'Edit', 'Write', 'Bash'],
      disallowedTools: ['WebFetch'],
      model: 'claude-sonnet-4-5',
      provider,
    },
    defaults: {
      retries: 1,
      timeout: { command: 120, total: 300 },
    },
    sandbox: {
      exclude: excludes,
      keepWorkspace: false,
      source: 'workspace',
      type: 'local',
    },
    security: {
      forbidden: {
        execute: ['git push *', 'npm publish *', 'rm -rf *'],
        read: ['.env', '.env.*', '**/*.pem', '**/id_rsa*'],
        write: ['.git/**'],
      },
      network: 'allow',
    },
    snapshot: {
      dir: '.agentsnap/snapshots',
      update: 'auto',
    },
    tests: [
      {
        assertions: [
          { 'max_tool_calls': 12 },
          { 'must_not_read': '.env*' },
          { 'must_not_execute': 'git push *' },
        ],
        description: 'The agent answers a question about the codebase without changing anything.',
        name: 'answers a question without editing files',
        prompt: 'Explain what this project does. Read whatever you need, but do not modify any file.',
        tags: ['smoke'],
      },
      {
        assertions: [{ 'file_created': '**/*.md' }, { 'tests_must_pass': true }],
        description: 'The agent adds a documented feature and the project test suite still passes.',
        name: 'adds a documented change',
        prompt: 'Add a short section to README.md describing how to run the tests. Do not change any other file.',
        tags: ['behavior'],
      },
    ],
    version: 1,
  };

  const header = [
    '# AgentSnap configuration',
    '#',
    '# Docs: https://github.com/Hmoute-Oussama/AgentSnap#readme',
    '#',
    `# Project root: ${profile.root}`,
    profile.testCommand ? `# Detected test command: ${profile.testCommand}` : '# No test command was detected; set `tests_must_pass.command` explicitly.',
    '',
  ].join('\n');

  return `${header}${stringifyYaml(document, { lineWidth: 100 })}`;
}