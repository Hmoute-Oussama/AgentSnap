import { parse as parseYaml, YAMLParseError } from 'yaml';
import { ConfigError } from '../core/errors.js';
import { isPlainObject, type Issue } from '../utils/validate.js';
import { CONFIG_VERSION, MAX_SUPPORTED_CONFIG_VERSION } from './types.js';
import { validateConfig } from './validate-config.js';
import type { AgentSnapConfig } from './types.js';

/** Converts a YAML parse failure into an actionable configuration error. */
export function parseYamlDocument(source: string, configPath: string): unknown {
  try {
    return parseYaml(source, { prettyErrors: true, uniqueKeys: true });
  } catch (error) {
    if (error instanceof YAMLParseError) {
      const line = error.linePos?.[0]?.line;
      throw new ConfigError(`${configPath} is not valid YAML.`, {
        causes: [
          error.message.split('\n')[0] ?? 'The file could not be parsed.',
          line !== undefined ? `First problem reported at line ${line + 1}.` : '',
        ].filter((entry) => entry !== ''),
        fixes: [
          'Check indentation: YAML requires consistent spaces and no tabs.',
          'Check for unquoted colons in values, for example `prompt: Add a: migration`.',
        ],
        hint: 'agentsnap validate',
      });
    }
    throw error;
  }
}

/**
 * Normalizes a parsed YAML document into a validated config.
 *
 * Malformed configuration never silently executes: unknown keys, unknown assertions and
 * type errors all produce a `ConfigError` listing every problem at once.
 */
export function normalizeConfig(
  document: unknown,
  options: { configPath: string; rootDir: string },
): AgentSnapConfig {
  if (document === null || document === undefined) {
    throw new ConfigError(`${options.configPath} is empty.`, {
      causes: ['The file contains no YAML document.'],
      fixes: ['Add at least `version: 1`, `agent.provider` and one entry under `tests:`.'],
      hint: 'agentsnap init',
    });
  }
  if (!isPlainObject(document)) {
    throw new ConfigError(
      `${options.configPath} must contain a YAML mapping at the top level, but contains ${
        Array.isArray(document) ? 'a list' : typeof document
      }.`,
      {
        fixes: [`Move your configuration under top-level keys such as \`version\`, \`agent\`, and \`tests\`.`],
        hint: 'agentsnap init',
      },
    );
  }

  const issues: Issue[] = [];
  const version = document['version'];

  if (version === undefined) {
    issues.push({
      path: 'version',
      message: 'is required.',
      hint: `Add \`version: ${CONFIG_VERSION}\` at the top of the file.`,
    });
  } else if (version !== CONFIG_VERSION) {
    if (typeof version === 'number' && version > MAX_SUPPORTED_CONFIG_VERSION) {
      issues.push({
        path: 'version',
        message: `is ${version}, but this build of AgentSnap only supports version ${CONFIG_VERSION}.`,
        hint: 'Upgrade AgentSnap (`npm install -g agentsnap@latest`) or set `version: 1`.',
      });
    } else {
      issues.push({
        path: 'version',
        message: `must be ${CONFIG_VERSION} (received ${JSON.stringify(version)}).`,
      });
    }
  }

  const validation = validateConfig(document, { configPath: options.configPath, rootDir: options.rootDir });
  issues.push(...validation.issues);

  if (issues.length > 0) {
    throw new ConfigError(`${options.configPath} has ${issues.length} configuration problem(s).`, {
      causes: renderIssues(issues),
      fixes: ['Fix the problems above, then run `agentsnap validate` to re-check.'],
      hint: 'agentsnap validate',
    });
  }

  return validation.config as AgentSnapConfig;
}

export function renderIssues(issues: Issue[]): string[] {
  return issues.map((item) => {
    const head = `${item.path}: ${item.message}`;
    return item.hint ? `${head} ${item.hint}` : head;
  });
}
