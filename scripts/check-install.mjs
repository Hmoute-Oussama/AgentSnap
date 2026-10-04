#!/usr/bin/env node
/**
 * Installs the packed tarball into a throwaway directory and uses it.
 *
 * Unit tests import from `src`, and the E2E tests import from `dist`, so neither can catch a
 * packaging mistake: a missing `files` entry, a broken `exports` map, or a dependency that
 * only exists in devDependencies all pass CI and then fail for every user. This script closes
 * that gap by testing the artifact exactly as npm would deliver it.
 */
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const problems = [];
const check = (condition, message) => {
  if (!condition) problems.push(message);
};

// npm ships as a .cmd shim on Windows, which Node cannot spawn without a shell. When this
// script runs through `npm run`, npm_execpath points straight at npm's own entry point, so
// the usual case stays shell-free.
const npmExecPath = process.env['npm_execpath'];

function npm(args, options = {}) {
  const result =
    npmExecPath !== undefined && npmExecPath.endsWith('.js')
      ? spawnSync(process.execPath, [npmExecPath, ...args], { encoding: 'utf8', ...options })
      : spawnSync('npm', args, {
          encoding: 'utf8',
          shell: process.platform === 'win32',
          ...options,
        });
  return result;
}

const workspace = await mkdtemp(join(tmpdir(), 'agentsnap-install-'));
const project = join(workspace, 'consumer');
const installDir = join(workspace, 'node_modules');

try {
  // --- Pack ------------------------------------------------------------------
  const packed = npm(['pack', '--json', '--pack-destination', workspace], { cwd: root });
  if (packed.status !== 0) {
    process.stderr.write(`npm pack failed:\n${packed.stderr ?? ''}\n`);
    process.exit(1);
  }
  const [{ filename }] = JSON.parse(packed.stdout);
  const tarball = join(workspace, filename);
  process.stdout.write(`packed ${filename}\n`);

  // --- Contents --------------------------------------------------------------
  const listed = npm(['pack', '--dry-run', '--json'], { cwd: root });
  const files = JSON.parse(listed.stdout)[0].files.map((entry) => entry.path);
  const forbidden = files.filter(
    (entry) =>
      entry.startsWith('src/') ||
      entry.startsWith('tests/') ||
      entry.startsWith('build/') ||
      entry.startsWith('.github/') ||
      entry.endsWith('.tsbuildinfo'),
  );
  check(forbidden.length === 0, `the tarball must not ship sources or tests: ${forbidden.join(', ')}`);
  check(files.some((entry) => entry.startsWith('dist/cli/bin.js')), 'the tarball must ship the CLI');

  // --- Install ---------------------------------------------------------------
  await writeFile(
    join(workspace, 'package.json'),
    `${JSON.stringify({ name: 'agentsnap-install-check', private: true, version: '0.0.0' }, null, 2)}\n`,
  );
  const installed = npm(['install', tarball, '--no-audit', '--no-fund', '--ignore-scripts'], {
    cwd: workspace,
  });
  if (installed.status !== 0) {
    process.stderr.write(`installing the tarball failed:\n${installed.stderr ?? ''}\n`);
    process.exit(1);
  }

  const packageRoot = join(installDir, 'agentsnap');
  const manifest = JSON.parse(await readFile(join(packageRoot, 'package.json'), 'utf8'));
  check(
    Object.keys(manifest.devDependencies ?? {}).length >= 0 &&
      !(await exists(join(packageRoot, 'node_modules', 'typescript'))),
    'a consumer install must not contain typescript',
  );
  for (const dependency of Object.keys(manifest.dependencies ?? {})) {
    // npm may hoist to the top or nest it under the package; both are valid installs.
    const hoisted = await exists(join(installDir, dependency));
    const nested = await exists(join(packageRoot, 'node_modules', dependency));
    check(
      hoisted || nested,
      `runtime dependency "${dependency}" was not installed with the package`,
    );
  }

  // --- The CLI works from the installed package --------------------------------
  const bin = join(packageRoot, 'dist', 'cli', 'bin.js');
  const version = spawnSync(process.execPath, [bin, '--version'], { encoding: 'utf8' });
  check(version.status === 0, `\`agentsnap --version\` failed: ${version.stderr ?? ''}`);
  check(/\d+\.\d+\.\d+/.test(version.stdout ?? ''), '--version must print a version number');

  await mkdir(project, { recursive: true });
  await writeFile(
    join(project, 'agentsnap.yaml'),
    [
      'version: 1',
      'agent:',
      '  provider: fake',
      'tests:',
      '  - name: installed package works',
      '    prompt: "read: a.txt"',
      '    assertions:',
      '      - file_read: a.txt',
      '',
    ].join('\n'),
  );
  await writeFile(join(project, 'a.txt'), 'hello', 'utf8');
  const run = spawnSync(process.execPath, [bin, 'run'], { cwd: project, encoding: 'utf8' });
  check(run.status === 0, `\`agentsnap run\` failed from an installed package:\n${run.stdout ?? ''}${run.stderr ?? ''}`);
  check(/PASS/.test(run.stdout ?? ''), 'the installed CLI must report a passing run');

  // --- The library entry point resolves ---------------------------------------
  const library = spawnSync(
    process.execPath,
    ['--input-type=module', '-e', "import('agentsnap').then((m) => console.log(Object.keys(m).length))"],
    { cwd: workspace, encoding: 'utf8' },
  );
  check(library.status === 0, `importing "agentsnap" failed: ${library.stderr ?? ''}`);
  check(Number(library.stdout.trim()) > 0, 'the library entry point must export something');
} finally {
  await rm(workspace, { recursive: true, force: true, maxRetries: 3 }).catch(() => undefined);
}

if (problems.length > 0) {
  process.stderr.write(`install check failed:\n${problems.map((p) => `  - ${p}`).join('\n')}\n`);
  process.exit(1);
}
process.stdout.write('install check passed: the packed tarball installs and runs\n');

async function exists(path) {
  try {
    await readdir(path);
    return true;
  } catch {
    return false;
  }
}