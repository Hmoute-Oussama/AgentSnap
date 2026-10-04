import { probeAdapters, versionAtLeast } from '../../adapters/registry.js';
import { resolveConfigPath } from '../../config/index.js';
import { inspectRepository } from '../../config/discovery.js';
import { ExitCode } from '../../core/exit-codes.js';
import type { DiagnosticEntry } from '../../core/types.js';
import { GLYPH, type Colorizer } from '../../utils/color.js';
import { secretEnvNames } from '../../utils/redact.js';
import { probeDocker } from '../../sandbox/docker.js';
import type { Logger } from '../../utils/logger.js';
import type { CliContext } from '../context.js';
import { readFlags } from '../args.js';

const DOCTOR_FLAGS = ['color', 'config', 'debug', 'help', 'json', 'no-color', 'quiet', 'verbose', 'version'] as const;

/**
 * `agentsnap doctor`
 *
 * Answers the only question that matters when an agent test misbehaves: is the environment
 * capable of running it at all? Every claim here is measured, never assumed, and the sandbox
 * section states what isolation is actually in effect.
 */
export async function commandDoctor(context: CliContext): Promise<number> {
  const flags = readFlags(context.args, DOCTOR_FLAGS);
  const entries: DiagnosticEntry[] = [];
  entries.push(nodeDiagnostic());
  entries.push(await configDiagnostic(context, flags.string('config')));

  const configPath = await resolveConfigPath(context.cwd, flags.string('config')).catch(() => null);
  const provider = await detectConfiguredProvider(configPath);
  entries.push(...(await adapterDiagnostics(context, provider)));
  entries.push(await dockerDiagnostic());
  entries.push(credentialsDiagnostic());
  entries.push(...(await repositoryDiagnostics(context)));

  const asJson = flags.bool('json');
  if (asJson) {
    context.stdout.write(
      `${JSON.stringify({ diagnostics: entries, tool: 'agentsnap', version: context.toolVersion }, null, 2)}\n`,
    );
  } else {
    printTable(entries, context.color, context.logger);
  }

  const hasFailure = entries.some((entry) => entry.status === 'fail');
  return hasFailure ? ExitCode.RuntimeError : ExitCode.Success;
}

function nodeDiagnostic(): DiagnosticEntry {
  const [major = 0, minor = 0] = process.versions.node.split('.').map((part) => Number.parseInt(part, 10) || 0);
  const supported = major > 20 || (major === 20 && minor >= 11);
  return {
    detail: `Node ${process.versions.node} on ${process.platform}`,
    hint: supported ? undefined : 'Install Node 20.11 or newer.',
    name: 'node',
    status: supported ? 'ok' : 'fail',
  };
}

async function configDiagnostic(context: CliContext, explicit: string | undefined): Promise<DiagnosticEntry> {
  try {
    const path = await resolveConfigPath(context.cwd, explicit);
    if (path === null) {
      return {
        detail: 'no agentsnap.yaml found in this directory or any parent',
        hint: 'agentsnap init',
        name: 'config',
        status: 'fail',
      };
    }
    return { detail: path, name: 'config', status: 'ok' };
  } catch (error) {
    return {
      detail: error instanceof Error ? error.message : String(error),
      name: 'config',
      status: 'fail',
    };
  }
}

/** Reads `agent.provider` without full validation, so doctor can report config errors too. */
async function detectConfiguredProvider(configPath: string | null): Promise<string> {
  if (configPath === null) return 'claude-code';
  try {
    const { readRawConfig } = await import('../../config/index.js');
    const { loadConfig } = await import('../../config/index.js');
    void readRawConfig;
    const config = await loadConfig({ configPath, cwd: configPath });
    return config.agent.provider;
  } catch {
    return 'claude-code';
  }
}

async function adapterDiagnostics(context: CliContext, provider: string): Promise<DiagnosticEntry[]> {
  const entries: DiagnosticEntry[] = [];
  const probes = await probeAdapters({ config: { provider }, cwd: context.cwd, env: process.env });

  for (const { adapter, detection } of probes) {
    const selected = adapter.name === provider;
    const detail = detection.available
      ? `${detection.version ?? 'version unknown'}${detection.executablePath ? ` (${detection.executablePath})` : ''}`
      : detection.problems[0] ?? 'not available';

    entries.push({
      detail: `${selected ? 'selected — ' : ''}${detail}`,
      hint: detection.available ? undefined : `Install ${adapter.displayName} (docs: ${adapter.docsUrl}).`,
      name: `adapter:${adapter.name}`,
      status: detection.available ? (selected ? 'ok' : 'info') : selected ? 'fail' : 'warn',
    });

    if (selected && detection.available) {
      const minimum = adapter.minimumVersion?.(detection.version);
      if (minimum !== null && minimum !== undefined && !versionAtLeast(detection.version, minimum)) {
        entries.push({
          detail: `${detection.version ?? 'unknown'} is older than the required ${minimum}`,
          hint: `Upgrade ${adapter.displayName}; older builds reject flags this adapter sends.`,
          name: 'adapter:version',
          status: 'warn',
        });
      }
      if (adapter.diagnostics) {
        entries.push(...(await adapter.diagnostics({ config: { provider }, cwd: context.cwd, env: process.env })));
      }
    }
  }

  return entries;
}

async function dockerDiagnostic(): Promise<DiagnosticEntry> {
  try {
    const probe = await probeDocker();
    if (!probe.available) {
      return {
        detail: `Docker not detected (${probe.detail})`,
        hint: 'Docker is optional. Without it, `sandbox.type: docker` and network blocking are unavailable.',
        name: 'docker',
        status: 'warn',
      };
    }
    return { detail: `Docker ${probe.version ?? 'available'}`, name: 'docker', status: 'ok' };
  } catch (error) {
    return {
      detail: error instanceof Error ? error.message : String(error),
      name: 'docker',
      status: 'warn',
    };
  }
}

function credentialsDiagnostic(): DiagnosticEntry {
  const names = secretEnvNames(process.env);
  const present = names.filter((name) => (process.env[name] ?? '') !== '');
  if (present.length === 0) {
    return {
      detail: 'no agent credential environment variables are set',
      hint: 'Set ANTHROPIC_API_KEY (or run `claude login`) before running tests against a real runtime.',
      name: 'credentials',
      status: 'warn',
    };
  }
  // Only the names are reported; values are never printed and are masked in all records.
  return { detail: `${present.length} credential variable(s) set: ${present.join(', ')}`, name: 'credentials', status: 'ok' };
}

async function repositoryDiagnostics(context: CliContext): Promise<DiagnosticEntry[]> {
  const profile = await inspectRepository(context.cwd);
  const entries: DiagnosticEntry[] = [];

  entries.push({
    detail: `${profile.root}${profile.isGitRepo ? '' : ' (not a git repository)'}`,
    name: 'project',
    status: 'info',
  });

  if (profile.testCommand) {
    entries.push({ detail: profile.testCommand, name: 'detected-test-command', status: 'info' });
  } else {
    entries.push({
      detail: 'no project test command was detected',
      hint: 'Set `command` explicitly on any `tests_must_pass` assertion.',
      name: 'detected-test-command',
      status: 'warn',
    });
  }

  if (!profile.nodeModulesPresent && profile.packageManager !== null) {
    entries.push({
      detail: 'node_modules is missing',
      hint: `Run \`${profile.packageManager} install\` so ` + '`tests_must_pass` can run inside the sandbox.',
      name: 'dependencies',
      status: 'warn',
    });
  }

  if (profile.agentInstructions.length > 0) {
    entries.push({
      detail: profile.agentInstructions.map((file) => file.path).join(', '),
      name: 'agent-instructions',
      status: 'info',
    });
  }

  return entries;
}

function printTable(entries: DiagnosticEntry[], color: Colorizer, logger: Logger): void {
  logger.out(`${color.bold('AgentSnap doctor')} ${color.dim('— environment diagnostic')}`);
  logger.out('');

  const width = Math.max(...entries.map((entry) => entry.name.length), 10);
  for (const entry of entries) {
    const mark =
      entry.status === 'ok'
        ? color.green(GLYPH.pass)
        : entry.status === 'fail'
          ? color.red(GLYPH.fail)
          : entry.status === 'warn'
            ? color.yellow(GLYPH.warn)
            : color.dim(GLYPH.info);
    logger.out(`  ${mark} ${entry.name.padEnd(width)}  ${entry.detail}`);
    if (entry.hint) logger.out(`    ${color.dim(entry.hint)}`);
  }

  const failures = entries.filter((entry) => entry.status === 'fail').length;
  const warnings = entries.filter((entry) => entry.status === 'warn').length;
  logger.out('');
  logger.out(
    color.dim(
      `  ${failures} problem(s), ${warnings} warning(s)` +
        (failures === 0 ? ' — AgentSnap can run agent tests here.' : ' — fix the problems above first.'),
    ),
  );
}

