import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';

import { selectContext } from '../../scripts/knowledge/select-context.mjs';
import { generateIndexesFromRoot } from '../../scripts/knowledge/generate-indexes.mjs';
import { validateJson } from '../../scripts/lib/validate-json.mjs';

const constraintBlocks = (id) => id === 'desktop-experience'
  ? '\n<a id="constraint-desktop-privacy"></a>\n<!-- project-lifecycle:constraint id=desktop-privacy revision=3 -->\nprivacy\n<!-- /project-lifecycle:constraint -->\n<a id="constraint-desktop-self"></a>\n<!-- project-lifecycle:constraint id=desktop-self revision=1 -->\nself\n<!-- /project-lifecycle:constraint -->\n<a id="constraint-wiki-selected"></a>\n<!-- project-lifecycle:constraint id=wiki-selected revision=2 -->\nselected\n<!-- /project-lifecycle:constraint -->\n'
  : id === 'unrelated-workspace'
    ? '\n<a id="constraint-other-policy"></a>\n<!-- project-lifecycle:constraint id=other-policy revision=1 -->\npolicy\n<!-- /project-lifecycle:constraint -->\n'
    : '';

const capability = (id, pairedAsset, baseline = 'baseline-7') => `---\nid: ${id}\nknowledge_state: current\npaired_asset: ${pairedAsset}\nlast_verified_baseline: ${baseline}\nimplementation_refs:\n  - repo:src/${id}\nverification_refs:\n  - repo:test/${id}\n---\n\n# SECRET BODY ${id}\n${constraintBlocks(id)}`;

const delivery = ({ id, tier = 'active', domainIds = ['wiki-workspace'], kind = 'prd', baseline = 'global-baseline-7', projectId = 'sample-project' }) => `---\nschema_version: 2\nartifact_id: ${id}\nartifact_kind: ${kind}\nowner_artifact_id: ${id}\nprimary_route: PRD_DELIVERY\nproject_id_at_creation: ${projectId}\n${tier === 'active' ? `current_project_id: ${projectId}\n` : ''}domain_ids:\n${domainIds.map((domainId) => `  - ${domainId}`).join('\n')}\nknowledge_baseline: ${baseline}\nrelationships:\n  feedback_ids: []\n  prd_ids: []\n  legacy_artifact_refs: []\nretention_tier: ${tier}\nreclassified_from_refs: []\nobligations: []\n---\n\n# SECRET DELIVERY BODY ${id}\n`;

const projectMap = {
  schema_version: 2, project_id: 'sample-project',
  knowledge_baseline: 'global-baseline-7',
  project_identity: {
    label: { en: 'Sample project', 'zh-CN': '示例项目' },
    purpose: { en: 'Routes sample work.', 'zh-CN': '路由示例工作。' },
    calibration_ref: 'calibration:sample-project',
  },
  identity_lineage: [], repositories: [],
  constraints: [
    {
      id: 'desktop-privacy', scope: 'descendants', owner_id: 'desktop-experience', semantic_revision: 3,
      lifecycle_state: 'current',
      knowledge_refs: {
        en: 'knowledge/desktop-experience/desktop-experience-en.md#constraint-desktop-privacy',
        'zh-CN': 'knowledge/desktop-experience/desktop-experience.md#constraint-desktop-privacy',
      },
      exceptions: [],
    },
    {
      id: 'desktop-self', scope: 'self', owner_id: 'desktop-experience', semantic_revision: 1,
      lifecycle_state: 'current',
      knowledge_refs: {
        en: 'knowledge/desktop-experience/desktop-experience-en.md#constraint-desktop-self',
        'zh-CN': 'knowledge/desktop-experience/desktop-experience.md#constraint-desktop-self',
      },
      exceptions: [],
    },
    {
      id: 'other-policy', scope: 'self', owner_id: 'unrelated-workspace', semantic_revision: 1,
      lifecycle_state: 'current',
      knowledge_refs: {
        en: 'knowledge/unrelated-workspace-en.md#constraint-other-policy',
        'zh-CN': 'knowledge/unrelated-workspace.md#constraint-other-policy',
      }, exceptions: [],
    },
    {
      id: 'wiki-selected', scope: 'selected_descendants', owner_id: 'desktop-experience',
      selected_descendants: ['wiki-workspace'], semantic_revision: 2, lifecycle_state: 'current',
      knowledge_refs: {
        en: 'knowledge/desktop-experience/desktop-experience-en.md#constraint-wiki-selected',
        'zh-CN': 'knowledge/desktop-experience/desktop-experience.md#constraint-wiki-selected',
      }, exceptions: [],
    },
  ],
  domains: [
    {
      id: 'desktop-experience', kind: 'domain', label: { en: 'Desktop', 'zh-CN': '桌面' }, purpose: { en: 'Desktop.', 'zh-CN': '桌面。' },
      domain_state: 'materialized', scope: { includes: ['desktop', 'source', 'wiki'], excludes: [] }, parent_id: null,
      relationships: [], evidence_refs: ['repo:README.md'], known_gaps: [], baseline: 'baseline-7',
      paired_assets: { repository_id: null, en: 'knowledge/desktop-experience/desktop-experience-en.md', 'zh-CN': 'knowledge/desktop-experience/desktop-experience.md' },
    },
    {
      id: 'source-workspace', kind: 'capability', label: { en: 'Source', 'zh-CN': '来源' }, purpose: { en: 'Source.', 'zh-CN': '来源。' },
      domain_state: 'materialized', scope: { includes: ['source'], excludes: [] }, parent_id: 'desktop-experience',
      relationships: [{ kind: 'depends_on', target_id: 'wiki-workspace' }], evidence_refs: ['repo:src/source'], known_gaps: [], baseline: 'baseline-7',
      paired_assets: { repository_id: null, en: 'knowledge/desktop-experience/source-workspace-en.md', 'zh-CN': 'knowledge/desktop-experience/source-workspace.md' },
    },
    {
      id: 'unrelated-workspace', kind: 'capability', label: { en: 'Other', 'zh-CN': '其他' }, purpose: { en: 'Other.', 'zh-CN': '其他。' },
      domain_state: 'materialized', scope: { includes: ['other'], excludes: [] }, parent_id: null,
      relationships: [], evidence_refs: ['repo:src/other'], known_gaps: [], baseline: 'baseline-7',
      paired_assets: { repository_id: null, en: 'knowledge/unrelated-workspace-en.md', 'zh-CN': 'knowledge/unrelated-workspace.md' },
    },
    {
      id: 'wiki-workspace', kind: 'capability', label: { en: 'Wiki', 'zh-CN': '维基' }, purpose: { en: 'Wiki.', 'zh-CN': '维基。' },
      domain_state: 'materialized', scope: { includes: ['wiki'], excludes: [] }, parent_id: 'desktop-experience',
      relationships: [{ kind: 'depends_on', target_id: 'source-workspace' }, { kind: 'coordinates_with', target_id: 'unrelated-workspace' }, { kind: 'governed_by', target_id: 'unrelated-workspace' }],
      evidence_refs: ['repo:src/wiki'], known_gaps: [], baseline: 'baseline-7',
      paired_assets: { repository_id: null, en: 'knowledge/desktop-experience/wiki-workspace-en.md', 'zh-CN': 'knowledge/desktop-experience/wiki-workspace.md' },
    },
  ],
};

const setup = async (context, map = projectMap) => {
  const root = await mkdtemp(join(tmpdir(), 'project-lifecycle-context-'));
  context.after(() => rm(root, { recursive: true, force: true }));
  const lifecycle = join(root, 'docs/project-lifecycle');
  await mkdir(join(lifecycle, 'knowledge'), { recursive: true });
  await mkdir(join(lifecycle, 'delivery/prds/prd-wiki-refresh'), { recursive: true });
  await mkdir(join(lifecycle, 'archive/delivery/prds/prd-wiki-history'), { recursive: true });
  await mkdir(join(lifecycle, 'archive/delivery/prds/prd-wiki-closed'), { recursive: true });
  await writeFile(join(lifecycle, 'delivery/layout.json'), '{"schema_version":1,"layout_version":2}\n');
  await writeFile(join(lifecycle, 'project-map.json'), `${JSON.stringify(map, null, 2)}\n`);
  for (const domain of map.domains) {
    await mkdir(dirname(join(lifecycle, domain.paired_assets.en)), { recursive: true });
    const pairedAsset = domain.paired_assets['zh-CN'].split('/').at(-1);
    await writeFile(join(lifecycle, domain.paired_assets.en), capability(domain.id, pairedAsset));
    await writeFile(join(lifecycle, domain.paired_assets['zh-CN']), capability(domain.id, pairedAsset));
  }
  await writeFile(join(lifecycle, 'delivery/prds/prd-wiki-refresh/prd-wiki-refresh-en.md'), delivery({ id: 'prd-wiki-refresh' }));
  await writeFile(join(lifecycle, 'delivery/prds/prd-wiki-refresh/prd-wiki-refresh.md'), delivery({ id: 'prd-wiki-refresh' }));
  await writeFile(join(lifecycle, 'archive/delivery/prds/prd-wiki-history/prd-wiki-history-en.md'), delivery({ id: 'prd-wiki-history', tier: 'archive' }));
  await writeFile(join(lifecycle, 'archive/delivery/prds/prd-wiki-history/prd-wiki-history.md'), delivery({ id: 'prd-wiki-history', tier: 'archive' }));
  await writeFile(join(lifecycle, 'archive/delivery/prds/prd-wiki-closed/prd-wiki-closed-en.md'), delivery({ id: 'prd-wiki-closed', tier: 'closed-summary' }));
  await writeFile(join(lifecycle, 'archive/delivery/prds/prd-wiki-closed/prd-wiki-closed.md'), delivery({ id: 'prd-wiki-closed', tier: 'closed-summary' }));
  const indexes = await generateIndexesFromRoot({ map, lifecycleRoot: lifecycle });
  assert.equal(indexes.ok, true, JSON.stringify(indexes));
  for (const file of indexes.value.files.filter(({ repository_id: repositoryId }) => repositoryId === null)) {
    await mkdir(dirname(join(lifecycle, file.locator)), { recursive: true });
    await writeFile(join(lifecycle, file.locator), file.content);
  }
  return root;
};

const baseInput = (root) => ({
  root,
  knowledge_baseline: 'global-baseline-7',
  primary_domain_id: 'wiki-workspace',
  candidate_domain_ids: ['source-workspace', 'wiki-workspace'],
  applicable_relationships: [
    { source_id: 'source-workspace', kind: 'depends_on', target_id: 'wiki-workspace' },
    { source_id: 'wiki-workspace', kind: 'depends_on', target_id: 'source-workspace' },
  ],
  task_delivery_refs: [
    { artifact_id: 'prd-wiki-refresh', locator: 'delivery/prds/prd-wiki-refresh/prd-wiki-refresh-en.md' },
    { artifact_id: 'prd-wiki-history', locator: 'archive/delivery/prds/prd-wiki-history/prd-wiki-history-en.md' },
    { artifact_id: 'prd-wiki-closed', locator: 'archive/delivery/prds/prd-wiki-closed/prd-wiki-closed-en.md' },
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
  assert.deepEqual(result.value.material_exclusions, [
    { id: 'prd-wiki-closed', reason: 'OUT_OF_SCOPE', explanation: 'Closed summaries are locators, not active task context.' },
    { id: 'prd-wiki-history', reason: 'ARCHIVE_GATED', explanation: 'Archive content requires a separate Archive Access Receipt.' },
  ]);
  assert.deepEqual(reads.map(({ level, locator, section }) => [level, locator, section]), [
    ['L0', 'project-map.json', 'document'],
    ['L0', 'INDEX-en.md', 'navigation-index'],
    ['L0', 'knowledge/INDEX-en.md', 'navigation-index'],
    ['L0', 'knowledge/desktop-experience/INDEX-en.md', 'navigation-index'],
    ['L1', 'knowledge/desktop-experience/desktop-experience-en.md', 'constraint-anchor'],
    ['L1', 'knowledge/desktop-experience/desktop-experience-en.md', 'constraint-anchor'],
    ['L2', 'knowledge/desktop-experience/wiki-workspace-en.md', 'frontmatter'],
    ['L3', 'knowledge/desktop-experience/source-workspace-en.md', 'frontmatter'],
    ['L4', 'delivery/prds/prd-wiki-refresh/prd-wiki-refresh-en.md', 'frontmatter'],
    ['L5', 'archive/delivery/prds/prd-wiki-history/prd-wiki-history-en.md', 'frontmatter'],
    ['L4', 'archive/delivery/prds/prd-wiki-closed/prd-wiki-closed-en.md', 'frontmatter'],
  ]);
  assert.equal(reads.filter(({ level }) => level === 'L1').every(({ bytes_read: bytesRead }) => Number.isInteger(bytesRead) && bytesRead > 0), true);
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

test('applies relationship kinds without generic governing-body traversal', async (context) => {
  const root = await setup(context);
  const reads = [];
  const input = baseInput(root);
  input.candidate_domain_ids = ['wiki-workspace'];
  input.applicable_relationships = [{ source_id: 'wiki-workspace', kind: 'governed_by', target_id: 'unrelated-workspace' }];
  input.task_delivery_refs = [];
  const result = await selectContext(input, { onRead: (entry) => reads.push(entry) });
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.value.selected_context.some(({ id }) => id === 'other-policy'), true);
  assert.equal(result.value.selected_context.some(({ id }) => id === 'unrelated-workspace'), false);
  assert.equal(reads.some(({ level, locator }) => level === 'L3' && locator.includes('unrelated')), false);
  assert.equal(reads.some(({ level, locator }) => level === 'L1' && locator.includes('unrelated')), true);
});

test('validates caller routing, dependency grounding, delivery linkage, versions, and bounded locators', async (context) => {
  const root = await setup(context);
  const cases = [
    { patch: { primary_domain_id: 'missing-domain' }, code: 'CONTEXT_DOMAIN_INVALID' },
    { patch: { candidate_domain_ids: ['missing-domain', 'wiki-workspace'] }, code: 'CONTEXT_DOMAIN_INVALID' },
    { patch: { applicable_relationships: [{ source_id: 'wiki-workspace', kind: 'depends_on', target_id: 'unrelated-workspace' }] }, code: 'CONTEXT_RELATIONSHIP_INVALID' },
    { patch: { task_delivery_refs: [{ artifact_id: 'prd-wiki-refresh', locator: '../outside.md' }] }, code: 'CONTEXT_TARGET_INVALID' },
    { patch: { task_delivery_refs: [{ artifact_id: 'prd-wiki-refresh', locator: 'delivery/bad).md' }] }, code: 'CONTEXT_TARGET_INVALID' },
    { patch: { task_delivery_refs: [{ artifact_id: 'prd-wiki-refresh', locator: 'delivery/bad#fragment.md' }] }, code: 'CONTEXT_TARGET_INVALID' },
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
  const target = join(root, 'docs/project-lifecycle/knowledge/desktop-experience/wiki-workspace-en.md');
  await rm(target);
  await symlink(join(outside, 'escaped.md'), target);
  const escaped = await selectContext({ ...baseInput(root), task_delivery_refs: [] });
  assert.equal(escaped.ok, false);
  assert.equal(escaped.errors[0].code, 'PATH_SYMLINK_ESCAPE');
});

test('pins accepted baselines, delivery identity/retention, and selected ID uniqueness', async (context) => {
  const root = await setup(context);
  const exact = await selectContext({ ...baseInput(root), task_delivery_refs: [] });
  assert.equal(exact.ok, true, JSON.stringify(exact));
  assert.equal(exact.value.stop.code, 'SUFFICIENT');

  const domainOnly = await selectContext({ ...baseInput(root), knowledge_baseline: 'baseline-7', task_delivery_refs: [] });
  assert.equal(domainOnly.ok, true, JSON.stringify(domainOnly));
  assert.equal(domainOnly.value.stop.code, 'NEEDS_EVIDENCE');

  const invented = await selectContext({ ...baseInput(root), knowledge_baseline: 'invented-baseline', task_delivery_refs: [] });
  assert.equal(invented.ok, true);
  assert.equal(invented.value.stop.code, 'NEEDS_EVIDENCE');

  await writeFile(join(root, 'docs/project-lifecycle/delivery/prd-foreign-en.md'), delivery({ id: 'prd-foreign', projectId: 'foreign-project' }));
  const foreign = await selectContext({ ...baseInput(root), task_delivery_refs: [{ artifact_id: 'prd-foreign', locator: 'delivery/prd-foreign-en.md' }] });
  assert.equal(foreign.ok, false);
  assert.equal(foreign.errors[0].code, 'CONTEXT_DELIVERY_INVALID');

  await writeFile(join(root, 'docs/project-lifecycle/delivery/prd-stale-en.md'), delivery({ id: 'prd-stale', baseline: 'baseline-old' }));
  const stale = await selectContext({ ...baseInput(root), task_delivery_refs: [{ artifact_id: 'prd-stale', locator: 'delivery/prd-stale-en.md' }] });
  assert.equal(stale.ok, true, JSON.stringify(stale));
  assert.equal(stale.value.stop.code, 'CONFLICT');
  assert.deepEqual(stale.value.material_exclusions, [{
    id: 'prd-stale', reason: 'STALE', explanation: 'Active delivery is pinned to a different knowledge baseline.',
  }]);
  assert.equal(stale.value.selected_context.some(({ id }) => id === 'prd-stale'), false);

  await writeFile(join(root, 'docs/project-lifecycle/delivery/wiki-workspace-en.md'), delivery({ id: 'wiki-workspace', kind: 'architecture' }));
  const collision = await selectContext({ ...baseInput(root), task_delivery_refs: [{ artifact_id: 'wiki-workspace', locator: 'delivery/wiki-workspace-en.md' }] });
  assert.equal(collision.ok, false);
  assert.equal(collision.errors[0].code, 'CONTEXT_SELECTION_CONFLICT');
});

test('uses calibration only as the legacy global-baseline fallback', async (context) => {
  const root = await setup(context);
  const mapPath = join(root, 'docs/project-lifecycle/project-map.json');
  const legacy = JSON.parse(await readFile(mapPath, 'utf8'));
  delete legacy.knowledge_baseline;
  await writeFile(mapPath, `${JSON.stringify(legacy, null, 2)}\n`);

  const calibration = await selectContext({
    ...baseInput(root), knowledge_baseline: 'calibration:sample-project', task_delivery_refs: [],
  });
  const domainOnly = await selectContext({
    ...baseInput(root), knowledge_baseline: 'baseline-7', task_delivery_refs: [],
  });

  assert.equal(calibration.ok, true, JSON.stringify(calibration));
  assert.equal(calibration.value.stop.code, 'SUFFICIENT');
  assert.equal(domainOnly.ok, true, JSON.stringify(domainOnly));
  assert.equal(domainOnly.value.stop.code, 'NEEDS_EVIDENCE');
});

test('rejects unsafe context reference values with a stable diagnostic', async (context) => {
  const root = await setup(context);
  const unsafeCaller = await selectContext({
    ...baseInput(root), knowledge_baseline: 'global`baseline', task_delivery_refs: [],
  });
  assert.equal(unsafeCaller.ok, false);
  assert.equal(unsafeCaller.errors[0].code, 'CONTEXT_REFERENCE_INVALID');

  const mapPath = join(root, 'docs/project-lifecycle/project-map.json');
  const unsafe = JSON.parse(await readFile(mapPath, 'utf8'));
  unsafe.knowledge_baseline = 'global`baseline';
  await writeFile(mapPath, `${JSON.stringify(unsafe, null, 2)}\n`);

  const unsafeMap = await selectContext({
    ...baseInput(root), task_delivery_refs: [],
  });

  assert.equal(unsafeMap.ok, false);
  assert.equal(unsafeMap.errors[0].code, 'CONTEXT_REFERENCE_INVALID');
});

test('rejects a missing or stale constraint anchor before capability selection', async (context) => {
  const root = await setup(context);
  const path = join(root, 'docs/project-lifecycle/knowledge/desktop-experience/desktop-experience-en.md');
  await writeFile(path, capability('desktop-experience', 'desktop-experience.md').replace(
    '<a id="constraint-desktop-privacy"></a>',
    '<a id="constraint-renamed"></a>',
  ));
  const reads = [];

  const result = await selectContext({ ...baseInput(root), task_delivery_refs: [] }, { onRead: (entry) => reads.push(entry) });

  assert.equal(result.ok, false);
  assert.equal(result.errors[0].code, 'CONTEXT_CONSTRAINT_INVALID');
  assert.equal(reads.some(({ level }) => level === 'L2' || level === 'L3'), false);
});

test('rejects malformed or fenced-only L1 constraint sections before L2 reads', async (context) => {
  const corruptions = [
    (source) => source.replace('revision=3', 'revision=4'),
    (source) => source.replace(
      '<a id="constraint-desktop-privacy"></a>\n<!-- project-lifecycle:constraint id=desktop-privacy revision=3 -->',
      '<!-- project-lifecycle:constraint id=desktop-privacy revision=3 -->\n<a id="constraint-desktop-privacy"></a>',
    ),
    (source) => source.replace(
      'privacy\n<!-- /project-lifecycle:constraint -->',
      'privacy\n<!-- project-lifecycle:constraint id=desktop-privacy revision=3 -->\n<!-- /project-lifecycle:constraint -->',
    ),
    (source) => source.replace('<!-- /project-lifecycle:constraint -->', '<!-- missing-close -->'),
    (source) => source.replace(
      constraintBlocks('desktop-experience'),
      `\n\`\`\`md${constraintBlocks('desktop-experience')}\`\`\`\n`,
    ),
  ];
  for (const corrupt of corruptions) {
    const root = await setup(context);
    const path = join(root, 'docs/project-lifecycle/knowledge/desktop-experience/desktop-experience-en.md');
    await writeFile(path, corrupt(capability('desktop-experience', 'desktop-experience.md')));
    const reads = [];
    const result = await selectContext({ ...baseInput(root), task_delivery_refs: [] }, { onRead: (entry) => reads.push(entry) });
    assert.equal(result.ok, false);
    assert.equal(result.errors[0].code, 'CONTEXT_CONSTRAINT_INVALID');
    assert.equal(reads.some(({ level }) => level === 'L2' || level === 'L3'), false);
  }
});

test('stops bounded L1 reads after an early exact section and rejects cap overflow before completion', async (context) => {
  const earlyRoot = await setup(context);
  const earlyPath = join(earlyRoot, 'docs/project-lifecycle/knowledge/desktop-experience/desktop-experience-en.md');
  const earlySource = `${capability('desktop-experience', 'desktop-experience.md')}\n${'TAIL_MUST_NOT_BE_READ\n'.repeat(25_000)}`;
  await writeFile(earlyPath, earlySource);
  const earlyReads = [];
  const early = await selectContext({ ...baseInput(earlyRoot), task_delivery_refs: [] }, { onRead: (entry) => earlyReads.push(entry) });
  assert.equal(early.ok, true, JSON.stringify(early));
  assert.equal(earlyReads.filter(({ level }) => level === 'L1').every(({ bytes_read: bytesRead }) => bytesRead < Buffer.byteLength(earlySource)), true);

  const overflowRoot = await setup(context);
  const overflowPath = join(overflowRoot, 'docs/project-lifecycle/knowledge/desktop-experience/desktop-experience-en.md');
  const withoutConstraints = capability('desktop-experience', 'desktop-experience.md').replace(constraintBlocks('desktop-experience'), '');
  await writeFile(overflowPath, `${withoutConstraints}\n${'PREFIX\n'.repeat(12_000)}${constraintBlocks('desktop-experience')}`);
  const overflowReads = [];
  const overflow = await selectContext({ ...baseInput(overflowRoot), task_delivery_refs: [] }, { onRead: (entry) => overflowReads.push(entry) });
  assert.equal(overflow.ok, false);
  assert.equal(overflow.errors[0].code, 'CONTEXT_CONSTRAINT_INVALID');
  assert.equal(overflowReads.some(({ level }) => level === 'L2' || level === 'L3'), false);
});

test('treats immediate and distant post-close duplicate anchors identically at the selector trust boundary', async (context) => {
  const duplicate = '<a id="constraint-desktop-privacy"></a>\n<!-- project-lifecycle:constraint id=desktop-privacy revision=3 -->\nDuplicate.\n<!-- /project-lifecycle:constraint -->\n';
  const outcomes = [];
  for (const spacing of ['', 'UNREAD_TAIL\n'.repeat(1_000)]) {
    const root = await setup(context);
    const path = join(root, 'docs/project-lifecycle/knowledge/desktop-experience/desktop-experience-en.md');
    const original = capability('desktop-experience', 'desktop-experience.md');
    const closeNeedle = 'privacy\n<!-- /project-lifecycle:constraint -->';
    const closeEnd = Buffer.byteLength(original.slice(0, original.indexOf(closeNeedle) + closeNeedle.length));
    const padLength = (64 - ((closeEnd + 1) % 256) + 256) % 256;
    const padded = original.replace(
      '<a id="constraint-desktop-privacy"></a>',
      `${'P'.repeat(padLength)}\n<a id="constraint-desktop-privacy"></a>`,
    );
    await writeFile(path, padded.replace(closeNeedle, `${closeNeedle}\n${spacing}${duplicate}`));
    const reads = [];
    const result = await selectContext(
      { ...baseInput(root), task_delivery_refs: [] },
      { onRead: (entry) => reads.push(entry) },
    );
    outcomes.push({ ok: result.ok, stop: result.value?.stop.code, levels: reads.map(({ level }) => level) });
  }

  assert.deepEqual(outcomes, [
    { ok: true, stop: 'SUFFICIENT', levels: ['L0', 'L0', 'L0', 'L0', 'L1', 'L1', 'L2', 'L3'] },
    { ok: true, stop: 'SUFFICIENT', levels: ['L0', 'L0', 'L0', 'L0', 'L1', 'L1', 'L2', 'L3'] },
  ]);
});

test('reads every necessary index level for a three-level branch and no unrelated sibling index', async (context) => {
  const map = structuredClone(projectMap);
  map.domains.find(({ id }) => id === 'desktop-experience').scope.includes.push('editing');
  map.domains.find(({ id }) => id === 'desktop-experience').scope.includes.sort();
  const wiki = map.domains.find(({ id }) => id === 'wiki-workspace');
  wiki.scope.includes = ['editing', 'wiki'];
  wiki.paired_assets = {
    repository_id: null,
    en: 'knowledge/desktop-experience/wiki-workspace/wiki-workspace-en.md',
    'zh-CN': 'knowledge/desktop-experience/wiki-workspace/wiki-workspace.md',
  };
  map.domains.unshift({
    id: 'article-editor', kind: 'capability',
    label: { en: 'Article editor', 'zh-CN': '文章编辑器' },
    purpose: { en: 'Edits articles.', 'zh-CN': '编辑文章。' },
    domain_state: 'materialized', scope: { includes: ['editing'], excludes: [] },
    parent_id: 'wiki-workspace', relationships: [], evidence_refs: ['repo:src/editor'], known_gaps: [], baseline: 'baseline-7',
    paired_assets: {
      repository_id: null,
      en: 'knowledge/desktop-experience/wiki-workspace/article-editor-en.md',
      'zh-CN': 'knowledge/desktop-experience/wiki-workspace/article-editor.md',
    },
  });
  const root = await setup(context, map);
  const reads = [];
  const result = await selectContext({
    ...baseInput(root), primary_domain_id: 'article-editor', candidate_domain_ids: ['article-editor'],
    applicable_relationships: [], task_delivery_refs: [],
  }, { onRead: (entry) => reads.push(entry) });

  assert.equal(result.ok, true, JSON.stringify(result));
  assert.deepEqual(reads.filter(({ section }) => section === 'navigation-index').map(({ locator }) => locator), [
    'INDEX-en.md',
    'knowledge/INDEX-en.md',
    'knowledge/desktop-experience/INDEX-en.md',
    'knowledge/desktop-experience/wiki-workspace/INDEX-en.md',
  ]);
  assert.equal(reads.some(({ locator }) => locator.includes('unrelated-workspace/INDEX')), false);
});

test('requires explicit v1 migration before any index or knowledge body read', async (context) => {
  const root = await setup(context);
  const path = join(root, 'docs/project-lifecycle/project-map.json');
  const legacy = JSON.parse(await readFile(path, 'utf8'));
  legacy.schema_version = 1;
  await writeFile(path, `${JSON.stringify(legacy, null, 2)}\n`);
  const reads = [];

  const result = await selectContext(baseInput(root), { onRead: (entry) => reads.push(entry) });

  assert.equal(result.ok, false);
  assert.equal(result.errors[0].code, 'CONTEXT_LAYOUT_MIGRATION_REQUIRED');
  assert.deepEqual(reads, [{ level: 'L0', locator: 'project-map.json', section: 'document' }]);
});

test('continues bounded routing after the agent enters the authenticated owning shard', async (context) => {
  const repositoryId = 'backend';
  const map = structuredClone(projectMap);
  map.constraints = [];
  map.domains = [map.domains.find(({ id }) => id === 'wiki-workspace')];
  map.domains[0].parent_id = null;
  map.domains[0].relationships = [];
  map.domains[0].paired_assets = {
    repository_id: repositoryId,
    en: 'knowledge/wiki-workspace-en.md',
    'zh-CN': 'knowledge/wiki-workspace.md',
  };
  map.repositories = [{
    id: repositoryId,
    purpose: { en: 'Owns backend knowledge.', 'zh-CN': '负责后端知识。' },
    portable_locator: 'github:example/backend', integration_ref: 'refs/heads/main',
    domain_ids: ['wiki-workspace'],
    knowledge_asset_locators: ['knowledge/wiki-workspace-en.md', 'knowledge/wiki-workspace.md'],
    accepted_revision: 'revision:backend',
  }];
  const root = await mkdtemp(join(tmpdir(), 'project-lifecycle-context-shard-'));
  context.after(() => rm(root, { recursive: true, force: true }));
  const lifecycle = join(root, 'docs/project-lifecycle');
  await mkdir(join(lifecycle, 'knowledge'), { recursive: true });
  await writeFile(join(lifecycle, 'knowledge/wiki-workspace-en.md'), capability('wiki-workspace', 'wiki-workspace.md'));
  await writeFile(join(lifecycle, 'knowledge/wiki-workspace.md'), capability('wiki-workspace', 'wiki-workspace.md'));
  const indexes = await generateIndexesFromRoot({ map, lifecycleRoot: lifecycle, repository_id: repositoryId });
  assert.equal(indexes.ok, true, JSON.stringify(indexes));
  for (const file of indexes.value.files) {
    await mkdir(dirname(join(lifecycle, file.locator)), { recursive: true });
    await writeFile(join(lifecycle, file.locator), file.content);
  }

  const result = await selectContext({
    ...baseInput(root), primary_domain_id: 'wiki-workspace', candidate_domain_ids: ['wiki-workspace'],
    applicable_relationships: [], task_delivery_refs: [],
  }, { governanceMap: map, currentRepositoryId: repositoryId });

  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.value.stop.code, 'SUFFICIENT');
  assert.deepEqual(result.value.selected_context.map(({ id }) => id), ['wiki-workspace']);
});

test('converges a selection spanning two authenticated repository shards', async (context) => {
  const map = structuredClone(projectMap);
  map.constraints = [];
  map.domains = [
    map.domains.find(({ id }) => id === 'wiki-workspace'),
    map.domains.find(({ id }) => id === 'unrelated-workspace'),
  ];
  for (const domain of map.domains) {
    domain.parent_id = null;
    domain.relationships = [];
    domain.paired_assets = {
      repository_id: domain.id === 'wiki-workspace' ? 'backend' : 'frontend',
      en: `knowledge/${domain.id}-en.md`,
      'zh-CN': `knowledge/${domain.id}.md`,
    };
  }
  map.domains[0].relationships = [{ kind: 'depends_on', target_id: 'unrelated-workspace' }];
  map.domains.sort((left, right) => left.id < right.id ? -1 : left.id > right.id ? 1 : 0);
  map.repositories = ['backend', 'frontend'].map((id) => ({
    id, purpose: { en: `Owns ${id}.`, 'zh-CN': `负责 ${id}。` },
    portable_locator: `github:example/${id}`, integration_ref: 'refs/heads/main',
    domain_ids: [id === 'backend' ? 'wiki-workspace' : 'unrelated-workspace'],
    knowledge_asset_locators: [], accepted_revision: `revision:${id}`,
  }));
  const roots = {};
  for (const repositoryId of ['backend', 'frontend']) {
    const root = await mkdtemp(join(tmpdir(), `project-lifecycle-context-${repositoryId}-`));
    context.after(() => rm(root, { recursive: true, force: true }));
    const lifecycleRoot = join(root, 'docs/project-lifecycle');
    await mkdir(join(lifecycleRoot, 'knowledge'), { recursive: true });
    const domain = map.domains.find(({ paired_assets: pair }) => pair.repository_id === repositoryId);
    await writeFile(join(lifecycleRoot, domain.paired_assets.en), capability(domain.id, `${domain.id}.md`));
    await writeFile(join(lifecycleRoot, domain.paired_assets['zh-CN']), capability(domain.id, `${domain.id}.md`));
    const generated = await generateIndexesFromRoot({ map, lifecycleRoot, repository_id: repositoryId });
    assert.equal(generated.ok, true, JSON.stringify(generated));
    for (const file of generated.value.files) {
      await mkdir(dirname(join(lifecycleRoot, file.locator)), { recursive: true });
      await writeFile(join(lifecycleRoot, file.locator), file.content);
    }
    roots[repositoryId] = root;
  }

  const result = await selectContext({
    ...baseInput(roots.backend), primary_domain_id: 'wiki-workspace', candidate_domain_ids: ['wiki-workspace'],
    applicable_relationships: [{ source_id: 'wiki-workspace', kind: 'depends_on', target_id: 'unrelated-workspace' }],
    task_delivery_refs: [],
  }, {
    governanceMap: map,
    currentRepositoryId: 'backend',
    repositoryRoots: { frontend: roots.frontend },
  });

  assert.equal(result.ok, true, JSON.stringify(result));
  assert.deepEqual(result.value.selected_context.map(({ id }) => id), ['unrelated-workspace', 'wiki-workspace']);
});

test('accepts CRLF and reordered Frontmatter keys without reading the body', async (context) => {
  const root = await setup(context);
  const path = join(root, 'docs/project-lifecycle/knowledge/desktop-experience/wiki-workspace-en.md');
  const reordered = `---\nverification_refs:\n  - repo:test/wiki-workspace\nimplementation_refs:\n  - repo:src/wiki-workspace\nlast_verified_baseline: baseline-7\npaired_asset: wiki-workspace.md\nknowledge_state: current\nid: wiki-workspace\n---\n\n# BODY MUST STAY UNREAD\n`.replaceAll('\n', '\r\n');
  await writeFile(path, reordered);
  const result = await selectContext({ ...baseInput(root), candidate_domain_ids: ['wiki-workspace'], applicable_relationships: [], task_delivery_refs: [] });
  assert.equal(result.ok, true, JSON.stringify(result));
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
