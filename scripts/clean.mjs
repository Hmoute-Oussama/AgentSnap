import { rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

for (const target of ['dist', 'build', 'coverage']) {
  await rm(join(root, target), { recursive: true, force: true });
}
