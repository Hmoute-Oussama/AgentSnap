# Changelog

All notable changes to this project are documented in this file. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.1.0]

Initial release.

### Added

- `agentsnap run`, `init`, `list`, `validate` and `doctor`, with a distinct exit code per failure
  class: `0` success, `1` test failure, `2` config error, `3` runtime error, `4` timeout, `130`
  interrupted.
- Assertions covering files, commands, behavior budgets, permission prompts, network access and
  agent output, each reported with the expectation and what was actually observed.
- Behavioral snapshots: each run is normalized to the files touched, commands run, files read
  and tools called, then compared in `strict`, `loose` or `off` mode. `loose` fails only on new
  side effects, because an agent that skipped a step it used to take is usually variance.
  Baselines are blessed with `--update-snapshots` and never rewritten silently.
- Sandboxing: a throwaway workspace copy by default, plus a Docker mode with a read-only root,
  no network and CPU, memory and pid limits. `agentsnap doctor` reports which capabilities are
  actually in effect.
- Adapters for `claude-code` and a deterministic in-process `fake` provider used by AgentSnap's
  own test suite, so CI spends no tokens and depends on no model.
- Security posture: argv-only execution with no shell, environment allow-list with CI and
  credential variables dropped by default, path-traversal guards, secret redaction before
  anything is persisted, and process-tree cleanup on timeout or interruption.
- Machine-readable output through `--reporter json` and `--json-stream`.
- Run records and suite summaries written under `.agentsnap/`.

[Unreleased]: https://github.com/Hmoute-Oussama/AgentSnap/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/Hmoute-Oussama/AgentSnap/releases/tag/v0.1.0