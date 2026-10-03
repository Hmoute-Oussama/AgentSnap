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

COMMON OPTIONS
  -c, --config <path>   Use a specific config file instead of discovering one
      --no-color        Disable ANSI color        (honours NO_COLOR)
      --color           Force ANSI color
  -q, --quiet           Only print errors
  -v, --verbose         Print extra detail
      --debug           Print internal diagnostics (implies --verbose)

RUN OPTIONS
  -r, --reporter <name> console (default) or json
      --json            Shorthand for --reporter json
      --json-stream     With --json: newline-delimited results as tests finish
      --include-events  Record the full event stream in .agentsnap/runs
  -t, --tag <tag>       Only run tests with this tag (repeatable)
      --exclude <glob>  Skip tests whose name or tag matches
  -b, --bail            Stop after the first failing test
  -C, --concurrency <n> Run up to n tests at once (default 1)
      --retries <n>     Override the retry budget for every test
  -T, --timeout <s>     Override the per-run timeout, in seconds
      --usage           Print estimated token cost at the end
      --events          Print the event stream for failing tests

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