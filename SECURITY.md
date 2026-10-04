# Security Policy

## Reporting a vulnerability

Please report security issues privately through GitHub's
[security advisory form](https://github.com/Hmoute-Oussama/AgentSnap/security/advisories/new)
rather than opening a public issue. Include a description, the affected version, and a
reproduction if you have one. You can expect an acknowledgement within a few days.

Do not test against repositories or infrastructure you do not own.

## Supported versions

Only the latest published minor version receives security fixes.

## Threat model

AgentSnap runs a third-party AI agent against your source code. The agent is not trusted: it may
be misconfigured, prompted adversarially, or simply buggy. AgentSnap's job is to limit what such
a process can reach and to leave an audit trail.

**In scope:** a run that escapes its workspace, leaks a secret that was not in the agent's
environment, executes a command through a shell, or records unredacted secrets.

**Out of scope:** the agent's own judgment, prompt injection against the model, and anything
that requires write access to your machine before AgentSnap starts. AgentSnap does not defend a
compromised host.

## What AgentSnap enforces

### No shell, ever

Agent commands are tokenized and executed as argv with `shell: false`. A command containing
shell metacharacters (`|`, `&`, `;`, `>`, `<`, `$`, backticks, newlines) is rejected with an
explanation instead of being silently mis-executed, because a silently ignored `>` would produce
a passing test that asserted nothing.

### Environment allow-list

Child processes receive an explicit allow-list, not your environment. By default that includes
the process and temp directories, locale settings and `PATH`, plus anything the adapter needs.
CI and credential variables (`GITHUB_TOKEN`, `GH_TOKEN`, `ACTIONS_*`, `NPM_TOKEN`,
`SSH_AUTH_SOCK`, `GPG_TKEY`) are removed even if allow-listed, unless you opt in explicitly with
`agent.inheritEnv`.

On Windows, the operating system itself adds a small set of process variables (`SYSTEMROOT`,
`USERPROFILE`, `TEMP` and similar) to every child process. AgentSnap cannot prevent that, and
does not claim to.

### Workspace isolation

Every run executes in a throwaway copy of the repository. `sandbox.type: local` isolates files,
not the host: the agent can still read anything your user can read and reach the network.
`sandbox.type: docker` adds a container, a read-only root, no network by default, and CPU,
memory and pid limits. Use Docker mode when a test must not touch the host.

Paths are resolved against the workspace root, and traversal outside it is refused for every
operation the sandbox performs.

### What is observed rather than blocked

The agent is a separate process. AgentSnap sees the files it read and wrote, the commands it ran
and the tools it called, and asserts on that record. It does not sit between the agent and the
filesystem, so a forbidden pattern is detected by an assertion (`must_not_execute`,
`must_not_write`, `must_not_read`) rather than prevented by a hook.

`security.forbidden` is therefore a declaration: it is validated when the configuration loads and
provided to the assertion layer as the policy those assertions are checked against. Write the
assertion. Do not rely on the declaration alone.

What AgentSnap does block itself: shell metacharacters in commands it runs, and any path that
resolves outside the sandbox workspace.

### Redaction

Secrets detected in output, events and run records are replaced with a stable `[redacted:kind]`
marker before anything is written to disk, so `.agentsnap/runs/` and printed reports do not
become a place where credentials accumulate. Redaction is a safety net, not a substitute for not
handing the agent a secret in the first place.

### Process cleanup

Agent processes and the commands they spawn are terminated as a tree on timeout, failure or
interruption, so a stuck agent does not outlive the run that started it.

## What AgentSnap does not enforce

- It does not sandbox the model itself. Anything in the prompt can influence the agent.
- It does not verify that an assertion list is complete. A test with no assertions cannot fail.
- It does not prevent an agent from exfiltrating data it was legitimately allowed to read.
- Local mode does not restrict network access.

## Hardening recommendations

1. Run with `sandbox.type: docker` and `security.network: forbid` for untrusted prompts.
2. Keep `security.forbidden` populated with the paths and commands that must never be touched.
3. Do not put secrets in the environment of an AgentSnap run; pass only what the agent needs.
4. Commit `.agentsnap/snapshots/` so behavior changes are reviewed, and gitignore
   `.agentsnap/runs/` and `.agentsnap/tmp/`.
5. Run AgentSnap in CI on pull requests with `--bail` and `--reporter json` so a regression
   fails the build with a machine-readable reason.