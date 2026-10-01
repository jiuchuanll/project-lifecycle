import { execFile } from 'node:child_process';
import { lstat, readFile, readdir } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { promisify } from 'node:util';
import { pathToFileURL } from 'node:url';

import { createError } from '../lib/errors.mjs';
import { fail, ok } from '../lib/result.mjs';

const exec = promisify(execFile);
const hosts = ['claude', 'codex', 'cursor', 'dsh', 'kimi', 'zcode'];
const manifests = Object.freeze({
  claude: '.claude-plugin/plugin.json', codex: '.codex-plugin/plugin.json',
  cursor: '.cursor-plugin/plugin.json', kimi: '.kimi-plugin/plugin.json', zcode: '.zcode-plugin/plugin.json',
});
const failure = () => fail([createError('STATIC_CONFORMANCE_FAILED', '/', 'Plugin package static conformance failed.')]);
const json = async (root, path) => JSON.parse(await readFile(join(root, path), 'utf8'));

export async function runStaticConformance({ root } = {}) {
  if (typeof root !== 'string' || !isAbsolute(root)) return failure();
  try {
    const packageJson = await json(root, 'package.json');
    const skillDirectories = (await readdir(join(root, 'skills'), { withFileTypes: true }))
      .filter((entry) => entry.isDirectory()).map(({ name }) => name).sort();
    if (skillDirectories.join('\0') !== 'maintain-project-knowledge\0run-prd-lifecycle') return failure();
    for (const id of skillDirectories) {
      const directory = join(root, 'skills', id);
      const source = await readFile(join(directory, 'SKILL.md'), 'utf8');
      if (!source.includes(`name: ${id}`) || !source.includes('docs/project-lifecycle/')) return failure();
      for (const [, locator] of source.matchAll(/\]\((references\/[^)#]+\.md)\)/gu)) {
        if (!(await lstat(join(directory, locator))).isFile()) return failure();
      }
    }
    for (const host of hosts) {
      if (host === 'dsh') {
        if (packageJson.dsh?.bundle?.patch !== './cordis.patch.yml') return failure();
        if (!(await lstat(join(root, 'cordis.patch.yml'))).isFile()) return failure();
        if (!(await lstat(join(root, 'dsh', 'index.js'))).isFile()) return failure();
      } else {
        const manifest = await json(root, manifests[host]);
        if (manifest.name !== packageJson.name || manifest.version !== packageJson.version) return failure();
      }
      const entries = await readdir(join(root, 'integrations', host), { recursive: true });
      if (entries.some((path) => path.endsWith('SKILL.md'))) return failure();
    }
    const { stdout, stderr } = await exec(process.execPath, [join(root, 'dist/project-lifecycle.mjs'), 'version'], { encoding: 'utf8' });
    const version = JSON.parse(stdout);
    if (stderr !== '' || !version.ok || version.value.version !== packageJson.version) return failure();
    return ok({ skill_ids: skillDirectories, host_ids: hosts, bundle_version: version.value.version });
  } catch {
    return failure();
  }
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  const result = await runStaticConformance({ root: process.cwd() });
  console.log(JSON.stringify(result));
  if (!result.ok) process.exitCode = 1;
}
