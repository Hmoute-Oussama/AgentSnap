import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { join } from 'node:path';
import { makeTempDir, writeFileTree } from '../helpers/fixtures.js';

/**
 * End-to-end coverage runs the real CLI in a child process against the real `dist` build,
 * because the things most likely to break in a release are the wiring between argument
 * parsing, exit codes and files on disk, none of which a unit test can observe.
 */

const CLI = join(process.cwd(), 'dist', 'cli', 'bin.js');

interface CliResult {
  exitCode: number;
  stderr: string;
  stdout: string;
}

async function cli(args: string[], cwd: string): Promise<CliResult> {
  const { spawn } = await import('node:child_process');
  return new Promise<CliResult>((resolvePromise, rejectPromise) => {
    const child = spawn(process.execPath, [CLI, ...args], {
      cwd,
      env: { ...process.env, NO_COLOR: '1' },
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk: string) => {
      stderr += chunk;
    });
    child.once('error', rejectPromise);
    child.once('close', (code) => {
      resolvePromise({ exitCode: code ?? -1, stderr, stdout });
    });
  });
}

/** A project with a passing fake test plus an optional failing one. */
async function makeCliProject(options: { failing?: boolean } = {}) {
  const project = await makeTempDir('agentsnap-e2e-');
  await writeFileTree(project.path, {
    'a.txt': 'hello',
    'agentsnap.yaml': [
      'version: 1',
      'agent:',
      '  provider: fake',
      'tests:',
      '  - name: reads the readme',
      '    prompt: "read: a.txt"',
      '    assertions:',
      '      - file_read: a.txt',
      ...(options.failing === true
        ? [
            '  - name: demands the impossible',
            '    prompt: "read: a.txt"',
            '    assertions:',
            '      - file_read: never-read.txt',
          ]
        : []),
      '',
    ].join('\n'),
  });
  return project;
}

describe('agentsnap CLI', () => {
  it('prints version and help without touching a project', async () => {
    const project = await makeCliProject();
    try {
      const version = await cli(['--version'], project.path);
      assert.equal(version.exitCode, 0);
      assert.match(version.stdout.trim(), /^\d+\.\d+\.\d+/);

      const help = await cli(['--help'], project.path);
      assert.equal(help.exitCode, 0);
      assert.match(help.stdout, /run/);
      assert.match(help.stdout, /validate/);
    } finally {
      await project.dispose();
    }
  });

  it('documents each command separately', async () => {
    const project = await makeCliProject();
    try {
      const runHelp = await cli(['run', '--help'], project.path);
      assert.equal(runHelp.exitCode, 0);
      assert.match(runHelp.stdout, /agentsnap run \[options\]/);
      assert.match(runHelp.stdout, /--snapshot-mode/);
      assert.match(runHelp.stdout, /--update-snapshots/);

      const listHelp = await cli(['list', '--help'], project.path);
      assert.equal(listHelp.exitCode, 0);
      assert.match(listHelp.stdout, /agentsnap list \[options\]/);
      assert.doesNotMatch(listHelp.stdout, /--update-snapshots/);
    } finally {
      await project.dispose();
    }
  });

  it('rejects an unknown command instead of guessing', async () => {
    const project = await makeCliProject();
    try {
      const result = await cli(['frobnicate'], project.path);
      assert.equal(result.exitCode, 2);
      assert.match(result.stderr, /unknown command/i);
    } finally {
      await project.dispose();
    }
  });

  it('exits 2 with an actionable message on an invalid config', async () => {
    const project = await makeCliProject();
    try {
      await writeFileTree(project.path, { 'agentsnap.yaml': 'version: 1\ntests: []\n' });
      const result = await cli(['run'], project.path);
      assert.equal(result.exitCode, 2);
      assert.match(result.stderr, /configuration/i);
      assert.match(result.stderr, /validate/);
    } finally {
      await project.dispose();
    }
  });

  it('runs a passing test and exits 0', async () => {
    const project = await makeCliProject();
    try {
      const result = await cli(['run'], project.path);
      assert.equal(result.exitCode, 0);
      assert.match(result.stdout, /reads the readme/);
      assert.match(result.stdout, /PASS/);
    } finally {
      await project.dispose();
    }
  });

  it('exits 1 and explains a failing assertion', async () => {
    const project = await makeCliProject({ failing: true });
    try {
      const result = await cli(['run'], project.path);
      assert.equal(result.exitCode, 1);
      assert.match(result.stdout, /never-read\.txt/);
      assert.match(result.stdout, /FAIL/);
    } finally {
      await project.dispose();
    }
  });

  it('filters by name and tag', async () => {
    const project = await makeCliProject({ failing: true });
    try {
      const selected = await cli(['run', '--name', 'reads the readme'], project.path);
      assert.equal(selected.exitCode, 0);
      assert.match(selected.stdout, /1 passed/);

      const excluded = await cli(['run', '--name', 'reads the readme', '--exclude', '*impossible*'], project.path);
      assert.equal(excluded.exitCode, 0);
    } finally {
      await project.dispose();
    }
  });

  it('emits machine-readable JSON for --reporter json', async () => {
    const project = await makeCliProject();
    try {
      const result = await cli(['run', '--reporter', 'json'], project.path);
      assert.equal(result.exitCode, 0);
      const payload = JSON.parse(result.stdout) as { totals: { passed: number }; tests: unknown[] };
      assert.equal(payload.totals.passed, 1);
      assert.equal(Array.isArray(payload.tests), true);
    } finally {
      await project.dispose();
    }
  });

  it('writes a last-run summary and per-run records', async () => {
    const project = await makeCliProject();
    try {
      await cli(['run'], project.path);
      const summary = JSON.parse(
        await (await import('node:fs/promises')).readFile(join(project.path, '.agentsnap', 'last-run.json'), 'utf8'),
      ) as { totals: { total: number } };
      assert.equal(summary.totals.total, 1);
    } finally {
      await project.dispose();
    }
  });

  it('records, compares and blesses a behavioral baseline', async () => {
    const project = await makeCliProject();
    try {
      const first = await cli(['run', '--name', 'reads the readme'], project.path);
      assert.equal(first.exitCode, 0);
      assert.match(first.stdout + first.stderr, /baseline/i);

      const unchanged = await cli(['run', '--name', 'reads the readme'], project.path);
      assert.equal(unchanged.exitCode, 0);

      // Drift: the agent now also writes a file, which a loose comparison treats as a regression.
      await writeFileTree(project.path, {
        'agentsnap.yaml': [
          'version: 1',
          'agent:',
          '  provider: fake',
          'tests:',
          '  - name: reads the readme',
          '    prompt: "read: a.txt\\nwrite: extra.txt = x"',
          '    assertions:',
          '      - file_read: a.txt',
          '    snapshot:',
          '      update: never',
          '',
        ].join('\n'),
      });

      const drifted = await cli(['run', '--name', 'reads the readme'], project.path);
      assert.equal(drifted.exitCode, 1);
      assert.match(drifted.stdout, /new file: extra\.txt/);

      const blessed = await cli(['run', '--name', 'reads the readme', '--update-snapshots'], project.path);
      assert.equal(blessed.exitCode, 0);
      assert.match(blessed.stdout + blessed.stderr, /new behavioral baseline/i);

      const settled = await cli(['run', '--name', 'reads the readme'], project.path);
      assert.equal(settled.exitCode, 0);
    } finally {
      await project.dispose();
    }
  });

  it('accepts --snapshot-mode as a spaced value flag', async () => {
    const project = await makeCliProject();
    try {
      const result = await cli(['run', '--snapshot-mode', 'strict'], project.path);
      assert.equal(result.exitCode, 0);

      const invalid = await cli(['run', '--snapshot-mode', 'sideways'], project.path);
      assert.equal(invalid.exitCode, 2);
      assert.match(invalid.stderr, /strict, loose or off/);
    } finally {
      await project.dispose();
    }
  });

  it('lists and validates a config', async () => {
    const project = await makeCliProject();
    try {
      const list = await cli(['list'], project.path);
      assert.equal(list.exitCode, 0);
      assert.match(list.stdout, /reads the readme/);

      const validate = await cli(['validate'], project.path);
      assert.equal(validate.exitCode, 0);
    } finally {
      await project.dispose();
    }
  });

  it('writes a usable config with init', async () => {
    const project = await makeCliProject();
    try {
      await cli(['init', '--force'], project.path);
      const created = await (await import('node:fs/promises')).readFile(
        join(project.path, 'agentsnap.yaml'),
        'utf8',
      );
      assert.match(created, /version: 1/);
      assert.match(created, /provider: claude-code/);
      assert.equal((await cli(['validate'], project.path)).exitCode, 0);
    } finally {
      await project.dispose();
    }
  });

  it('reports adapter health with doctor', async () => {
    const project = await makeCliProject();
    try {
      const result = await cli(['doctor'], project.path);
      // The fake adapter is always available, so doctor must not report a hard failure.
      assert.notEqual(result.exitCode, 1);
      assert.match(result.stdout + result.stderr, /fake/i);
    } finally {
      await project.dispose();
    }
  });
});