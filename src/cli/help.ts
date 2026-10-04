import { EXIT_CODE_DESCRIPTIONS } from '../core/exit-codes.js';
import { GLYPH } from '../utils/color.js';

export const COMMANDS = ['run', 'init', 'list', 'validate', 'doctor', 'help', 'version'] as const;

export const COMMAND_ALIASES: Record<string, string> = {
  check: 'validate',
  ls: 'list',
  test: 'run',
  tests: 'run',
  v: 'version',
};

const COMMON_OPTIONS = `COMMON OPTIONS
  -c, --config <path>   Use a specific config file instead of discovering one
      --no-color        Disable ANSI color        (honours NO_COLOR)
      --color           Force ANSI color
  -q, --quiet           Only print errors
  -v, --verbose         Print extra detail
      --debug           Print internal diagnostics (implies --verbose)`;

/**
 * Per-command options.
 *
 * Kept next to the help text on purpose: a flag that exists in the parser but in no help page
 * is a flag nobody will ever use, and the mismatch is invisible to tests.
 */
const COMMAND_OPTIONS: Record<string, { summary: string; options: string; examples: string }> = {
  run: {
    summary: 'Run agent tests and assert their behavior',
    options: `RUN OPTIONS
      --name <glob>      Only run tests whose name matches this glob
  -t, --tag <tag>       Only run tests with this tag (repeatable)
      --exclude <glob>  Skip tests whose name or tag matches
      --all             Run every test, including ones tagged as manual
  -b, --bail            Stop after the first failing test
  -C, --concurrency <n> Run up to n tests at once (default 1)
      --retries <n>     Override the retry budget for every test
  -T, --timeout <s>     Override the per-run timeout, in seconds
  -r, --reporter <name> console (default) or json
      --json            Shorthand for --reporter json
      --json-stream     With --json: newline-delimited results as tests finish
      --include-events  Record the full event stream in .agentsnap/runs
      --events          Print the event stream for failing tests
      --usage           Print estimated token cost at the end

SNAPSHOTS
      --snapshot-mode <mode>  strict, loose (default per test) or off
      --update-snapshots      Accept this run as the new behavioral baseline`,
    examples: `  agentsnap run
  agentsnap run --tag security --bail
  agentsnap run --name "refuses to push" --snapshot-mode strict
  agentsnap run --update-snapshots
  agentsnap run --reporter json > agentsnap-report.json`,
  },
  init: {
    summary: 'Create an agentsnap.yaml for this repository',
    options: `INIT OPTIONS
      --provider <name>  Provider to scaffold: claude-code (default) or fake
      --force            Overwrite an existing agentsnap.yaml`,
    examples: `  agentsnap init
  agentsnap init --provider fake --force`,
  },
  list: {
    summary: 'List configured tests and their assertions',
    options: `LIST OPTIONS
      --json             Emit the test list as JSON`,
    examples: `  agentsnap list
  agentsnap list --json`,
  },
  validate: {
    summary: 'Check agentsnap.yaml for problems',
    options: `VALIDATE OPTIONS
      --json             Emit the diagnostic report as JSON`,
    examples: `  agentsnap validate`,
  },
  doctor: {
    summary: 'Diagnose the environment and the agent runtime',
    options: `DOCTOR OPTIONS
      --json             Emit diagnostics as JSON`,
    examples: `  agentsnap doctor`,
  },
};

/** Help for one command, falling back to the overview for `help` and `version`. */
export function renderCommandHelp(command: string, toolVersion: string): string {
  const entry = COMMAND_OPTIONS[command];
  if (!entry) return renderHelp(toolVersion);

  return `${GLYPH.info} AgentSnap ${toolVersion} — ${entry.summary}

USAGE
  agentsnap ${command} [options]

${entry.options}

${COMMON_OPTIONS}

EXIT CODES
${EXIT_CODE_DESCRIPTIONS.map((line) => `  ${String(line.code).padEnd(4)} ${line.name.padEnd(14)} ${line.description}`).join('\n')}

EXAMPLES
${entry.examples}
`;
}

export function renderHelp(toolVersion: string): string {
  return `${GLYPH.info} AgentSnap ${toolVersion} — unit tests for AI agents

USAGE
  agentsnap <command> [options]

COMMANDS
  run        Run agent tests and assert their behavior        (alias: test)
  init       Create an agentsnap.yaml for this repository
  list       List configured tests and their assertions       (alias: ls)
  validate   Check agentsnap.yaml for problems               (alias: check)
  doctor     Diagnose the environment and the agent runtime
  help       Show this help
  version    Print the version

${COMMON_OPTIONS}

${COMMAND_OPTIONS['run']?.options ?? ''}

EXIT CODES
${EXIT_CODE_DESCRIPTIONS.map((entry) => `  ${String(entry.code).padEnd(4)} ${entry.name.padEnd(14)} ${entry.description}`).join('\n')}

EXAMPLES
  agentsnap init
  agentsnap run
  agentsnap run --tag security --bail
  agentsnap run --reporter json > agentsnap-report.json
  agentsnap doctor

Run \`agentsnap <command> --help\` for command-specific options.
`;
}