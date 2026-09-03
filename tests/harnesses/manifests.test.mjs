import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const root = new URL('../../', import.meta.url);
const canonicalRepository = `https://${['github', 'com'].join('.')}/${['jiuchuan', 'll'].join('')}/project-lifecycle`;
const manifests = [
  ['codex', '.codex-plugin/plugin.json', './skills/'],
  ['claude', '.claude-plugin/plugin.json', null],
  ['cursor', '.cursor-plugin/plugin.json', './skills/'],
  ['kimi', '.kimi-plugin/plugin.json', './skills/'],
  ['zcode', '.zcode-plugin/plugin.json', 'skills'],
];
const json = async (path) => JSON.parse(await readFile(new URL(path, root), 'utf8'));

test('keeps five native manifests on one plugin identity and canonical Skill source', async () => {
  for (const [host, path, skillsForm] of manifests) {
    const manifest = await json(path);
    assert.equal(manifest.name, 'project-lifecycle', host);
    assert.equal(manifest.version, '0.7.0', host);
    assert.equal(manifest.repository, canonicalRepository, host);
    assert.equal(manifest.author?.name, 'jiuchuanll', host);
    assert.equal(typeof manifest.description, 'string', host);
    assert.ok(manifest.description.length > 0, host);
    if (skillsForm) assert.equal(manifest.skills, skillsForm, host);
    else assert.equal(Object.hasOwn(manifest, 'skills'), false, host);
  }
  assert.equal((await json('.zcode-plugin/plugin.json')).license, 'Apache-2.0', 'zcode');
});

test('keeps host manifests metadata-only and free of copied lifecycle semantics', async () => {
  for (const [host, path] of manifests) {
    const source = await readFile(new URL(path, root), 'utf8');
    assert.doesNotMatch(source, /\/Users\/|[A-Za-z]:\\|token|password|api[_-]?key/iu, host);
    assert.doesNotMatch(source, /sessionStart|mcpServers|FEEDBACK_ONLY|PRD_DELIVERY|KNOWLEDGE_ONLY|QUICK_TASK/u, host);
    assert.doesNotMatch(source, /schema_version|pending-changes|knowledge-diff/iu, host);
  }
});

test('declares the DSH bundle entry without touching the five native manifests', async () => {
  const packageJson = await json('package.json');
  assert.equal(packageJson.main, './dsh/index.js');
  assert.equal(packageJson.dsh?.bundle?.patch, './cordis.patch.yml');
  assert.equal(Object.hasOwn(packageJson, 'peerDependencies'), false);

  const patch = await readFile(new URL('cordis.patch.yml', root), 'utf8');
  assert.match(patch, /- insert:/u);
  assert.match(patch, /name: project-lifecycle/u);
  assert.doesNotMatch(patch, /\/Users\/|[A-Za-z]:\\|token|password|api[_-]?key/iu);

  const entry = await readFile(new URL('dsh/index.js', root), 'utf8');
  assert.match(entry, /registerProvider/u);
  assert.match(entry, /\.\.\/skills\//u);
  assert.doesNotMatch(entry, /\/Users\/|[A-Za-z]:\\|token|password|api[_-]?key/iu);
});

test('publishes root plugin entries through Codex and Claude marketplaces', async () => {
  const codex = await json('.agents/plugins/marketplace.json');
  assert.equal(codex.name, 'project-lifecycle');
  assert.equal(codex.interface.displayName, 'Project Lifecycle');
  assert.deepEqual(codex.plugins, [{
    name: 'project-lifecycle',
    source: { source: 'local', path: './' },
    policy: { installation: 'AVAILABLE', authentication: 'ON_INSTALL' },
    category: 'Developer Tools',
  }]);

  const claude = await json('.claude-plugin/marketplace.json');
  assert.equal(claude.name, 'project-lifecycle');
  assert.equal(claude.owner.name, 'jiuchuanll');
  assert.deepEqual(claude.plugins, [{
    name: 'project-lifecycle',
    source: './',
    version: '0.7.0',
    description: 'Build low-noise project knowledge and run traceable PRD delivery lifecycles.',
  }]);
});
