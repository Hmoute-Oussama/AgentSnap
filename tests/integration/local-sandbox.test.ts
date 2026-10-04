import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { LocalSandbox } from '../../src/sandbox/local.js';
import { buildChildEnv, BASE_ENV_ALLOWLIST } from '../../src/sandbox/env.js';
import { makeTempDir, writeFileTree } from '../helpers/fixtures.js';

async function makeSandbox(
  files: Record<string, string>,
  overrides: Partial<ConstructorParameters<typeof LocalSandbox>[0]> = {},
) {
  const project = await makeTempDir('agentsnap-project-');
  await writeFileTree(project.path, files);
  const sandbox = new LocalSandbox({
    env: buildChildEnv({ base: BASE_ENV_ALLOWLIST, deny: [], inherit: [], overrides: {} }),
    exclude: [{ pattern: 'node_modules/**' }],
    fixtures: [],
    keepWorkspace: false,
    mode: 'workspace',
    projectRoot: project.path,
    runId: `test-${Math.random().toString(36).slice(2, 8)}`,
    ...overrides,
  });
  await sandbox.prepare();
  return {
    dispose: async () => {
      await sandbox.dispose();
      await project.dispose();
    },
    project,
    sandbox,
  };
}

describe('LocalSandbox workspace isolation', () => {
  it('gives the agent a copy, not the working tree', async () => {
    const { dispose, project, sandbox } = await makeSandbox({ 'src/a.ts': 'original' });
    try {
      assert.notEqual(sandbox.root, project.path);

      await sandbox.api().writeTextFile('src/a.ts', 'edited by the agent');
      assert.equal(await readFile(join(project.path, 'src/a.ts'), 'utf8'), 'original');
      assert.equal(await sandbox.api().readTextFile('src/a.ts'), 'edited by the agent');
    } finally {
      await dispose();
    }
  });

  it('honours exclusions when copying', async () => {
    const { dispose, sandbox } = await makeSandbox({
      'node_modules/pkg/index.js': 'module.exports = 1;',
      'src/a.ts': 'x',
    });
    try {
      assert.equal(await sandbox.api().exists('node_modules/pkg/index.js'), false);
      assert.equal(await sandbox.api().exists('src/a.ts'), true);
    } finally {
      await dispose();
    }
  });

  it('publishes honest capabilities', async () => {
    const { dispose, sandbox } = await makeSandbox({ 'a.txt': 'x' });
    try {
      assert.equal(sandbox.capabilities.kind, 'local');
      assert.equal(sandbox.capabilities.filesystemIsolation, 'copy');
      assert.equal(sandbox.capabilities.networkBlocked, false);
      assert.equal(sandbox.capabilities.resourceLimits, false);
      assert.equal(sandbox.capabilities.processIsolation, 'none');
    } finally {
      await dispose();
    }
  });

  it('removes the throwaway workspace on dispose', async () => {
    const { project, sandbox } = await makeSandbox({ 'a.txt': 'x' });
    const root = sandbox.root;
    await sandbox.dispose();
    await assert.rejects(() => readFile(join(root, 'a.txt')));
    await project.dispose();
  });

  it('keeps the workspace when asked, for debugging', async () => {
    const { dispose, sandbox } = await makeSandbox({ 'a.txt': 'x' }, { keepWorkspace: true });
    const root = sandbox.root;
    try {
      await sandbox.dispose();
      assert.equal(await readFile(join(root, 'a.txt'), 'utf8'), 'x');
    } finally {
      await rm(root, { recursive: true, force: true });
      await dispose();
    }
  });

  it('works in the repository directly when mode is repo', async () => {
    const { dispose, project, sandbox } = await makeSandbox({ 'a.txt': 'x' }, { mode: 'repo' });
    try {
      assert.equal(sandbox.root, project.path);
      await sandbox.api().writeTextFile('a.txt', 'changed');
      assert.equal(await readFile(join(project.path, 'a.txt'), 'utf8'), 'changed');
    } finally {
      await dispose();
    }
  });
});

describe('LocalSandbox path guards', () => {
  it('refuses to resolve a path outside the workspace', async () => {
    const { dispose, sandbox } = await makeSandbox({ 'a.txt': 'x' });
    try {
      const api = sandbox.api();
      assert.throws(() => api.resolve('../escape.txt'));
      assert.throws(() => api.resolve('../../etc/passwd'));
      assert.throws(() => api.resolve('a/../../escape.txt'));
    } finally {
      await dispose();
    }
  });

  it('refuses a write that escapes the workspace', async () => {
    const { dispose, sandbox } = await makeSandbox({ 'a.txt': 'x' });
    try {
      await assert.rejects(() => sandbox.api().writeTextFile('../escape.txt', 'nope'));
    } finally {
      await dispose();
    }
  });

  it('relativizes an absolute path inside the workspace', async () => {
    const { dispose, sandbox } = await makeSandbox({ 'a.txt': 'x' });
    try {
      assert.equal(sandbox.api().relative(join(sandbox.root, 'a', 'b.txt')), 'a/b.txt');
    } finally {
      await dispose();
    }
  });

  it('rejects an absolute path that is outside the workspace', async () => {
    const { dispose, sandbox } = await makeSandbox({ 'a.txt': 'x' });
    try {
      assert.throws(() => sandbox.api().relative(join(sandbox.root, '..', '..', 'etc', 'passwd')));
    } finally {
      await dispose();
    }
  });
});

describe('LocalSandbox command execution', () => {
  it('runs a command without a shell and captures output', async () => {
    const { dispose, sandbox } = await makeSandbox({ 'script.js': 'console.log(41 + 1);' });
    try {
      const outcome = await sandbox.api().exec('node script.js', { timeoutSeconds: 30 });
      assert.equal(outcome.exitCode, 0);
      assert.equal(outcome.stdout.trim(), '42');
      assert.equal(outcome.timedOut, false);
    } finally {
      await dispose();
    }
  });

  it('reports a non-zero exit instead of throwing', async () => {
    const { dispose, sandbox } = await makeSandbox({ 'script.js': 'process.exit(3);' });
    try {
      const outcome = await sandbox.api().exec('node script.js', { timeoutSeconds: 30 });
      assert.equal(outcome.exitCode, 3);
    } finally {
      await dispose();
    }
  });

  it('refuses a command that needs a shell instead of mis-running it', async () => {
    const { dispose, sandbox } = await makeSandbox({ 'a.txt': 'x' });
    try {
      await assert.rejects(() => sandbox.api().exec('node script.js | cat', { timeoutSeconds: 5 }), /shell/);
      await assert.rejects(() => sandbox.api().exec('node $HOME/evil.js', { timeoutSeconds: 5 }), /shell/);
      await assert.rejects(() => sandbox.api().exec('node script.js > out.txt', { timeoutSeconds: 5 }), /shell/);
      await assert.rejects(() => sandbox.api().exec('echo hi && echo bye', { timeoutSeconds: 5 }), /shell/);
    } finally {
      await dispose();
    }
  });

  it('enforces a timeout', async () => {
    const { dispose, sandbox } = await makeSandbox({
      'script.js': 'setTimeout(() => {}, 60000);',
    });
    try {
      const outcome = await sandbox.api().exec('node script.js', { timeoutSeconds: 1 });
      assert.equal(outcome.timedOut, true);
    } finally {
      await dispose();
    }
  });

  it('passes only the allow-listed environment to the child', async () => {
    // A host variable that is never allow-listed must not reach the child.
    process.env['AGENTSNAP_HOST_ONLY'] = 'must-not-leak';
    const project = await makeTempDir('agentsnap-project-');
    await writeFileTree(project.path, { 'script.js': 'console.log(JSON.stringify(process.env));' });
    const sandbox = new LocalSandbox({
      env: buildChildEnv({ base: [], deny: [], inherit: [], overrides: { SAFE_VALUE: 'visible' } }),
      exclude: [],
      fixtures: [],
      keepWorkspace: false,
      mode: 'workspace',
      projectRoot: project.path,
      runId: `test-${Math.random().toString(36).slice(2, 8)}`,
    });
    await sandbox.prepare();
    try {
      const outcome = await sandbox.api().exec('node script.js', { timeoutSeconds: 30 });
      const childEnv = JSON.parse(outcome.stdout) as Record<string, string>;
      assert.equal(childEnv['SAFE_VALUE'], 'visible');
      assert.equal(childEnv['AGENTSNAP_HOST_ONLY'], undefined);
    } finally {
      await sandbox.dispose();
      await project.dispose();
      delete process.env['AGENTSNAP_HOST_ONLY'];
    }
  });

  it('runs in the sandbox root, not the host working directory', async () => {
    const { dispose, sandbox } = await makeSandbox({ 'script.js': 'console.log(process.cwd());' });
    try {
      const outcome = await sandbox.api().exec('node script.js', { timeoutSeconds: 30 });
      assert.equal(outcome.cwd, sandbox.root);
      assert.equal(sandbox.api().resolve('.'), sandbox.root);
      assert.notEqual(outcome.stdout.trim(), process.cwd());
    } finally {
      await dispose();
    }
  });

  it('lets the agent see files it wrote from inside a command', async () => {
    const { dispose, sandbox } = await makeSandbox({
      'script.js': "require('node:fs').writeFileSync('from-command.txt', 'written');",
    });
    try {
      const outcome = await sandbox.api().exec('node script.js', { timeoutSeconds: 30 });
      assert.equal(outcome.exitCode, 0);
      assert.equal(await sandbox.api().readTextFile('from-command.txt'), 'written');
    } finally {
      await dispose();
    }
  });
});
describe('LocalSandbox scanning', () => {
  it('sees only the workspace contents', async () => {
    const { dispose, project, sandbox } = await makeSandbox({ 'a.txt': 'x', 'src/b.ts': 'y' });
    try {
      await writeFile(join(project.path, 'host-only.txt'), 'z', 'utf8');
      await sandbox.api().writeTextFile('created.txt', 'new');

      const paths = (await sandbox.scan()).map((entry) => entry.path).sort();
      assert.deepEqual(paths, ['a.txt', 'created.txt', 'src/b.ts']);
    } finally {
      await dispose();
    }
  });
});