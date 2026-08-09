import { mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { buildBundle, bundleOutput } from './lib/bundle-build.mjs';

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const output = bundleOutput(repositoryRoot);

await mkdir(dirname(output), { recursive: true });
await buildBundle({ repositoryRoot });
