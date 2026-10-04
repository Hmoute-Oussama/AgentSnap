# AgentSnap

**Unit tests for AI agents.** Write down what an agent should and must not do, run it against a
real coding agent in an isolated workspace, and get a pass/fail verdict plus a diff of what
actually changed.

AgentSnap is not a mock. It launches the agent you already use, gives it a copy of your
repository, records every file it read, wrote or deleted, every command it ran and every tool it
called, then asserts on that behavior. When the agent's behavior changes, the test fails and
tells you what changed.

```bash
npm install --save-dev agentsnap
npx agentsnap init
npx agentsnap run
```

## Why

Agent code is ordinary code that happens to be nondeterministic, which makes it easy to ship a
regression and hard to notice one. Prompt edits, model updates and tool changes all alter
behavior without touching a line of your source. AgentSnap gives that behavior a test suite:

- **Assertions, not vibes.** `must_not_read: .env*`, `command_must_pass: npm test`,
  `max_tool_calls: 12` are checks with exit codes, not suggestions.
- **Behavioral snapshots.** Each run is reduced to the set of files touched, commands run, files
  read and tools called. New side effects fail the test; ordinary variance does not.
- **Real isolation.** Every run executes in a throwaway copy of your project, so a test cannot
  damage your working tree. Docker mode adds network and resource isolation.
- **No shell, ever.** Agent commands are executed as argv, never through a shell, so a prompt
  cannot smuggle in a pipe or a `&&`.
- **Honest output.** One exit code per failure class, JSON for CI, and failure messages that say
  what was expected and what was observed.

## Quick start

`npx agentsnap init` inspects your repository, detects the package manager and test command, and
writes an `agentsnap.yaml`:

```yaml
version: 1
agent:
  provider: claude-code
  model: claude-sonnet-4-5
tests:
  - name: adds a documented change
    prompt: Add a short section to README.md describing how to run the tests.
    assertions:
      - file_created: "**/*.md"
      - must_not_write: "src/**"
      - command_must_pass: npm test
```

Then:

```bash
agentsnap validate            # configuration only, no agent, no cost
agentsnap list                # what is configured
agentsnap run                 # run the tests
agentsnap run --tag security --bail
agentsnap run --reporter json > report.json
```

## Commands

| Command | What it does |
| --- | --- |
| `agentsnap run` (`test`) | Runs the selected tests and asserts their behavior |
| `agentsnap init` | Writes an `agentsnap.yaml` for this repository |
| `agentsnap list` (`ls`) | Lists configured tests and their assertions |
| `agentsnap validate` (`check`) | Validates the configuration without running an agent |
| `agentsnap doctor` | Diagnoses the environment, the agent runtime and the sandbox |
| `agentsnap help`, `agentsnap version` | Help and version |

Run `agentsnap <command> --help` for the options of a single command.

## Exit codes

| Code | Name | Meaning |
| --- | --- | --- |
| `0` | success | Every selected test passed |
| `1` | test-failure | A test failed, or a behavioral regression was detected |
| `2` | config-error | Configuration is missing or invalid |
| `3` | runtime-error | Infrastructure failure: agent missing, spawn or sandbox failure |
| `4` | timeout | A configured timeout was exceeded |
| `130` | interrupted | Interrupted by the user |

Distinct codes matter in CI: a broken config should not look like a failing test, and an agent
that cannot start should not look like either.

## Assertions

Every assertion is one mapping with exactly one key.

**Files** — `file_changed`, `file_created`, `file_deleted`, `file_read`, `file_not_changed`,
`file_not_read`, `must_not_read`, `must_not_write`

**Commands** — `command_executed`, `command_not_executed`, `command_matches`,
`command_forbidden`, `must_not_execute`, `command_must_pass`, `tests_must_pass`

**Behavior** — `max_tool_calls`, `min_tool_calls`, `max_steps`, `tool_used`, `tool_not_used`,
`must_ask_confirmation`, `must_not_ask_confirmation`, `network_access_forbidden`

**Output** — `output_contains`, `output_not_contains`, `output_matches`

```yaml
assertions:
  - file_created: "src/**/*.ts"      # at least one match was created or modified
  - must_not_write: "**/*.env"        # never wrote a secret
  - command_must_pass: npm test      # ran the project's own test suite, and it passed
  - max_tool_calls: 12               # stayed within budget
  - must_ask_confirmation: Bash      # asked before running anything
  - network_access_forbidden: true   # made no network requests
```

Counts are supported where it helps: `max_tool_calls: 12`, `file_changed: { pattern: "src/**", min: 2, max: 5 }`.

## Behavioral snapshots

The first run records a baseline under `.agentsnap/snapshots/`. Later runs compare against it and
report differences:

```
✗ the agent behaves like the recorded baseline
  behavior differs from the recorded baseline:
  new file: src/upload.ts
  new tool: Bash
```

| Mode | Behavior |
| --- | --- |
| `loose` (default) | Only *new* side effects fail. Variance is not a regression. |
| `strict` | Any difference fails. Use when a test must be byte-for-byte reproducible. |
| `off` | Snapshots are recorded but never compared. |

```bash
agentsnap run --snapshot-mode strict   # override the mode for this run
agentsnap run --update-snapshots       # accept this run as the new baseline
```

Baselines are meant to be committed: a snapshot diff in review is a behavioral diff in review.
Use `snapshot.update: never` on a test whose baseline must be blessed deliberately.

## Sandboxing

| | `sandbox.type: local` | `sandbox.type: docker` |
| --- | --- | --- |
| Filesystem | throwaway copy of the repo | container with a read-only root |
| Network | inherited from your machine | `none` by default |
| CPU / memory / pids | your machine | capped |
| Speed | fast | slower; needs a running Docker |

`local` mode is honest about what it is: the workspace is isolated, the host is not. Use
`docker` when a test needs the network switched off or resource limits enforced.
`agentsnap doctor` prints exactly which capabilities are in effect.

## Security posture

- Agent processes are spawned with an explicit environment allow-list, never your full
  environment. `GITHUB_TOKEN`, `SSH_AUTH_SOCK` and friends are dropped by default.
- Commands are tokenized and executed as argv with `shell: false`. Shell metacharacters are
  rejected with an explanation instead of being silently ignored.
- Paths that resolve outside the sandbox are refused for every operation the sandbox performs.
- Secrets found in output, events and run records are redacted before anything is written.
- Everything a run records lands in `.agentsnap/`; add `.agentsnap/tmp/` and `.agentsnap/runs/`
  to `.gitignore` and commit `.agentsnap/snapshots/`.

The agent's own file and command activity is observed, not intercepted: a test fails because an
assertion saw the agent do something forbidden, not because the sandbox blocked it.

See [SECURITY.md](SECURITY.md) for the full model and how to report a vulnerability.

## CI

```yaml
- run: npm ci
- run: npm run build
- run: npx agentsnap run --reporter json > agentsnap-report.json
- if: always()
  uses: Hmoute-Oussama/AgentSnap/.github/actions/agentsnap@v1
  with:
    report: agentsnap-report.json
```

Or use the composite action directly:

```yaml
- uses: Hmoute-Oussama/AgentSnap/.github/actions/agentsnap@v1
```

## Documentation

- [Configuration reference](docs/configuration.md)
- [Assertion reference](docs/assertions.md)
- [Adapters](docs/adapters.md)
- [Security model](SECURITY.md)
- [Changelog](CHANGELOG.md)

## Contributing

```bash
npm install
npm run verify     # lint, typecheck, build, full test suite
npm run check:package
npm run check:install
```

The suite has three layers: unit tests for pure logic, integration tests that drive the real
sandbox and runner with the deterministic `fake` provider, and end-to-end tests that run the
built binary as a child process. The fake provider means CI never spends a token and never
depends on a model being available.

## License

MIT