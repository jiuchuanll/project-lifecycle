import assert from 'node:assert/strict';
import test from 'node:test';

import {
  canonicalRepositoryId,
  pairForDomain,
  planKnowledgeLayout,
} from '../../scripts/knowledge/layout-planner.mjs';

const domain = (id, parentId = null, state = 'confirmed', repositoryId = null) => ({
  id,
  kind: 'capability',
  label: { en: id, 'zh-CN': id },
  purpose: { en: `Owns ${id}.`, 'zh-CN': `负责 ${id}。` },
  domain_state: state,
  scope: { includes: [id], excludes: [] },
  parent_id: parentId,
  relationships: [],
  evidence_refs: [`repo:${id}`],
  known_gaps: [],
  ...(state === 'materialized' ? {
    baseline: `baseline:${id}`,
    paired_assets: {
      repository_id: repositoryId,
      en: `knowledge/${id}-en.md`,
      'zh-CN': `knowledge/${id}.md`,
    },
  } : {}),
});

const repository = (id, domainIds) => ({
  id,
  purpose: { en: `Owns ${id}.`, 'zh-CN': `负责 ${id}。` },
  portable_locator: `github:example/${id}`,
  integration_ref: `refs/heads/${id}`,
  domain_ids: domainIds,
  knowledge_asset_locators: [],
  accepted_revision: `revision:${id}`,
});

const mapWith = (domains, repositories = []) => ({
  schema_version: 2,
  project_id: 'sample-project',
  identity_lineage: [],
  repositories,
  constraints: [],
  domains,
});

const locatorKeys = (entries) => entries.map(({ repository_id: repositoryId, locator }) => (
  `${repositoryId ?? 'governance'}:${locator}`
));

test('plans exact canonical locators for a top-level leaf', () => {
  const map = mapWith([domain('search', null, 'materialized')]);

  const result = planKnowledgeLayout({ map });

  assert.equal(result.ok, true, JSON.stringify(result));
  assert.deepEqual(pairForDomain(result.value, 'search'), {
    repository_id: null,
    en: 'knowledge/search-en.md',
    'zh-CN': 'knowledge/search.md',
  });
  assert.deepEqual(locatorKeys(result.value.indexes), [
    'governance:knowledge/INDEX-en.md',
    'governance:knowledge/INDEX.md',
  ]);
});

test('plans parent bodies, direct-child directories, and three recursive levels', () => {
  const map = mapWith([
    domain('loop', 'runtime', 'materialized'),
    domain('runtime', null, 'materialized'),
    domain('search', 'runtime', 'materialized'),
    domain('tools', 'loop', 'materialized'),
  ]);

  const result = planKnowledgeLayout({ map });

  assert.equal(result.ok, true, JSON.stringify(result));
  assert.deepEqual(pairForDomain(result.value, 'runtime'), {
    repository_id: null,
    en: 'knowledge/runtime/runtime-en.md',
    'zh-CN': 'knowledge/runtime/runtime.md',
  });
  assert.deepEqual(pairForDomain(result.value, 'loop'), {
    repository_id: null,
    en: 'knowledge/runtime/loop/loop-en.md',
    'zh-CN': 'knowledge/runtime/loop/loop.md',
  });
  assert.deepEqual(pairForDomain(result.value, 'tools'), {
    repository_id: null,
    en: 'knowledge/runtime/loop/tools-en.md',
    'zh-CN': 'knowledge/runtime/loop/tools.md',
  });
  assert.deepEqual(pairForDomain(result.value, 'search'), {
    repository_id: null,
    en: 'knowledge/runtime/search-en.md',
    'zh-CN': 'knowledge/runtime/search.md',
  });
  assert.deepEqual(locatorKeys(result.value.indexes), [
    'governance:knowledge/INDEX-en.md',
    'governance:knowledge/INDEX.md',
    'governance:knowledge/runtime/INDEX-en.md',
    'governance:knowledge/runtime/INDEX.md',
    'governance:knowledge/runtime/loop/INDEX-en.md',
    'governance:knowledge/runtime/loop/INDEX.md',
  ]);
});

test('creates navigation for an unmaterialized parent without inventing a body', () => {
  const map = mapWith([
    domain('runtime'),
    domain('tools', 'runtime', 'materialized'),
  ]);

  const result = planKnowledgeLayout({ map });

  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(pairForDomain(result.value, 'runtime'), null);
  assert.deepEqual(pairForDomain(result.value, 'tools'), {
    repository_id: null,
    en: 'knowledge/runtime/tools-en.md',
    'zh-CN': 'knowledge/runtime/tools.md',
  });
  assert.ok(result.value.directories.some(({ locator }) => locator === 'knowledge/runtime'));
  assert.equal(result.value.bodies.some(({ domain_id: domainId }) => domainId === 'runtime'), false);
});

test('symmetrically promotes a leaf and demotes a former parent from topology alone', () => {
  const leaf = mapWith([domain('runtime', null, 'materialized')]);
  const promoted = mapWith([
    domain('runtime', null, 'materialized'),
    domain('tools', 'runtime', 'materialized'),
  ]);

  const leafLayout = planKnowledgeLayout({ map: leaf });
  const promotedLayout = planKnowledgeLayout({ map: promoted });
  const demotedLayout = planKnowledgeLayout({ map: leaf });

  assert.equal(leafLayout.ok, true, JSON.stringify(leafLayout));
  assert.equal(promotedLayout.ok, true, JSON.stringify(promotedLayout));
  assert.deepEqual(pairForDomain(leafLayout.value, 'runtime'), {
    repository_id: null,
    en: 'knowledge/runtime-en.md',
    'zh-CN': 'knowledge/runtime.md',
  });
  assert.deepEqual(pairForDomain(promotedLayout.value, 'runtime'), {
    repository_id: null,
    en: 'knowledge/runtime/runtime-en.md',
    'zh-CN': 'knowledge/runtime/runtime.md',
  });
  assert.deepEqual(demotedLayout, leafLayout);
});

test('projects cross-repository descendants as repository-local shard roots', () => {
  const map = mapWith([
    domain('api', 'runtime', 'materialized', 'backend'),
    domain('runtime', null, 'materialized'),
    domain('storage', 'api', 'materialized', 'backend'),
  ], [repository('backend', ['api', 'storage'])]);

  const result = planKnowledgeLayout({ map });

  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(canonicalRepositoryId(map, 'runtime'), null);
  assert.equal(canonicalRepositoryId(map, 'api'), 'backend');
  assert.deepEqual(pairForDomain(result.value, 'api'), {
    repository_id: 'backend',
    en: 'knowledge/api/api-en.md',
    'zh-CN': 'knowledge/api/api.md',
  });
  assert.deepEqual(pairForDomain(result.value, 'storage'), {
    repository_id: 'backend',
    en: 'knowledge/api/storage-en.md',
    'zh-CN': 'knowledge/api/storage.md',
  });
  assert.equal(result.value.directories.some(({ repository_id: id, locator }) => (
    id === 'backend' && locator === 'knowledge/runtime'
  )), false);
  assert.deepEqual(
    result.value.repositories.find(({ repository_id: id }) => id === 'backend').shard_entry_ids,
    ['api'],
  );
  assert.deepEqual(
    result.value.domains.find(({ domain_id: id }) => id === 'runtime').direct_children,
    [{ domain_id: 'api', repository_id: 'backend', portable_locator: 'github:example/backend' }],
  );
});

test('returns the same JSON-safe manifest for shuffled map input', () => {
  const domains = [
    domain('runtime', null, 'materialized'),
    domain('api', 'runtime', 'materialized', 'backend'),
    domain('storage', 'api', 'materialized', 'backend'),
    domain('search', 'runtime', 'materialized'),
  ];
  const backend = repository('backend', ['api', 'storage']);

  const first = planKnowledgeLayout({ map: mapWith(domains, [backend]) });
  const second = planKnowledgeLayout({ map: mapWith([...domains].reverse(), [{
    ...backend,
    domain_ids: [...backend.domain_ids].reverse(),
  }]) });

  assert.equal(first.ok, true, JSON.stringify(first));
  assert.deepEqual(second, first);
  assert.doesNotThrow(() => JSON.stringify(first.value));
});

test('fails closed for missing parents, cycles, ambiguous ownership, and locator collisions', () => {
  const cases = [
    mapWith([domain('orphan', 'missing', 'materialized')]),
    mapWith([domain('alpha', 'beta'), domain('beta', 'alpha')]),
    mapWith([domain('alpha')], [repository('one', ['alpha']), repository('two', ['alpha'])]),
    mapWith([domain('alpha', null, 'materialized'), domain('alpha-en', null, 'materialized')]),
  ];

  for (const map of cases) {
    const result = planKnowledgeLayout({ map });
    assert.equal(result.ok, false);
    assert.ok(result.errors.length > 0);
  }
});
