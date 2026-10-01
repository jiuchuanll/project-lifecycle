import { resolve } from 'node:path';

import { build } from 'esbuild';

export const bundleOutput = (repositoryRoot) => resolve(repositoryRoot, 'dist/project-lifecycle.mjs');

export const buildBundle = async ({ repositoryRoot, write = true }) => build({
  entryPoints: [resolve(repositoryRoot, 'scripts/bin/project-lifecycle-source.mjs')],
  outfile: bundleOutput(repositoryRoot),
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  charset: 'utf8',
  legalComments: 'none',
  sourcemap: false,
  write,
  banner: {
    js: "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);",
  },
});
