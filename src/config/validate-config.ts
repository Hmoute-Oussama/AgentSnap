import { parseAssertions } from '../assertions/definitions.js';
import { isKnownProvider, KNOWN_PROVIDERS } from '../adapters/providers.js';
import { isInside, resolveWithin, toPosixPath } from '../utils/paths.js';
import {
  formatIssues,
  isPlainObject,
  issue,
  joinPath,
  rejectUnknownKeys,
  requireBoolean,
  requireEnum,
  requireNonNegativeNumber,
  requireObject,
  requireString,
  requireStringArray,
  type Issue,
} from '../utils/validate.js';
import { existsSync, statSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';
import {
  CONFIG_VERSION,
  DEFAULT_SANDBOX,
  DEFAULT_SECURITY,
  DEFAULT_SNAPSHOT,
  DEFAULT_TEST_TIMEOUT,
  type AgentConfig,
  type AgentSnapConfig,
  type DefaultsConfig,
  type DockerSandboxConfig,
  type ForbiddenPolicy,
  type SandboxConfig,
  type SecurityConfig,
  type SnapshotConfig,
  type TestCase,
  type TimeoutConfig,
} from './types.js';

export interface ValidationOptions {
  configPath: string;
  rootDir: string;
}

export interface ValidationResult {
  config: AgentSnapConfig;
  issues: Issue[];
}

const TEST_KEYS = [
  'name',
  'description',
  'prompt',
  'tags',
  'skip',
  'skipReason',
  'fixture',
  'assertions',
  'timeout',
  'retries',
  'maxToolCalls',
  'maxCostUsd',
  'snapshot',
] as const;

/**
 * Validates the whole document and produces a fully-defaulted config.
 *
 * The returned config is always usable (defaults applied) so that tooling such as
 * `agentsnap doctor` can report on a partially invalid file; the caller decides whether
 * the collected issues are fatal.
 */
export function validateConfig(
  document: Record<string, unknown>,
  options: ValidationOptions,
): ValidationResult {
  const issues: Issue[] = [];
  const rootDir = resolve(options.rootDir);

  const agent = readAgent(document['agent'], issues);
  const sandbox = readSandbox(document['sandbox'], issues);
  const defaults = readDefaults(document['defaults'], issues);
  const snapshot = readSnapshot(document['snapshot'], issues);
  const security = readSecurity(document['security'], issues);
  const tests = readTests(document['tests'], issues, { defaults, rootDir, snapshot });

  issues.push(...rejectUnknownKeys(document, ['version', 'agent', 'sandbox', 'defaults', 'snapshot', 'security', 'tests'], ''));

  // A config written for a future AgentSnap must fail loudly rather than be silently
  // reinterpreted against today's schema, which is how "it ran but ignored my settings"
  // bugs start.
  const declaredVersion = document['version'];
  if (declaredVersion !== undefined && declaredVersion !== CONFIG_VERSION) {
    issues.push({
      hint: `Set \`version: ${CONFIG_VERSION}\`.`,
      message: `is ${JSON.stringify(declaredVersion)}, but this AgentSnap only understands \`version: ${CONFIG_VERSION}\`.`,
      path: 'version',
    });
  }


  const config: AgentSnapConfig = {
    agent,
    configPath: resolve(options.configPath),
    defaults,
    rootDir,
    sandbox,
    security,
    snapshot,
    tests,
    version: CONFIG_VERSION,
  };
  return { config, issues };
}

function readAgent(raw: unknown, issues: Issue[]): AgentConfig {
  const agent: AgentConfig = { provider: '' };
  if (raw === undefined) {
    issues.push({
      path: 'agent',
      message: 'is required.',
      hint: 'Add a provider, for example:\n    agent:\n      provider: claude-code',
    });
    return agent;
  }
  if (!isPlainObject(raw)) {
    issues.push({ ...issue('agent', 'expected a mapping.'), path: 'agent' });
    return agent;
  }
  issues.push(
    ...rejectUnknownKeys(
      raw,
      [
        'provider',
        'command',
        'model',
        'args',
        'allowedTools',
        'disallowedTools',
        'permissionMode',
        'maxTurns',
        'appendSystemPrompt',
        'env',
        'inheritEnv',
        'cwd',
      ],
      'agent',
    ),
  );

  const provider = raw['provider'];
  if (provider === undefined) {
    issues.push({
      path: 'agent.provider',
      message: 'is required.',
      hint: 'Choose an adapter name, for example `claude-code`. Run `agentsnap doctor` to list detected adapters.',
    });
} else if (typeof provider !== 'string' || provider.trim() === '') {
    issues.push({ path: 'agent.provider', message: 'must be a non-empty string.' });
  } else if (!isKnownProvider(provider.trim())) {
    issues.push({
      hint: `Set \`agent.provider\` to one of: ${KNOWN_PROVIDERS.join(', ')}. Run \`agentsnap doctor\` to see which runtimes are detected on this machine.`,
      message: `unknown provider ${JSON.stringify(provider.trim())}.`,
      path: 'agent.provider',
    });
  } else {
    agent.provider = provider.trim();
  }

  assignString(raw, 'command', 'agent.command', issues, agent);
  assignString(raw, 'model', 'agent.model', issues, agent);
  assignString(raw, 'permissionMode', 'agent.permissionMode', issues, agent);
  assignString(raw, 'appendSystemPrompt', 'agent.appendSystemPrompt', issues, agent);
  assignString(raw, 'cwd', 'agent.cwd', issues, agent);
  if (raw['bare'] !== undefined) {
    issues.push(...requireBoolean(raw['bare'], 'agent.bare'));
    if (typeof raw['bare'] === 'boolean') agent.bare = raw['bare'];
  }

  if (raw['args'] !== undefined) {
    issues.push(...requireStringArray(raw['args'], 'agent.args'));
    if (Array.isArray(raw['args'])) agent.args = raw['args'] as string[];
  }
  if (raw['allowedTools'] !== undefined) {
    issues.push(...requireStringArray(raw['allowedTools'], 'agent.allowedTools'));
    if (Array.isArray(raw['allowedTools'])) agent.allowedTools = raw['allowedTools'] as string[];
  }
  if (raw['disallowedTools'] !== undefined) {
    issues.push(...requireStringArray(raw['disallowedTools'], 'agent.disallowedTools'));
    if (Array.isArray(raw['disallowedTools'])) agent.disallowedTools = raw['disallowedTools'] as string[];
  }
  if (raw['inheritEnv'] !== undefined) {
    issues.push(...requireStringArray(raw['inheritEnv'], 'agent.inheritEnv'));
    if (Array.isArray(raw['inheritEnv'])) agent.inheritEnv = raw['inheritEnv'] as string[];
  }
  if (raw['maxTurns'] !== undefined) {
    issues.push(...requireNonNegativeNumber(raw['maxTurns'], 'agent.maxTurns', { integer: true, min: 1 }));
    if (typeof raw['maxTurns'] === 'number') agent.maxTurns = raw['maxTurns'];
  }
  if (raw['env'] !== undefined) {
    issues.push(...requireObject(raw['env'], 'agent.env'));
    if (isPlainObject(raw['env'])) {
      agent.env = {};
      for (const [key, value] of Object.entries(raw['env'])) {
        if (typeof value !== 'string') {
          issues.push({ path: `agent.env.${key}`, message: 'must be a string.' });
          continue;
        }
        agent.env[key] = value;
      }
    }
  }
  return agent;
}

function readSandbox(raw: unknown, issues: Issue[]): SandboxConfig {
  const sandbox: SandboxConfig = structuredClone(DEFAULT_SANDBOX);
  if (raw === undefined) return sandbox;
  if (!isPlainObject(raw)) {
    issues.push({ path: 'sandbox', message: 'expected a mapping.' });
    return sandbox;
  }
  issues.push(...rejectUnknownKeys(raw, ['type', 'source', 'exclude', 'keepWorkspace', 'docker'], 'sandbox'));

  if (raw['type'] !== undefined) {
    issues.push(...requireEnum(raw['type'], ['local', 'docker'] as const, 'sandbox.type'));
    if (raw['type'] === 'local' || raw['type'] === 'docker') sandbox.type = raw['type'];
  }
  if (raw['source'] !== undefined) {
    issues.push(...requireEnum(raw['source'], ['workspace', 'repo'] as const, 'sandbox.source'));
    if (raw['source'] === 'workspace' || raw['source'] === 'repo') sandbox.source = raw['source'];
  }
  if (raw['exclude'] !== undefined) {
    issues.push(...requireStringArray(raw['exclude'], 'sandbox.exclude'));
    if (Array.isArray(raw['exclude'])) sandbox.exclude = raw['exclude'] as string[];
  }
  if (raw['keepWorkspace'] !== undefined) {
    issues.push(...requireBoolean(raw['keepWorkspace'], 'sandbox.keepWorkspace'));
    if (typeof raw['keepWorkspace'] === 'boolean') sandbox.keepWorkspace = raw['keepWorkspace'];
  }
  if (raw['docker'] !== undefined) {
    if (!isPlainObject(raw['docker'])) {
      issues.push({ path: 'sandbox.docker', message: 'expected a mapping.' });
    } else {
      issues.push(
        ...rejectUnknownKeys(
          raw['docker'],
          ['image', 'network', 'memory', 'cpus', 'pidsLimit', 'readOnlyRoot', 'user', 'extraArgs', 'shareNpmCache'],
          'sandbox.docker',
        ),
      );
      sandbox.docker = readDocker(raw['docker'], issues);
    }
  }
  return sandbox;
}

function readDocker(raw: Record<string, unknown>, issues: Issue[]): DockerSandboxConfig {
  const docker: DockerSandboxConfig = { ...DEFAULT_SANDBOX.docker };
  if (typeof raw['image'] === 'string' && raw['image'].trim() !== '') docker.image = raw['image'].trim();
  else if (raw['image'] !== undefined) issues.push({ path: 'sandbox.docker.image', message: 'must be a non-empty string.' });

  if (raw['network'] !== undefined) {
    issues.push(...requireEnum(raw['network'], ['none', 'bridge'] as const, 'sandbox.docker.network'));
    if (raw['network'] === 'none' || raw['network'] === 'bridge') docker.network = raw['network'];
  }
  for (const key of ['memory', 'cpus', 'user'] as const) {
    const value = raw[key];
    if (value === undefined) continue;
    if (typeof value === 'string' && value.trim() !== '') docker[key] = value.trim();
    else issues.push({ path: `sandbox.docker.${key}`, message: 'must be a non-empty string.' });
  }
  if (raw['pidsLimit'] !== undefined) {
    issues.push(...requireNonNegativeNumber(raw['pidsLimit'], 'sandbox.docker.pidsLimit', { integer: true, min: 1 }));
    if (typeof raw['pidsLimit'] === 'number') docker.pidsLimit = raw['pidsLimit'];
  }
  if (raw['readOnlyRoot'] !== undefined) {
    issues.push(...requireBoolean(raw['readOnlyRoot'], 'sandbox.docker.readOnlyRoot'));
    if (typeof raw['readOnlyRoot'] === 'boolean') docker.readOnlyRoot = raw['readOnlyRoot'];
  }
  if (raw['shareNpmCache'] !== undefined) {
    issues.push(...requireBoolean(raw['shareNpmCache'], 'sandbox.docker.shareNpmCache'));
    if (typeof raw['shareNpmCache'] === 'boolean') docker.shareNpmCache = raw['shareNpmCache'];
  }
  if (raw['extraArgs'] !== undefined) {
    issues.push(...requireStringArray(raw['extraArgs'], 'sandbox.docker.extraArgs'));
    if (Array.isArray(raw['extraArgs'])) docker.extraArgs = raw['extraArgs'] as string[];
  }
  return docker;
}

function readDefaults(raw: unknown, issues: Issue[]): DefaultsConfig {
  const defaults: DefaultsConfig = {
    maxCostUsd: null,
    maxToolCalls: null,
    retries: 0,
    timeout: { ...DEFAULT_TEST_TIMEOUT },
  };
  if (raw === undefined) return defaults;
  if (!isPlainObject(raw)) {
    issues.push({ path: 'defaults', message: 'expected a mapping.' });
    return defaults;
  }
  issues.push(...rejectUnknownKeys(raw, ['timeout', 'retries', 'maxToolCalls', 'maxCostUsd'], 'defaults'));

  if (raw['timeout'] !== undefined) {
    if (!isPlainObject(raw['timeout'])) {
      issues.push({ path: 'defaults.timeout', message: 'expected a mapping with `total` and `command` (seconds).' });
    } else {
      issues.push(...rejectUnknownKeys(raw['timeout'], ['total', 'command'], 'defaults.timeout'));
      defaults.timeout = readTimeout(raw['timeout'], 'defaults.timeout', issues, defaults.timeout);
    }
  }
  if (raw['retries'] !== undefined) {
    issues.push(...requireNonNegativeNumber(raw['retries'], 'defaults.retries', { integer: true, min: 0 }));
    if (typeof raw['retries'] === 'number') defaults.retries = raw['retries'];
  }
  if (raw['maxToolCalls'] !== undefined) {
    issues.push(...requireNonNegativeNumber(raw['maxToolCalls'], 'defaults.maxToolCalls', { integer: true, min: 0 }));
    if (typeof raw['maxToolCalls'] === 'number') defaults.maxToolCalls = raw['maxToolCalls'];
  }
  if (raw['maxCostUsd'] !== undefined) {
    issues.push(...requireNonNegativeNumber(raw['maxCostUsd'], 'defaults.maxCostUsd', { min: 0 }));
    if (typeof raw['maxCostUsd'] === 'number') defaults.maxCostUsd = raw['maxCostUsd'];
  }
  return defaults;
}

function readTimeout(raw: Record<string, unknown>, path: string, issues: Issue[], base: TimeoutConfig): TimeoutConfig {
  const timeout: TimeoutConfig = { ...base };
  for (const key of ['total', 'command'] as const) {
    const value = raw[key];
    if (value === undefined) continue;
    issues.push(...requireNonNegativeNumber(value, joinPath(path, key), { min: 1 }));
    if (typeof value === 'number') timeout[key] = value;
  }
  if (timeout.command > timeout.total) {
    issues.push({
      path: joinPath(path, 'command'),
      message: `is ${timeout.command}s which exceeds the total budget of ${timeout.total}s.`,
      hint: 'The per-command timeout must be smaller than the total timeout.',
    });
  }
  return timeout;
}

function readSnapshot(raw: unknown, issues: Issue[]): SnapshotConfig {
  const snapshot: SnapshotConfig = { ...DEFAULT_SNAPSHOT };
  if (raw === undefined) return snapshot;
  if (!isPlainObject(raw)) {
    issues.push({ path: 'snapshot', message: 'expected a mapping.' });
    return snapshot;
  }
  issues.push(...rejectUnknownKeys(raw, ['compare', 'dir', 'update'], 'snapshot'));
  if (typeof raw['dir'] === 'string' && raw['dir'].trim() !== '') {
    const dir = raw['dir'].trim();
    if (isAbsolute(dir)) {
      issues.push({ path: 'snapshot.dir', message: 'must be relative to the project root.' });
    } else {
      snapshot.dir = toPosixPath(dir);
    }
  } else if (raw['dir'] !== undefined) {
    issues.push({ path: 'snapshot.dir', message: 'must be a non-empty relative path.' });
  }
if (raw['update'] !== undefined) {
    issues.push(...requireEnum(raw['update'], ['auto', 'never'] as const, 'snapshot.update'));
    if (raw['update'] === 'auto' || raw['update'] === 'never') snapshot.update = raw['update'];
  }
  if (raw['compare'] !== undefined) {
    issues.push(...requireEnum(raw['compare'], ['strict', 'loose', 'off'] as const, 'snapshot.compare'));
    if (raw['compare'] === 'strict' || raw['compare'] === 'loose' || raw['compare'] === 'off') {
      snapshot.compare = raw['compare'];
    }
  }
  return snapshot;
}

function readSecurity(raw: unknown, issues: Issue[]): SecurityConfig {
  const security: SecurityConfig = structuredClone(DEFAULT_SECURITY);
  if (raw === undefined) return security;
  if (!isPlainObject(raw)) {
    issues.push({ path: 'security', message: 'expected a mapping.' });
    return security;
  }
  issues.push(...rejectUnknownKeys(raw, ['forbidden', 'network'], 'security'));

  if (raw['forbidden'] !== undefined) {
    if (!isPlainObject(raw['forbidden'])) {
      issues.push({ path: 'security.forbidden', message: 'expected a mapping with `read`, `write`, `execute`.' });
    } else {
      issues.push(...rejectUnknownKeys(raw['forbidden'], ['read', 'write', 'execute'], 'security.forbidden'));
      const forbidden: ForbiddenPolicy = { execute: [], read: [], write: [] };
      for (const key of ['read', 'write', 'execute'] as const) {
        const value = raw['forbidden'][key];
        if (value === undefined) continue;
        issues.push(...requireStringArray(value, `security.forbidden.${key}`));
        if (Array.isArray(value)) forbidden[key] = (value as string[]).map((pattern) => ({ pattern }));
      }
      security.forbidden = forbidden;
    }
  }

  if (raw['network'] !== undefined) {
    issues.push(...requireEnum(raw['network'], ['forbid', 'allow'] as const, 'security.network'));
    if (raw['network'] === 'forbid' || raw['network'] === 'allow') security.network = raw['network'];
  }
  return security;
}

function readTests(
  raw: unknown,
  issues: Issue[],
  context: { defaults: DefaultsConfig; rootDir: string; snapshot: SnapshotConfig },
): TestCase[] {
  if (raw === undefined) {
    issues.push({
      path: 'tests',
      message: 'is required.',
      hint: 'Add at least one test:\n    tests:\n      - name: my-first-test\n        prompt: What does this project do?\n        assertions:\n          - file_read: "**/*.md"',
    });
    return [];
  }
  if (!Array.isArray(raw)) {
    issues.push({ path: 'tests', message: 'expected a list of test definitions.' });
    return [];
  }
  if (raw.length === 0) {
    issues.push({ path: 'tests', message: 'must contain at least one test.' });
    return [];
  }

  const tests: TestCase[] = [];
  const seen = new Map<string, number>();

  raw.forEach((entry, index) => {
    const path = `tests[${index}]`;
    if (!isPlainObject(entry)) {
      issues.push({ path, message: 'expected a mapping describing one test.' });
      return;
    }
    issues.push(...rejectUnknownKeys(entry, TEST_KEYS, path));

    const name = entry['name'];
    let testName = '';
    if (name === undefined) {
      issues.push({ path: `${path}.name`, message: 'is required.' });
    } else if (typeof name !== 'string' || name.trim() === '') {
      issues.push({ path: `${path}.name`, message: 'must be a non-empty string.' });
    } else {
      testName = name.trim();
      const previous = seen.get(testName);
      if (previous !== undefined) {
        issues.push({
          path: `${path}.name`,
          message: `duplicates the name used at tests[${previous}].`,
          hint: 'Test names must be unique because they key reports and snapshot files.',
        });
      } else {
        seen.set(testName, index);
      }
    }

    const prompt = entry['prompt'];
    let promptText = '';
    if (prompt === undefined) {
      issues.push({
        path: `${path}.prompt`,
        message: 'is required.',
        hint: 'Use a block scalar for multi-line prompts, for example `prompt: |`.',
      });
    } else if (typeof prompt !== 'string' || prompt.trim() === '') {
      issues.push({ path: `${path}.prompt`, message: 'must be a non-empty string.' });
    } else {
      promptText = prompt;
    }

    const parsedAssertions = parseAssertions(entry['assertions'], `${path}.assertions`);
    issues.push(...parsedAssertions.issues);
    if (entry['assertions'] === undefined) {
      issues.push({
        path: `${path}.assertions`,
        message: 'is required.',
        hint: 'A test without assertions cannot fail. Add at least one expectation, e.g. `- max_tool_calls: 10`.',
      });
    }

    const test: TestCase = {
      assertions: parsedAssertions.assertions,
      description: typeof entry['description'] === 'string' ? entry['description'] : '',
      fixture: null,
      maxCostUsd: context.defaults.maxCostUsd,
      maxToolCalls: context.defaults.maxToolCalls,
      name: testName,
      prompt: promptText,
      retries: context.defaults.retries,
      skip: false,
      skipReason: '',
      snapshot: { compare: context.snapshot.compare, update: context.snapshot.update, variant: 'default' },
      tags: [],
      timeout: { ...context.defaults.timeout },
    };

    if (entry['description'] !== undefined && typeof entry['description'] !== 'string') {
      issues.push({ path: `${path}.description`, message: 'must be a string.' });
    }
    if (entry['tags'] !== undefined) {
      issues.push(...requireStringArray(entry['tags'], `${path}.tags`));
      if (Array.isArray(entry['tags'])) test.tags = entry['tags'] as string[];
    }
    if (entry['skip'] !== undefined) {
      issues.push(...requireBoolean(entry['skip'], `${path}.skip`));
      if (typeof entry['skip'] === 'boolean') test.skip = entry['skip'];
    }
    if (entry['skipReason'] !== undefined) {
      issues.push(...requireString(entry['skipReason'], `${path}.skipReason`));
      if (typeof entry['skipReason'] === 'string') test.skipReason = entry['skipReason'];
    }
    if (test.skip && test.skipReason === '') {
      issues.push({
        path: `${path}.skipReason`,
        message: 'is required when `skip: true`.',
        hint: 'Explain why the test is skipped so reviewers can tell a placeholder from a decision.',
      });
    }
    if (entry['retries'] !== undefined) {
      issues.push(...requireNonNegativeNumber(entry['retries'], `${path}.retries`, { integer: true, min: 0 }));
      if (typeof entry['retries'] === 'number') test.retries = entry['retries'];
    }
    if (entry['maxToolCalls'] !== undefined) {
      issues.push(...requireNonNegativeNumber(entry['maxToolCalls'], `${path}.maxToolCalls`, { integer: true, min: 0 }));
      if (typeof entry['maxToolCalls'] === 'number') test.maxToolCalls = entry['maxToolCalls'];
    }
    if (entry['maxCostUsd'] !== undefined) {
      issues.push(...requireNonNegativeNumber(entry['maxCostUsd'], `${path}.maxCostUsd`, { min: 0 }));
      if (typeof entry['maxCostUsd'] === 'number') test.maxCostUsd = entry['maxCostUsd'];
    }
    if (entry['timeout'] !== undefined) {
      if (!isPlainObject(entry['timeout'])) {
        issues.push({ path: `${path}.timeout`, message: 'expected a mapping with `total` and `command` (seconds).' });
      } else {
        issues.push(...rejectUnknownKeys(entry['timeout'], ['total', 'command'], `${path}.timeout`));
        test.timeout = readTimeout(entry['timeout'], `${path}.timeout`, issues, test.timeout);
      }
    }
    if (entry['snapshot'] !== undefined) {
if (!isPlainObject(entry['snapshot'])) {
        issues.push({ path: `${path}.snapshot`, message: 'expected a mapping with `variant`, `update` and `compare`.' });
      } else {
        issues.push(...rejectUnknownKeys(entry['snapshot'], ['compare', 'variant', 'update'], `${path}.snapshot`));
        if (entry['snapshot']['variant'] !== undefined) {
          issues.push(...requireString(entry['snapshot']['variant'], `${path}.snapshot.variant`));
          if (typeof entry['snapshot']['variant'] === 'string') {
            test.snapshot.variant = entry['snapshot']['variant'];
          }
        }
        if (entry['snapshot']['update'] !== undefined) {
          issues.push(...requireEnum(entry['snapshot']['update'], ['auto', 'never'] as const, `${path}.snapshot.update`));
          if (entry['snapshot']['update'] === 'auto' || entry['snapshot']['update'] === 'never') {
            test.snapshot.update = entry['snapshot']['update'];
          }
        }
        if (entry['snapshot']['compare'] !== undefined) {
          issues.push(
            ...requireEnum(
              entry['snapshot']['compare'],
              ['strict', 'loose', 'off'] as const,
              `${path}.snapshot.compare`,
            ),
          );
          const compare = entry['snapshot']['compare'];
          if (compare === 'strict' || compare === 'loose' || compare === 'off') {
            test.snapshot.compare = compare;
          }
        }
      }
    }
    if (entry['fixture'] !== undefined) {
      if (typeof entry['fixture'] !== 'string' || entry['fixture'].trim() === '') {
        issues.push({ path: `${path}.fixture`, message: 'must be a non-empty relative path to a directory.' });
      } else {
        const candidate = entry['fixture'] as string;
        try {
          const absolute = resolveWithin(context.rootDir, candidate);
          test.fixture = absolute;
          if (!existsSync(absolute)) {
            issues.push({
              path: `${path}.fixture`,
              message: `points to ${candidate}, which does not exist.`,
              hint: 'Create the directory or fix the path. Relative paths resolve from the config file location.',
            });
          } else if (!statSync(absolute).isDirectory()) {
            issues.push({ path: `${path}.fixture`, message: `points to ${candidate}, which is not a directory.` });
          } else if (isInside(absolute, context.rootDir) && absolute === context.rootDir) {
            issues.push({
              path: `${path}.fixture`,
              message: 'points at the project root itself, which would overwrite the workspace with itself.',
            });
          }
        } catch (error) {
          issues.push({
            path: `${path}.fixture`,
            message: error instanceof Error ? error.message : String(error),
          });
        }
      }
    }

    tests.push(test);
  });

  return tests;
}

function assignString(
  raw: Record<string, unknown>,
  key: string,
  path: string,
  issues: Issue[],
  target: AgentConfig,
): void {
  if (raw[key] === undefined) return;
  issues.push(...requireString(raw[key], path));
  if (typeof raw[key] === 'string') target[key as keyof AgentConfig] = raw[key] as never;
}

export { formatIssues };
