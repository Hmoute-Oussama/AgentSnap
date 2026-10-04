# Adapters

An adapter is the bridge between AgentSnap and a specific coding agent. It knows three things: how
to launch the agent, how to turn its output into a normalized event stream, and how to report its
cost.

```yaml
agent:
  provider: claude-code   # selects the adapter
  model: claude-sonnet-4-5
  command: npx             # optional, for a locally installed agent
  args: []                 # optional extra argv
```

When `provider` is unset, AgentSnap infers it from the command: an executable named `claude`
selects `claude-code`, and `agentsnap doctor` reports which adapter was selected and why.

## Built-in adapters

### `claude-code`

Runs Claude Code in non-interactive print mode as a child process and parses its stream output
into events.

```yaml
agent:
  provider: claude-code
  model: claude-sonnet-4-5
  allowedTools: [Read, Edit, Write, Bash]
  disallowedTools: [WebFetch]
  permissionMode: acceptEdits
```

If the agent is not on `PATH`, point at it:

```yaml
agent:
  command: ./node_modules/.bin/claude
```

A missing executable produces a runtime error (exit code `3`) that tells you exactly what to
install or set, rather than a spawn stack trace.

### `fake`

A deterministic in-process provider used by AgentSnap's own test suite. It needs no API key, no
network and no model, and it produces the same shape of event stream as a real agent.

The prompt is a directive instead of prose:

| Directive | Effect |
| --- | --- |
| `text: <message>` | Append text to the agent's final output |
| `read: <path>` | Read a file |
| `write: <path> = <text>` | Create or overwrite a file |
| `append: <path> = <text>` | Append to a file |
| `delete: <path>` | Delete a file |
| `exec: <command>` | Execute a command in the sandbox, tokenized and shell-free |
| `ask: <tool>` | Grant a permission request for that tool (default `Bash`) |
| `network: <url>` | Record a network access attempt |
| `fail: <message>` | End the run with a non-fatal error |
| `hang` or `hang: <seconds>` | Never finish, to exercise timeouts |

```
text: Working on it.
read: README.md
exec: npm test
write: docs/plan.md = Draft plan.
```

Content is given inline after `=`, on the same line.

Any other line is appended to the agent's output, with one exception: a line that starts at column
zero with `word:` is treated as an attempt to script the agent, and an unrecognized word is
reported as a run error naming the supported directives. Indent a line to write it as prose.

That strictness is deliberate. `say: Deploying.` and `run: npm publish` are the words you reach
for first, and while they were silently treated as prose a test could pass with `output_contains`
having verified nothing but its own prompt.

The fake adapter is public on purpose. It is the only way to test a suite, a sandbox or a CI
pipeline without spending a token, and it makes failure messages reproducible.

## Writing your own

Implement the `AgentAdapter` interface and register it in `src/adapters/index.ts`.

```ts
import type { AgentAdapter, AdapterRequest, RunResult } from 'agentsnap';

export const myAdapter: AgentAdapter = {
  id: 'my-agent',
  label: 'My Agent',
  docsUrl: 'https://github.com/me/my-agent',

  /** Report what is required before a run is attempted: executable, keys, versions. */
  async checkAvailability(): Promise<{ available: boolean; problems: string[] }> {
    return { available: true, problems: [] };
  },

  async run(request: AdapterRequest, signal: AbortSignal): Promise<RunResult> {
    // Spawn argv-style, translate output into request.emit(...), report usage.
    return { exitCode: 0, events, usage: { inputTokens: 0, outputTokens: 0, costUsd: 0 } };
  },
};
```

An adapter must:

- Spawn the agent through `executeCommand`, never a shell.
- Emit events for tool calls, file changes, commands and permission requests as they happen, so
  assertions can be evaluated against a partial run if the agent fails.
- Honor `signal` and abort promptly. The runner enforces timeouts by aborting it.
- Not write outside the workspace it was handed.
- Report usage in `usage` so `--usage` and `maxCostUsd` mean something.

If your adapter needs to know how it is being called, `AdapterRequest` carries the resolved
prompt, the model, the tool permissions, the workspace path and the event emitter.

## Testing adapters

Test against `fake` first, then against the real adapter behind an opt-in integration suite, so
the fast path stays token-free:

```yaml
tests:
  - name: adapter regression
    skip: true
    skipReason: Requires a live agent; opt in locally.
    prompt: Add a CHANGELOG entry.
    assertions:
      - file_changed: "**/CHANGELOG.md"
```