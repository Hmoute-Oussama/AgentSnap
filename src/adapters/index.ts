export { claudeCodeAdapter, CLAUDE_MINIMUMS, DEFAULT_CLAUDE_COMMAND } from './claude-code.js';
export { fakeAdapter, runFakeAgent, FAKE_DIRECTIVE } from './fake.js';
export { resolveExecutable } from './executable.js';
export {
  builtinAdapters,
  clearVersionCache,
  describeSpawnFailure,
  getAdapter,
  parseVersion,
  probeAdapters,
  probeVersion,
  versionAtLeast,
} from './registry.js';
export type {
  AgentAdapter,
  AgentCapabilities,
  AgentEventFragment,
  AgentResultFragment,
  AgentRunInput,
  DetectContext,
  DetectionResult,
} from './types.js';
