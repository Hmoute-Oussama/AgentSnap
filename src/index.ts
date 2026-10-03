/**
 * Public API.
 *
 * Everything exported here is stable for the documented 0.x surface. Deep imports into
 * `dist/` are not part of the contract.
 */

export { main, readToolVersion } from './cli/index.js';
export type { MainOptions } from './cli/index.js';

export {
  EXIT_CODE_DESCRIPTIONS,
  ExitCode,
  isExitCode,
  type ExitCodeValue,
} from './core/exit-codes.js';

export {
  AgentSnapError,
  ConfigError,
  errorMessage,
  isAgentSnapError,
  RuntimeError,
  SandboxError,
  TimeoutError,
  UsageError,
  type ErrorContext,
} from './core/errors.js';

export type {
  AgentFinishedEvent,
  AgentStartedEvent,
  CommandFinishedEvent,
  CommandStartedEvent,
  ErrorEvent,
  FileReadEvent,
  FileWrittenEvent,
  MessageEvent,
  NetworkRequestEvent,
  PermissionRequestEvent,
  ToolCallFinishedEvent,
  ToolCallStartedEvent,
} from './core/events.js';

export {
  EVENT_TYPES,
  EventRecorder,
  isEventType,
  type AgentEvent,
  type EventInput,
  type EventType,
  type FileChangeKind,
  type UsageInfo,
} from './core/events.js';

export {
  ASSERTION_STATUSES,
  EXIT_REASONS,
  RUN_STATUSES,
  type AssertionResult,
  type AssertionStatus,
  type CommandRecord,
  type DiagnosticEntry,
  type DiagnosticStatus,
  type ExitReason,
  type FileChanges,
  type FlakinessReport,
  type NetworkRecord,
  type PermissionRecord,
  type RunRecord,
  type RunStatus,
  type RunSummary,
  type SandboxInfo,
  type SuiteResult,
  type SuiteStatus,
  type SuiteTotals,
} from './core/types.js';

export {
  assertionsByGroup,
  describeAssertion,
  getAssertionDefinition,
  listAssertionKinds,
  parseAssertions,
  type AssertionContext,
  type AssertionDefinition,
  type AssertionGroup,
  type ParsedAssertion,
} from './assertions/definitions.js';

export { evaluateAssertions, resolveToolName } from './assertions/evaluate.js';

export {
  builtinAdapters,
  ConfigUnknownAdapter,
  getAdapter,
  parseVersion,
  probeAdapters,
  probeVersion,
  versionAtLeast,
  type AdapterProbe,
} from './adapters/registry.js';

export type {
  AgentAdapter,
  AgentCapabilities,
  AgentEventFragment,
  AgentResultFragment,
  AgentRunInput,
  DetectContext,
  DetectionResult,
} from './adapters/types.js';

export { claudeCodeAdapter, CLAUDE_MINIMUMS } from './adapters/claude-code.js';
export { fakeAdapter, FAKE_DIRECTIVE } from './adapters/fake.js';

export { loadConfig, resolveConfigPath, CONFIG_FILENAMES } from './config/index.js';
export { inspectRepository, type RepoProfile } from './config/discovery.js';
export {
  CONFIG_VERSION,
  DEFAULT_SECURITY,
  DEFAULT_SNAPSHOT,
  type AgentSnapConfig,
  type SandboxConfig,
  type TestCase,
} from './config/types.js';

export { runSuite, computeTotals, decideSuiteStatus, type RunSuiteOptions } from './runner/run-suite.js';
export { runTest, type RunTestOptions } from './runner/run-test.js';
export { createTestFilter, ALL_TESTS, type TestFilter } from './runner/filter.js';
export { projectRun, type ProjectedRun } from './runner/project.js';

export { createReporter, REPORTER_NAMES, type Reporter, type ReporterName } from './reporters/index.js';

export {
  createSandbox,
  type CreateSandboxOptions,
  type Sandbox,
  type SandboxCapabilities,
  type SpawnOptions,
  type WorkspaceApi,
} from './sandbox/index.js';

export { computeDelta, scanTree, type FileDelta, type FileEntry } from './utils/fsx.js';
export { createRedactor, REDACTION_PLACEHOLDER } from './utils/redact.js';
export { GLYPH, createColorizer, shouldUseColor } from './utils/color.js';