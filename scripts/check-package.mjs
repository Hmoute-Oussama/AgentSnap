#!/usr/bin/env node
/**
 * Pre-publish sanity check for the package manifest and the files it would publish.
 *
 * This runs without any dependency on npm's own packing logic, so it works offline and in
 * CI before a release. It answers one question: would `npm publish` ship something that a
 * user cannot run?
 */
import { createRequire } from 'node:module';
import { readFile, stat } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(join(root, 'package.json'));
const pkg = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));

const problems = [];
const check = (condition, message) => {
  if (!condition) problems.push(message);
};

// --- Manifest shape ---------------------------------------------------------
check(pkg.name === 'agentsnap', `package name must be "agentsnap", found ${JSON.stringify(pkg.name)}`);
check(/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/.test(pkg.version ?? ''), `version must be semver, found ${pkg.version}`);
check(typeof pkg.description === 'string' && pkg.description.length > 20, 'description must be a real sentence');
check(pkg.license === 'MIT', `license must be MIT, found ${pkg.license}`);
check(pkg.type === 'module', 'type must be module: the package is ESM only');
check(
  pkg.engines?.node?.startsWith('>=20.11'),
  `engines.node must be >=20.11.0 for AbortSignal.any and glob support, found ${pkg.engines?.node}`,
);
check(Array.isArray(pkg.files) && pkg.files.length > 0, 'files must list what gets published');

// --- Entry points resolve ---------------------------------------------------
const entryPoints = new Set([pkg.main, pkg.types, pkg.bin?.agentsnap]);
for (const target of Object.values(pkg.exports ?? {})) {
  if (typeof target === 'string') entryPoints.add(target);
  else for (const value of Object.values(target)) if (typeof value === 'string') entryPoints.add(value);
}

for (const entry of entryPoints) {
  if (typeof entry !== 'string') continue;
  const target = join(root, entry);
  try {
    const info = await stat(target);
    check(info.isFile(), `entry point ${entry} is not a file`);
  } catch {
    problems.push(`entry point ${entry} does not exist; run \`npm run build\` before publishing`);
  }
}

// The CLI must be executable through the declared bin, not merely present.
try {
  const bin = join(root, pkg.bin.agentsnap);
  const source = await readFile(bin, 'utf8');
  check(
    source.startsWith('#!'),
    `${pkg.bin.agentsnap} needs a shebang so \`npx agentsnap\` works`,
  );
  check(
    !/\r\n/.test(source.slice(0, 200)),
    `${pkg.bin.agentsnap} must use LF line endings so the shebang is honoured on Linux`,
  );
} catch {
  problems.push(`cannot read the bin entry ${pkg.bin?.agentsnap}`);
}

// --- Dependencies -----------------------------------------------------------
const declared = Object.keys(pkg.dependencies ?? {});
for (const name of declared) {
  try {
    require.resolve(name);
  } catch {
    problems.push(`dependency "${name}" is declared but not installed`);
  }
}
check(declared.includes('yaml'), 'the config loader needs yaml');
check(declared.includes('minimatch'), 'assertion and exclusion globs need minimatch');

for (const name of ['typescript', 'eslint']) {
  check(
    Object.keys(pkg.devDependencies ?? {}).includes(name),
    `${name} must stay a devDependency: it must never reach a user's install`,
  );
}

// --- Published payload ------------------------------------------------------
for (const entry of pkg.files) {
  if (entry === 'dist') continue;
  try {
    await stat(join(root, entry));
  } catch {
    problems.push(`files lists "${entry}", which does not exist in the repository`);
  }
}

// Anything the manifest promises must not be gitignored, or npm will silently skip it.
const ignored = await readGitignore();
for (const entry of pkg.files) {
  if (entry === 'dist' && ignored.includes('/dist')) continue;
  if (entry !== 'dist' && ignored.split('\n').some((line) => line.replace(/^\/|\/$/g, '') === entry)) {
    problems.push(`files lists "${entry}" but .gitignore excludes it`);
  }
}

// --- Report -----------------------------------------------------------------
if (problems.length > 0) {
  process.stderr.write(`package check failed:\n${problems.map((p) => `  - ${p}`).join('\n')}\n`);
  process.exit(1);
}

process.stdout.write(
  `package check passed: ${pkg.name}@${pkg.version}, ${entryPoints.size} entry points, ${declared.length} dependencies\n`,
);

/** Minimal .gitignore reader: only exact-path and trailing-slash rules matter here. */
async function readGitignore() {
  try {
    return await readFile(join(root, '.gitignore'), 'utf8');
  } catch {
    return '';
  }
}