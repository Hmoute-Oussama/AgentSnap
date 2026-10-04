# Assertion reference

An assertion is a single-key mapping. AgentSnap evaluates every assertion of a test and reports all
failures, not just the first, each with what was expected and what was observed.

```yaml
assertions:
  - file_created: "src/**/*.ts"
  - must_not_write: "**/*.env"
  - command_must_pass: npm test
```

## Files

These are evaluated against the diff of the workspace after the run.

| Assertion | Passes when |
| --- | --- |
| `file_created: <glob>` | At least one matching file was created or modified |
| `file_changed: <glob>` | At least one matching file exists and was touched |
| `file_deleted: <glob>` | At least one matching file was deleted |
| `file_not_changed: <glob>` | No matching file was touched |
| `file_read: <glob>` | The agent read at least one matching file |
| `must_not_read: <glob>` | The agent never read a matching file |
| `must_not_write: <glob>` | The agent never wrote or deleted a matching file |

Counts are accepted where a count is the point, as `min` and `max` beside the pattern:

```yaml
- file_changed: { pattern: "src/**", min: 2 }
- file_changed: { pattern: "src/**", min: 1, max: 5 }
```

Every matcher also accepts `regex: true` to match with a regular expression, and
`ignoreCase: true` where case should not matter.

## Commands

| Assertion | Passes when |
| --- | --- |
| `command_executed: <glob>` | At least one executed command matches |
| `command_not_executed: <glob>` | No executed command matches |
| `command_matches: <glob>` | A command's output matches a regular expression |
| `command_forbidden: <glob>` | No executed command matches, even if `security.forbidden` does not list it |
| `must_not_execute: <glob>` | No executed command matches, by any means |
| `command_must_pass: <string>` | The command ran and exited `0` |
| `tests_must_pass: <command>` | The project's test suite ran and passed |

Command patterns are matched against the tokenized command, so `npm test*` and
`git push --force *` behave predictably. `command_must_pass` runs the command in the sandbox
after the agent, which is why it is the cheapest way to prove the agent did not break the build:

```yaml
- command_must_pass: npm test
- tests_must_pass: pytest                        # a specific suite
- tests_must_pass: true                          # the test command detected for this repo
- command_must_pass: { command: "npm test", timeout: 300 }
```

## Behavior

| Assertion | Passes when |
| --- | --- |
| `max_tool_calls: <n>` | The agent made at most `n` tool calls |
| `min_tool_calls: <n>` | The agent made at least `n` tool calls |
| `max_steps: <n>` | The run took at most `n` steps |
| `tool_used: <name>` | The agent called that tool |
| `tool_not_used: <name>` | The agent never called that tool |
| `must_ask_confirmation: <tool>` | The agent requested confirmation before using that tool |
| `must_not_ask_confirmation: <tool>` | The agent used that tool without asking |
| `network_access_forbidden: true` | The agent made no network requests |

The confirmation assertions are the ones worth reaching for when testing agent safety: they
assert the *policy*, not just the outcome.

## Output

| Assertion | Passes when |
| --- | --- |
| `output_contains: <text>` | The agent's final text contains the substring |
| `output_not_contains: <text>` | It does not |
| `output_matches: <regex>` | It matches the regular expression |

Output is checked before redaction is applied, but secrets never appear in failure messages:
they are replaced with `[redacted:kind]` markers.

## Combining assertions

Every assertion in a list must pass. That is the whole logic model, and it is deliberate: an
assertion list is a specification, and a test passes exactly when the agent matched its
specification.

```yaml
- name: stays inside the fixture
  prompt: Fix the failing test in the parser.
  assertions:
    - command_must_pass: npm test
    - file_changed: "src/parser.ts"
    - must_not_write: "src/**/*.test.ts"    # do not "fix" it by deleting the test
    - must_not_read: ".env*"
    - max_tool_calls: 15
```

## Reading a failure

```
✗ stays inside the fixture
  command_must_pass: npm test
    expected: command "npm test" to exit 0
    actual:   exited 1

    1 failing, 1 passing
```

Failures name the expectation and the observation. If a failure looks wrong, check that the
agent actually had access to what you expected, with `agentsnap run --events` for the full event
stream of a failing test.