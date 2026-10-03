import { readFile } from 'node:fs/promises';
import { isAbsolute, join, resolve } from 'node:path';
import { ConfigError } from '../core/errors.js';
import { pathExists, readText } from '../utils/fsx.js';
import { normalizeConfig, parseYamlDocument } from './loader.js';
import type { AgentSnapConfig } from './types.js';

/** Config file names, in priority order. */
export const CONFIG_FILENAMES = [
  'agentsnap.yaml',
  'agentsnap.yml',
  '.agentsnap.yaml',
  '.agentsnap.yml',
  join('agentsnap', 'agentsnap.yaml'),
] as const;

export const DEFAULT_CONFIG_FILENAME = 'agentsnap.yaml';

/**
 * Locates the config file for a directory.
 *
 * Walks up from `cwd` so `agentsnap test` works from any subdirectory of the project,
 * mirroring how every other modern CLI behaves.
 */
export async function resolveConfigPath(cwd: string, explicit?: string): Promise<string | null> {
  if (explicit !== undefined) {
    const target = isAbsolute(explicit) ? explicit : resolve(cwd, explicit);
    if (!(await pathExists(target))) {
      throw new ConfigError(`No configuration file at ${target}.`, {
        causes: ['The path passed with `--config` does not exist.'],
        fixes: [
          'Pass a path relative to the current directory, or an absolute path.',
          `Run \`agentsnap init\` in ${cwd} to create ${DEFAULT_CONFIG_FILENAME}.`,
        ],
      });
    }
    return target;
  }

  let dir = resolve(cwd);
  for (;;) {
    for (const name of CONFIG_FILENAMES) {
      const candidate = join(dir, name);
      if (await pathExists(candidate)) return candidate;
    }
    const parent = resolve(dir, '..');
    if (parent === dir) return null;
    dir = parent;
  }
}

export interface LoadConfigOptions {
  cwd: string;
  configPath?: string;
}

/** Loads and fully validates configuration. Throws `ConfigError` on any problem. */
export async function loadConfig(options: LoadConfigOptions): Promise<AgentSnapConfig> {
  const configPath = await resolveConfigPath(options.cwd, options.configPath);
  if (configPath === null) {
    throw new ConfigError(`No AgentSnap configuration found for ${resolve(options.cwd)}.`, {
      causes: [
        `AgentSnap looked for ${CONFIG_FILENAMES.join(', ')} in ${resolve(options.cwd)} and every parent directory.`,
      ],
      fixes: [
        `Run \`agentsnap init\` in your project root to create ${DEFAULT_CONFIG_FILENAME}.`,
        'Or point at an existing file with `agentsnap test --config path/to/agentsnap.yaml`.',
      ],
    });
  }

  const rootDir = resolve(configPath, '..');
  let source: string;
  try {
    source = await readText(configPath);
  } catch (error) {
    throw new ConfigError(`Could not read ${configPath}.`, {
      cause: error,
      causes: [
        error instanceof Error && 'code' in error && error.code === 'EACCES'
          ? 'The file exists but is not readable by the current user.'
          : 'The file may have been deleted or moved.',
      ],
      fixes: [`Check the file permissions with \`ls -l\` or \`dir\`.`],
    });
  }

  const document = parseYamlDocument(source, configPath);
  return normalizeConfig(document, { configPath, rootDir });
}

/** Reads raw YAML without validation; used by `agentsnap doctor` and `agentsnap validate`. */
export async function readRawConfig(configPath: string): Promise<unknown> {
  return parseYamlDocument(await readFile(configPath, 'utf8'), configPath);
}

export { normalizeConfig, parseYamlDocument };
export * from './types.js';
