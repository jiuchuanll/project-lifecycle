import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { selectContext } from '../../scripts/knowledge/select-context.mjs';
import { validateJson } from '../../scripts/lib/validate-json.mjs';

const capability = (id, pairedAsset, baseline = 'baseline-7') => `---\nid: ${id}\nknowledge_state: current\npaired_asset: ${pairedAsset}\nlast_verified_baseline: ${baseline}\nimplementation_refs:\n  - repo:src/${id}\nverification_refs:\n  - repo:test/${id}\n---\n\n# SECRET BODY ${id}\n`;

const delivery = ({ id, tier = 'active', domainIds = ['wiki-workspace'] }) => `---\nschema_version: 1\nartifact_id: ${id}\nartifact_kind: prd\nprimary_route: PRD_DELIVERY\nproject_id_at_creation: sample-project\n${tier === 'active' ? 'current_project_id: sample-project\n' : ''}domain_ids:\n${domainIds.map((domainId) => `  - ${domainId}`).join('\n')}\nknowledge_baseline: baseline-7\nrelationships:\n  feedback_ids: []\n  prd_ids: []\n  legacy_artifact_refs: []\nretention_tier: ${tier}\nreclassified_from_refs: []\nobligations: []\n---\n\n# SECRET DELIVERY BODY ${id}\n`;

const projectMap = {
  schema_version: 1, project_id: 'sample-project', identity_lineage: [], repositories: [],
  constraints: [
    {
      id: 'desktop-privacy', scope: 'descendants', owner_id: 'desktop-experience', semantic_revision: 3,
      lifecycle_state: 'current',
      knowledge_refs: {
        en: 'knowledge/desktop-experience-en.md#constraint-desktop-privacy',
        'zh-CN': 'knowledge/desktop-experience.md#constraint-desktop-privacy',
      },
      exceptions: [],
    },
    {
      id: 'desktop-self', scope: 'self', owner_id: 'desktop-experience', semantic_revision: 1,
      lifecycle_state: 'current',
      knowledge_refs: {
        en: 'knowledge/desktop-experience-en.md#constraint-desktop-self',
        'zh-CN': 'knowledge/desktop-experience.md#constraint-desktop-self',
      },
      exceptions: [],
    },
    {
      id: 'wiki-selected', scope: 'selected_descendants', owner_id: 'desktop-experience',
      selected_descendants: ['wiki-workspace'], semantic_revision: 2, lifecycle_state: 'current',
      knowledge_refs: {
        en: 'knowledge/desktop-experience-en.md#constraint-wiki-selected',
        'zh-CN': 'knowledge/desktop-experience.md#constraint-wiki-selected',
      }, exceptions: [],
    },
  ],
  domains: [
    {
      id: 'desktop-experience', kind: 'domain', label: { en: 'Desktop', 'zh-CN': '桌面' }, purpose: { en: 'Desktop.', 'zh-CN': '桌面。' },
      domain_state: 'materialized', scope: { includes: ['desktop', 'source', 'wiki'], excludes: [] }, parent_id: null,
      relationships: [], evidence_refs: ['repo:README.md'], known_gaps: [], baseline: 'baseline-7',
      paired_assets: { en: 'knowledge/desktop-experience-en.md', 'zh-CN': 'knowledge/desktop-experience.md' },
    },
    {
      id: 'source-workspace', kind: 'capability', label: { en: 'Source', 'zh-CN': '来源' }, purpose: { en: 'Source.', 'zh-CN': '来源。' },
      domain_state: 'materialized', scope: { includes: ['source'], excludes: [] }, parent_id: 'desktop-experience',
      relationships: [{ kind: 'depends_on', target_id: 'wiki-workspace' }], evidence_refs: ['repo:src/source'], known_gaps: [], baseline: 'baseline-7',
      paired_assets: { en: 'knowledge/source-workspace-en.md', 'zh-CN': 'knowledge/source-workspace.md' },
    },
    {
      id: 'unrelated-workspace', kind: 'capability', label: { en: 'Other', 'zh-CN': '其他' }, purpose: { en: 'Other.', 'zh-CN': '其他。' },
      domain_state: 'materialized', scope: { includes: ['other'], excludes: [] }, parent_id: null,
      relationships: [], evidence_refs: ['repo:src/other'], known_gaps: [], baseline: 'baseline-7',
      paired_assets: { en: 'knowledge/unrelated-workspace-en.md', 'zh-CN': 'knowledge/unrelated-workspace.md' },
    },
    {
      id: 'wiki-workspace', kind: 'capability', label: { en: 'Wiki', 'zh-CN': '维基' }, purpose: { en: 'Wiki.', 'zh-CN': '维基。' },
      domain_state: 'materialized', scope: { includes: ['wiki'], excludes: [] }, parent_id: 'desktop-experience',
      relationships: [{ kind: 'depends_on', target_id: 'source-workspace' }, { kind: 'coordinates_with', target_id: 'unrelated-workspace' }],
      evidence_refs: ['repo:src/wiki'], known_gaps: [], baseline: 'baseline-7',
      paired_assets: { en: 'knowledge/wiki-workspace-en.md', 'zh-CN': 'knowledge/wiki-workspace.md' },
    },
  ],
};

const setup = async (context) => {
  const root = await mkdtemp(join(tmpdir(), 'project-lifecycle-context-'));
  context.after(() => rm(root, { recursive: true, force: true }));
  const lifecycle = join(root, 'docs/project-lifecycle');
  await mkdir(join(lifecycle, 'knowledge'), { recursive: true });
  await mkdir(join(lifecycle, 'delivery'), { recursive: true });
  await writeFile(join(lifecycle, 'project-map.json'), `${JSON.stringify(projectMap, null, 2)}\n`);
  for (const domain of projectMap.domains) {
    await writeFile(join(lifecycle, domain.paired_assets.en), capability(domain.id, domain.paired_assets['zh-CN'].split('/').at(-1)));
    await writeFile(join(lifecycle, domain.paired_assets['zh-CN']), capability(domain.id, domain.paired_assets.en.split('/').at(-1)));
  }
  await writeFile(join(lifecycle, 'delivery/prd-wiki-refresh-en.md'), delivery({ id: 'prd-wiki-refresh' }));
  await writeFile(join(lifecycle, 'delivery/prd-wiki-history-en.md'), delivery({ id: 'prd-wiki-history', tier: 'archive' }));
  return root;
};

const baseInput = (root) => ({
  root,
  knowledge_baseline: 'baseline-7',
  primary_domain_id: 'wiki-workspace',
  candidate_domain_ids: ['source-workspace', 'wiki-workspace'],
  applicable_relationships: [
    { source_id: 'source-workspace', kind: 'depends_on', target_id: 'wiki-workspace' },
    { source_id: 'wiki-workspace', kind: 'depends_on', target_id: 'source-workspace' },
  ],
  task_delivery_refs: [
    { artifact_id: 'prd-wiki-refresh', locator: 'delivery/prd-wiki-refresh-en.md' },
    { artifact_id: 'prd-wiki-history', locator: 'delivery/prd-wiki-history-en.md' },
  ],
  material_exclusions: [], evidence_gaps: [], open_questions: [], conflicts: [],
});

test('selects exact vertical constraints, explicit cyclic dependencies, and active delivery without unrelated or archive bodies', async (context) => {
  const root = await setup(context);
  const reads = [];
  const result = await selectContext(baseInput(root), { onRead: (entry) => reads.push(entry) });

  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.value.stop.code, 'SUFFICIENT');
  assert.deepEqual(result.value.affected_domain_ids, ['source-workspace', 'wiki-workspace']);
  assert.deepEqual(result.value.selected_context.map(({ kind, id }) => [kind, id]), [
    ['constraint', 'desktop-privacy'],
    ['active_delivery', 'prd-wiki-refresh'],
    ['domain_asset', 'source-workspace'],
    ['constraint', 'wiki-selected'],
    ['domain_asset', 'wiki-workspace'],
  ]);
  assert.equal(result.value.selected_context.some(({ id }) => id === 'desktop-self'), false);
  assert.deepEqual(result.value.material_exclusions, [{
    id: 'prd-wiki-history', reason: 'ARCHIVE_GATED', explanation: 'Archive content requires a separate Archive Access Receipt.',
  }]);
  assert.deepEqual(reads.map(({ level, locator, section }) => [level, locator, section]), [
    ['L0', 'project-map.json', 'document'],
    ['L2', 'knowledge/wiki-workspace-en.md', 'frontmatter'],
    ['L3', 'knowledge/source-workspace-en.md', 'frontmatter'],
    ['L4', 'delivery/prd-wiki-refresh-en.md', 'frontmatter'],
    ['L5', 'delivery/prd-wiki-history-en.md', 'frontmatter'],
  ]);
  assert.equal(reads.some(({ locator, section }) => locator.includes('unrelated') && section === 'body'), false);
  assert.equal(reads.some(({ locator, section }) => locator.includes('history') && section === 'body'), false);
  assert.equal(validateJson('context-receipt', {
    schema_version: 1,
    prd_id: 'prd-wiki-refresh',
    receipt_revision: 1,
    updated_at: '2026-08-09T00:00:00Z',
    knowledge_baseline: result.value.knowledge_baseline,
    intent_summary: 'Refresh the accepted Wiki workspace.',
    route: {
      primary_domain_id: result.value.primary_domain_id,
      affected_domain_ids: result.value.affected_domain_ids,
    },
    selected_context: result.value.selected_context,
    material_exclusions: result.value.material_exclusions,
    open_questions: result.value.open_questions,
    stop: result.value.stop,
  }).ok, true);
});

test('does not follow undeclared or caller-inapplicable horizontal edges', async (context) => {
  const root = await setup(context);
  const reads = [];
  const input = baseInput(root);
  input.candidate_domain_ids = ['wiki-workspace'];
  input.applicable_relationships = [];
  input.task_delivery_refs = [];
  const result = await selectContext(input, { onRead: (entry) => reads.push(entry) });
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.deepEqual(result.value.affected_domain_ids, ['wiki-workspace']);
  assert.equal(reads.some(({ locator }) => locator.includes('source-workspace')), false);
  assert.equal(reads.some(({ locator }) => locator.includes('unrelated-workspace')), false);
});

test('validates caller routing, dependency grounding, delivery linkage, versions, and bounded locators', async (context) => {
  const root = await setup(context);
  const cases = [
    { patch: { primary_domain_id: 'missing-domain' }, code: 'CONTEXT_DOMAIN_INVALID' },
    { patch: { candidate_domain_ids: ['missing-domain', 'wiki-workspace'] }, code: 'CONTEXT_DOMAIN_INVALID' },
    { patch: { applicable_relationships: [{ source_id: 'wiki-workspace', kind: 'depends_on', target_id: 'unrelated-workspace' }] }, code: 'CONTEXT_RELATIONSHIP_INVALID' },
    { patch: { task_delivery_refs: [{ artifact_id: 'prd-wiki-refresh', locator: '../outside.md' }] }, code: 'CONTEXT_TARGET_INVALID' },
  ];
  for (const entry of cases) {
    const result = await selectContext({ ...baseInput(root), ...entry.patch });
    assert.equal(result.ok, false);
    assert.equal(result.errors[0].code, entry.code);
  }

  await writeFile(join(root, 'docs/project-lifecycle/delivery/prd-other-en.md'), delivery({ id: 'prd-other', domainIds: ['unrelated-workspace'] }));
  const unlinked = await selectContext({
    ...baseInput(root),
    task_delivery_refs: [{ artifact_id: 'prd-other', locator: 'delivery/prd-other-en.md' }],
  });
  assert.equal(unlinked.ok, false);
  assert.equal(unlinked.errors[0].code, 'CONTEXT_DELIVERY_INVALID');

  const outside = await mkdtemp(join(tmpdir(), 'project-lifecycle-context-outside-'));
  context.after(() => rm(outside, { recursive: true, force: true }));
  await writeFile(join(outside, 'escaped.md'), capability('wiki-workspace', 'wiki-workspace.md'));
  const target = join(root, 'docs/project-lifecycle/knowledge/wiki-workspace-en.md');
  await rm(target);
  await symlink(join(outside, 'escaped.md'), target);
  const escaped = await selectContext({ ...baseInput(root), task_delivery_refs: [] });
  assert.equal(escaped.ok, false);
  assert.equal(escaped.errors[0].code, 'PATH_SYMLINK_ESCAPE');
});

test('derives only the four permitted stop codes from explicit gaps, questions, and conflicts', async (context) => {
  const root = await setup(context);
  const variants = [
    [{}, 'SUFFICIENT'],
    [{ evidence_gaps: ['fact-wiki-layout'] }, 'NEEDS_EVIDENCE'],
    [{ open_questions: ['Which accepted route applies?'] }, 'NEEDS_USER'],
    [{ conflicts: ['constraint:wiki-layout'] }, 'CONFLICT'],
    [{ evidence_gaps: ['fact-a'], open_questions: ['Question'], conflicts: ['conflict-a'] }, 'CONFLICT'],
  ];
  for (const [patch, code] of variants) {
    const result = await selectContext({ ...baseInput(root), task_delivery_refs: [], ...patch });
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.equal(result.value.stop.code, code);
    assert.equal(['NEEDS_EVIDENCE', 'NEEDS_USER', 'CONFLICT', 'SUFFICIENT'].includes(result.value.stop.code), true);
    assert.equal('confidence' in result.value, false);
  }
});
