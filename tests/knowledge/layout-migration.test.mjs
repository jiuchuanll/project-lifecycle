import assert from 'node:assert/strict';
import { cp, lstat, mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  inspectLegacyKnowledgeLayout,
  migrateKnowledgeLayout,
} from '../../scripts/knowledge/migrate-layout.mjs';

const fixture = new URL('../fixtures/knowledge/topology/base/', import.meta.url);
const lifecycle = (root) => join(root, 'docs/project-lifecycle');
const readJson = async (path) => JSON.parse(await readFile(path, 'utf8'));

const setupLegacy = async (context) => {
  const root = await mkdtemp(join(tmpdir(), 'project-lifecycle-v1-migration-'));
  context.after(() => rm(root, { recursive: true, force: true }));
  await cp(fixture, root, { recursive: true });
  const base = lifecycle(root);
  const mapPath = join(base, 'project-map.json');
  const map = await readJson(mapPath);
  map.schema_version = 1;
  const parent = map.domains.find(({ id }) => id === 'desktop-experience');
  parent.paired_assets = {
    en: 'knowledge/desktop-experience-en.md',
    'zh-CN': 'knowledge/desktop-experience.md',
  };
  for (const constraint of map.constraints) {
    constraint.knowledge_refs = {
      en: `knowledge/desktop-experience-en.md#constraint-${constraint.id}`,
      'zh-CN': `knowledge/desktop-experience.md#constraint-${constraint.id}`,
    };
  }
  await writeFile(mapPath, `${JSON.stringify(map, null, 2)}\n`);
  for (const name of ['desktop-experience-en.md', 'desktop-experience.md']) {
    await rename(join(base, 'knowledge/desktop-experience', name), join(base, 'knowledge', name));
  }
  await rm(join(base, 'knowledge/desktop-experience'), { recursive: true });
  await rm(join(base, 'knowledge/INDEX-en.md'));
  await rm(join(base, 'knowledge/INDEX.md'));
  const english = join(base, 'knowledge/desktop-experience-en.md');
  await writeFile(english, `${(await readFile(english, 'utf8')).trimEnd()}\n\n[External guide](https://example.com/guide)\n`);
  return root;
};

const setupMultiRepositoryLegacy = async (context) => {
  const governanceRoot = await setupLegacy(context);
  const shardRoot = await mkdtemp(join(tmpdir(), 'project-lifecycle-v1-shard-'));
  context.after(() => rm(shardRoot, { recursive: true, force: true }));
  const governanceLifecycle = lifecycle(governanceRoot);
  const shardLifecycle = lifecycle(shardRoot);
  await mkdir(join(shardLifecycle, 'knowledge'), { recursive: true });
  for (const name of ['desktop-experience-en.md', 'desktop-experience.md']) {
    await rename(join(governanceLifecycle, 'knowledge', name), join(shardLifecycle, 'knowledge', name));
  }
  const mapPath = join(governanceLifecycle, 'project-map.json');
  const map = await readJson(mapPath);
  map.repositories = [{
    id: 'backend',
    purpose: { en: 'Owns backend knowledge.', 'zh-CN': '负责后端知识。' },
    portable_locator: 'github:example/backend', integration_ref: 'refs/heads/main',
    domain_ids: ['desktop-experience'],
    knowledge_asset_locators: ['knowledge/desktop-experience-en.md', 'knowledge/desktop-experience.md'],
    accepted_revision: 'revision:backend',
  }];
  await writeFile(mapPath, `${JSON.stringify(map, null, 2)}\n`);
  return { governanceRoot, shardRoot };
};

test('inspects a strict v1 flat layout without writing and reports planned moves', async (context) => {
  const root = await setupLegacy(context);
  const before = await readFile(join(lifecycle(root), 'project-map.json'), 'utf8');
  const result = await inspectLegacyKnowledgeLayout({ root });

  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.value.status, 'migration-required');
  assert.deepEqual(result.value.moved_pairs, [{
    domain_id: 'desktop-experience',
    from: {
      en: 'knowledge/desktop-experience-en.md',
      'zh-CN': 'knowledge/desktop-experience.md',
    },
    to: {
      repository_id: null,
      en: 'knowledge/desktop-experience/desktop-experience-en.md',
      'zh-CN': 'knowledge/desktop-experience/desktop-experience.md',
    },
  }]);
  assert.equal(result.value.external_link_risks.length, 1);
  assert.equal(await readFile(join(lifecycle(root), 'project-map.json'), 'utf8'), before);
});

test('requires explicit approval and exact inspection fingerprint before migration', async (context) => {
  const root = await setupLegacy(context);
  const inspection = await inspectLegacyKnowledgeLayout({ root });
  const missing = await migrateKnowledgeLayout({ root, expected_fingerprint: inspection.value.fingerprint });
  assert.equal(missing.ok, false);
  assert.equal(missing.errors[0].code, 'KNOWLEDGE_LAYOUT_MIGRATION_APPROVAL_REQUIRED');

  await writeFile(join(lifecycle(root), 'unrelated.md'), 'changed\n');
  const stale = await migrateKnowledgeLayout({
    root,
    approval_ref: 'approval:migrate-v2',
    expected_fingerprint: inspection.value.fingerprint,
  });
  assert.equal(stale.ok, false);
  assert.equal(stale.errors[0].code, 'LAYOUT_FINGERPRINT_STALE');
});

test('atomically migrates v1 to v2 and a second run performs zero writes', async (context) => {
  const root = await setupLegacy(context);
  const inspection = await inspectLegacyKnowledgeLayout({ root });
  const result = await migrateKnowledgeLayout({
    root,
    approval_ref: 'approval:migrate-v2',
    expected_fingerprint: inspection.value.fingerprint,
  });

  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.value.status, 'migrated');
  assert.equal(result.value.from_schema, 1);
  assert.equal(result.value.to_schema, 2);
  const map = await readJson(join(lifecycle(root), 'project-map.json'));
  assert.equal(map.schema_version, 2);
  assert.equal(map.domains[0].paired_assets.en,
    'knowledge/desktop-experience/desktop-experience-en.md');
  assert.equal((await lstat(join(lifecycle(root), map.domains[0].paired_assets.en))).isFile(), true);
  await assert.rejects(lstat(join(lifecycle(root), 'knowledge/desktop-experience-en.md')), { code: 'ENOENT' });
  assert.match(await readFile(join(lifecycle(root), 'knowledge/INDEX-en.md'), 'utf8'), /desktop-experience/);

  const second = await migrateKnowledgeLayout({ root });
  assert.equal(second.ok, true, JSON.stringify(second));
  assert.equal(second.value.status, 'already-v2');
  assert.deepEqual(second.value.changed, []);
});

test('rejects an incomplete v1 pair and restores the original after a late failure', async (context) => {
  const incomplete = await setupLegacy(context);
  await rm(join(lifecycle(incomplete), 'knowledge/desktop-experience.md'));
  const rejected = await inspectLegacyKnowledgeLayout({ root: incomplete });
  assert.equal(rejected.ok, false);
  assert.equal(rejected.errors[0].code, 'KNOWLEDGE_LAYOUT_MIGRATION_INVALID');

  const rollback = await setupLegacy(context);
  const inspection = await inspectLegacyKnowledgeLayout({ root: rollback });
  const before = await readFile(join(lifecycle(rollback), 'project-map.json'), 'utf8');
  const failed = await migrateKnowledgeLayout({
    root: rollback,
    approval_ref: 'approval:migrate-v2',
    expected_fingerprint: inspection.value.fingerprint,
  }, {
    afterPublish: async () => { throw new Error('late failure'); },
  });
  assert.equal(failed.ok, false);
  assert.equal(await readFile(join(lifecycle(rollback), 'project-map.json'), 'utf8'), before);
});

test('migrates repository-local shards before publishing the governance map', async (context) => {
  const { governanceRoot, shardRoot } = await setupMultiRepositoryLegacy(context);
  const repository_roots = { backend: shardRoot };
  const inspection = await inspectLegacyKnowledgeLayout({ root: governanceRoot, repository_roots });
  assert.equal(inspection.ok, true, JSON.stringify(inspection));
  const result = await migrateKnowledgeLayout({
    root: governanceRoot,
    repository_roots,
    approval_ref: 'approval:migrate-v2-multi',
    expected_fingerprint: inspection.value.fingerprint,
  });

  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal((await readJson(join(lifecycle(governanceRoot), 'project-map.json'))).schema_version, 2);
  assert.equal((await lstat(join(lifecycle(shardRoot), 'knowledge/desktop-experience/desktop-experience-en.md'))).isFile(), true);
  await assert.rejects(lstat(join(lifecycle(shardRoot), 'knowledge/desktop-experience-en.md')), { code: 'ENOENT' });
});

test('restores already-published shards when governance publication fails', async (context) => {
  const { governanceRoot, shardRoot } = await setupMultiRepositoryLegacy(context);
  const repository_roots = { backend: shardRoot };
  const inspection = await inspectLegacyKnowledgeLayout({ root: governanceRoot, repository_roots });
  const result = await migrateKnowledgeLayout({
    root: governanceRoot,
    repository_roots,
    approval_ref: 'approval:migrate-v2-multi',
    expected_fingerprint: inspection.value.fingerprint,
  }, {
    afterRepositoryPublish: async ({ repository_id: repositoryId }) => {
      if (repositoryId === null) throw new Error('governance publication failed');
    },
  });

  assert.equal(result.ok, false);
  assert.equal((await readJson(join(lifecycle(governanceRoot), 'project-map.json'))).schema_version, 1);
  assert.equal((await lstat(join(lifecycle(shardRoot), 'knowledge/desktop-experience-en.md'))).isFile(), true);
  await assert.rejects(lstat(join(lifecycle(shardRoot), 'knowledge/desktop-experience/desktop-experience-en.md')), { code: 'ENOENT' });
});
