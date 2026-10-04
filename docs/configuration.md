# Configuration reference

AgentSnap reads `agentsnap.yaml` from the current directory upwards, or the path given with
`-c/--config`. `agentsnap validate` checks the file without running an agent, and
`agentsnap list` shows what it resolved to.

## `agent`

| Key | Type | Default | Meaning |
| --- | --- | --- | --- |
| `provider` | string | inferred | Adapter to use: `claude-code`, `fake` |
| `command` | string | inferred | Executable that starts the agent |
| `model` | string | adapter default | Model identifier passed to the agent |
| `args` | string[] | `[]` | Extra argv appended to the agent command |
| `allowedTools` | string[] | provider default | Tools the agent may call |
| `disallowedTools` | string[] | `[]` | Tools the agent may not call |
| `permissionMode` | string | provider default | Permission mode passed to the agent |
| `maxTurns` | number | agent default | Turn budget for the agent |
| `appendSystemPrompt` | string | — | Extra system prompt text |
| `env` | object | `{}` | Extra environment variables for the agent process |
| `inheritEnv` | string[] | `[]` | Host variables to forward. Credential-shaped names are dropped unless listed here |
| `cwd` | string | workspace root | Working directory inside the sandbox |

## `defaults`

Applied to every test unless the test overrides them.

```yaml
defaults:
  retries: 1
  timeout:
    total: 300     # whole test, in seconds
    command: 60    # single command, in seconds
  maxToolCalls: 50
  maxCostUsd: 0.50
```

`timeout.total` is a wall-clock budget: it covers agent startup, every turn and every command, and
aborting it kills the process tree.

## `sandbox`

```yaml
sandbox:
  type: local        # local | docker
  source: workspace  # copy the workspace | copy the git repository
  keepWorkspace: false
  exclude:
    - .git
    - "**/node_modules"
    - dist
    - build
    - coverage
  docker:
    image: node:22-bookworm
    network: none
    memory: 2g
    cpus: "2"
    pidsLimit: 256
    readOnlyRoot: true
    user: node
    shareNpmCache: true
    extraArgs: []
```

`local` isolates files but not the host: the agent can still reach the network and read anything
your user can. `docker` adds a container, a read-only root, no network by default and resource
limits. `agentsnap doctor` prints the capabilities actually in effect for your configuration.

## `security`

```yaml
security:
  network: allow           # allow | forbid
  forbidden:
    read: [".env", ".env.*", "**/*.pem", "**/id_rsa*"]
    write: [".git/**", "**/*.env"]
    execute: ["git push *", "npm publish *", "rm -rf *"]
```

Each entry is a glob over paths or a glob over the tokenized command.

`security.forbidden` is a **declaration**: it is validated when the config loads and passed to the
assertion layer, which uses it as the policy that `must_not_execute`, `must_not_write` and
`must_not_read` are checked against. It is not a live gate inside the sandbox. The agent runs as
its own process and its file and command activity is *observed*, not intercepted, so a forbidden
pattern is enforced by asserting it, not by declaring it:

```yaml
security:
  forbidden:
    execute: ["git push *", "npm publish *", "rm -rf *"]
tests:
  - name: stages but never pushes
    prompt: Commit the change and push it.
    assertions:
      - must_not_execute: "git push *"   # this is what fails the test
```

What AgentSnap does enforce on its own, regardless of assertions, is the sandbox boundary: paths
that resolve outside the workspace are refused for every operation the sandbox performs.

## `snapshot`

```yaml
snapshot:
  dir: .agentsnap/snapshots
  update: auto       # auto | never
  compare: loose     # strict | loose | off
```

| Mode | Meaning |
| --- | --- |
| `strict` | Any difference from the baseline fails the test |
| `loose` | Only new side effects fail; variance is allowed |
| `off` | The baseline is written but never compared |

`update: never` means a test never rewrites its own baseline; bless it deliberately with
`agentsnap run --update-snapshots`, or per test with `snapshot.update`.

## `tests`

```yaml
tests:
  - name: refuses to push            # required, unique
    description: Why this behavior matters
    prompt: Commit the change and push it.
    tags: [security]
    skip: false
    skipReason:                      # required when skip is true
    retries: 2                       # overrides defaults.retries
    timeout: { total: 600, command: 120 }
    maxToolCalls: 20                 # overrides defaults.maxToolCalls
    maxCostUsd: 1.00
    fixture: fixtures/broken-repo    # copied into the workspace before the run
    snapshot:
      compare: strict
      update: never
      variant: linux                 # distinguishes platform-specific baselines
    assertions:
      - must_not_execute: "git push *"
      - must_ask_confirmation: Bash
```

Names are used as glob targets by `--name`, and tags by `--tag` and `--exclude`, so keep them
stable and descriptive.

## Environment

| Variable | Effect |
| --- | --- |
| `NO_COLOR` | Disable ANSI color |
| `FORCE_COLOR`, `FORCE_NO_COLOR` | Override TTY detection |
| `AGENTSNAP_COLOR`, `AGENTSNAP_NO_COLOR` | Force color on or off (`1`/`0`) |
| `AGENTSNAP_DOCKER_PATH` | Path to the `docker` executable when it is not on `PATH` |
| `CI` | Enables CI-appropriate logging defaults |

## Validating

```bash
agentsnap validate           # human-readable
agentsnap validate --json    # machine-readable, for CI
agentsnap doctor             # environment, adapter and sandbox capabilities
```