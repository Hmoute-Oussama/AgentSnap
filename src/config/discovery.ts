import { spawnSync } from 'node:child_process';
import { readdir } from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';
import { CONFIG_FILENAMES } from './index.js';
import { isFile, pathExists, readJson, readText } from '../utils/fsx.js';

/** Instruction files an AI coding agent may load automatically. */
export const AGENT_INSTRUCTION_FILES = [
  'AGENTS.md',
  'CLAUDE.md',
  'GEMINI.md',
  '.cursorrules',
  '.github/copilot-instructions.md',
  '.windsurfrules',
  '.clinerules',
  'CONVENTIONS.md',
] as const;

export interface DiscoveredFile {
  /** Project-relative POSIX path. */
  path: string;
  bytes: number;
}

export interface RepoProfile {
  root: string;
  isGitRepo: boolean;
  git: { available: boolean; root: string | null; head: string | null; version: string | null };
  agentInstructions: DiscoveredFile[];
  skills: DiscoveredFile[];
  mcpServers: string[];
  agentConfigs: DiscoveredFile[];
  languages: string[];
  /** Best guess at the project's verification command, from package.json / Makefile. */
  testCommand: string | null;
  packageManager: string | null;
  existingConfig: string | null;
  nodeModulesPresent: boolean;
}

const GIT_TIMEOUT_MS = 5_000;

function git(root: string, args: string[]): { ok: boolean; stdout: string } {
  const result = spawnSync('git', args, {
    cwd: root,
    encoding: 'utf8',
    shell: false,
    timeout: GIT_TIMEOUT_MS,
    windowsHide: true,
  });
  return { ok: result.status === 0, stdout: (result.stdout ?? '').trim() };
}

async function safeSize(path: string): Promise<DiscoveredFile | null> {
  try {
    const { stat } = await import('node:fs/promises');
    const info = await stat(path);
    return { bytes: info.size, path: basename(path) };
  } catch {
    return null;
  }
}

async function collectSkills(root: string): Promise<DiscoveredFile[]> {
  const skills: DiscoveredFile[] = [];
  for (const dir of ['.claude/skills', '.agent/skills', 'skills']) {
    const full = join(root, dir);
    if (!(await pathExists(full))) continue;
    try {
      const entries = await readdir(full, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.isDirectory()) {
          const file = await safeSize(join(full, entry.name));
          if (file) skills.push({ bytes: file.bytes, path: `${dir}/${entry.name}` });
        }
      }
    } catch {
      // Unreadable directory: ignore rather than failing the whole diagnostic.
    }
  }
  return skills.sort((a, b) => (a.path < b.path ? -1 : 1));
}

/** Reads MCP server names from the common configuration locations. */
async function detectMcpServers(root: string): Promise<string[]> {
  const names = new Set<string>();
  const candidates: Array<{ path: string; jsonPath: string[] }> = [
    { jsonPath: ['mcpServers'], path: '.mcp.json' },
    { jsonPath: ['mcpServers'], path: '.cursor/mcp.json' },
    { jsonPath: ['mcpServers'], path: '.vscode/mcp.json' },
    { jsonPath: ['mcpServers'], path: '.claude/settings.json' },
    { jsonPath: ['projects', Object.keys({})[0] ?? '', 'mcpServers'], path: '.claude.json' },
  ];
  for (const candidate of candidates) {
    const full = join(root, candidate.path);
    if (!(await pathExists(full))) continue;
    try {
      const data = await readJson<Record<string, unknown>>(full);
      const servers = data[candidate.jsonPath[0] ?? ''];
      if (servers && typeof servers === 'object') {
        for (const name of Object.keys(servers as Record<string, unknown>)) names.add(name);
      }
    } catch {
      // Ignore malformed MCP config: `agentsnap doctor` reports it separately if relevant.
    }
  }
  return [...names].sort();
}

async function detectTestCommand(root: string): Promise<{ command: string | null; packageManager: string | null }> {
  if (await pathExists(join(root, 'pnpm-lock.yaml'))) return { command: 'pnpm test', packageManager: 'pnpm' };
  if (await pathExists(join(root, 'yarn.lock'))) return { command: 'yarn test', packageManager: 'yarn' };
  if (await pathExists(join(root, 'bun.lockb')) || (await pathExists(join(root, 'bun.lock')))) {
    return { command: 'bun test', packageManager: 'bun' };
  }
  if (await isFile(join(root, 'package.json'))) {
    try {
      const pkg = await readJson<{ scripts?: Record<string, string> }>(join(root, 'package.json'));
      const script = pkg.scripts?.['test'];
      return { command: script ? 'npm test' : null, packageManager: 'npm' };
    } catch {
      return { command: null, packageManager: 'npm' };
    }
  }
  if (await pathExists(join(root, 'Makefile'))) return { command: 'make test', packageManager: 'make' };
  return { command: null, packageManager: null };
}

async function detectLanguages(root: string): Promise<string[]> {
  const languages: string[] = [];
  const checks: Array<[string, string]> = [
    ['package.json', 'JavaScript/TypeScript'],
    ['tsconfig.json', 'TypeScript'],
    ['pyproject.toml', 'Python'],
    ['requirements.txt', 'Python'],
    ['go.mod', 'Go'],
    ['Cargo.toml', 'Rust'],
    ['pom.xml', 'Java'],
    ['build.gradle', 'Java'],
    ['Gemfile', 'Ruby'],
    ['composer.json', 'PHP'],
  ];
  for (const [file, language] of checks) {
    if (await pathExists(join(root, file))) languages.push(language);
  }
  return languages;
}

/**
 * Inspects a repository and reports what an agent configuration looks like.
 *
 * Powers `agentsnap init` (to generate a realistic starting config) and
 * `agentsnap doctor` (to explain what was detected). Purely read-only.
 */
export async function inspectRepository(root: string): Promise<RepoProfile> {
  const absoluteRoot = resolve(root);

  const gitRoot = git(absoluteRoot, ['rev-parse', '--show-toplevel']);
  const head = gitRoot.ok ? git(absoluteRoot, ['rev-parse', 'HEAD']) : { ok: false, stdout: '' };
  const gitVersion = git(absoluteRoot, ['--version']);

  const agentInstructions: DiscoveredFile[] = [];
  for (const name of AGENT_INSTRUCTION_FILES) {
    const full = join(absoluteRoot, name);
    if (await isFile(full)) {
      const info = await safeSize(full);
      if (info) agentInstructions.push({ bytes: info.bytes, path: name });
    }
  }

  const agentConfigs: DiscoveredFile[] = [];
  for (const name of ['.claude/settings.json', '.claude/settings.local.json', '.github/copilot-instructions.md', '.mcp.json']) {
    const full = join(absoluteRoot, name);
    if (await isFile(full)) {
      const info = await safeSize(full);
      if (info) agentConfigs.push({ ...info, path: name });
    }
  }

  let existingConfig: string | null = null;
  for (const name of CONFIG_FILENAMES) {
    if (await isFile(join(absoluteRoot, name))) {
      existingConfig = name;
      break;
    }
  }

  const { command, packageManager } = await detectTestCommand(absoluteRoot);

  return {
    agentConfigs,
    agentInstructions,
    existingConfig,
    git: {
      available: gitVersion.ok,
      head: head.ok && head.stdout !== '' ? head.stdout : null,
      root: gitRoot.ok && gitRoot.stdout !== '' ? resolve(gitRoot.stdout) : null,
      version: gitVersion.ok ? gitVersion.stdout : null,
    },
    isGitRepo: gitRoot.ok,
    languages: await detectLanguages(absoluteRoot),
    mcpServers: await detectMcpServers(absoluteRoot),
    nodeModulesPresent: await pathExists(join(absoluteRoot, 'node_modules')),
    packageManager,
    root: absoluteRoot,
    skills: await collectSkills(absoluteRoot),
    testCommand: command,
  };
}

/** Best-effort first heading of an instruction file, used by `agentsnap init` output. */
export async function readAgentInstructionSummary(root: string): Promise<string | null> {
  for (const name of AGENT_INSTRUCTION_FILES) {
    const full = join(root, name);
    if (!(await isFile(full))) continue;
    try {
      const contents = await readText(full);
      const heading = contents
        .split('\n')
        .map((line) => line.trim())
        .find((line) => line.startsWith('#'));
      return heading ? heading.replace(/^#+\s*/, '') : name;
    } catch {
      return name;
    }
  }
  return null;
}
