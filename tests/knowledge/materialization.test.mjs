import assert from 'node:assert/strict';
import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  readlink,
  rename,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import { parse as parseYaml } from 'yaml';

import { bootstrap } from '../../scripts/knowledge/bootstrap.mjs';
import { materializeCapability } from '../../scripts/knowledge/materialize.mjs';
import { selectContext } from '../../scripts/knowledge/select-context.mjs';
import { validateBilingualPair } from '../../scripts/lib/bilingual-pair.mjs';
import { atomicWriteValidated } from '../../scripts/lib/atomic-write.mjs';
import { parseFrontmatter } from '../../scripts/lib/markdown.mjs';

const fixturePath = fileURLToPath(new URL(
  '../fixtures/knowledge/materialization/valid-input.json',
  import.meta.url,
));
const englishTemplatePath = fileURLToPath(new URL(
  '../../skills/maintain-project-knowledge/assets/capability-en.md',
  import.meta.url,
));
const chineseTemplatePath = fileURLToPath(new URL(
  '../../skills/maintain-project-knowledge/assets/capability.md',
  import.meta.url,
));
const materializationReferenceUrl = new URL(
  '../../skills/maintain-project-knowledge/references/materialization.md',
  import.meta.url,
);

const readJson = async (path) => JSON.parse(await readFile(path, 'utf8'));
const clone = (value) => JSON.parse(JSON.stringify(value));

const createProject = async (context) => {
  const root = await mkdtemp(join(tmpdir(), 'project-lifecycle-materialization-'));
  context.after(() => rm(root, { recursive: true, force: true }));
  const result = await bootstrap({
    root,
    project_id: 'sample-application',
    label: { en: 'Sample Application', 'zh-CN': '示例应用' },
    purpose: { en: 'Exercises materialization.', 'zh-CN': '用于测试知识物化。' },
    calibration_ref: 'calibration:initial-user-approval',
    calibration_approved: true,
    domains: [
      {
        id: 'app-shell',
        kind: 'domain',
        label: { en: 'Application shell', 'zh-CN': '应用外壳' },
        purpose: { en: 'Owns application chrome.', 'zh-CN': '负责应用框架。' },
        domain_state: 'confirmed',
        scope: { includes: ['application chrome'], excludes: [] },
        parent_id: null,
        relationships: [],
        evidence_refs: ['repo:src/shell'],
        known_gaps: ['No materialized shell knowledge yet.'],
      },
      {
        id: 'wiki-workspace',
        kind: 'capability',
        label: { en: 'Wiki workspace', 'zh-CN': 'Wiki 工作区' },
        purpose: { en: 'Owns Wiki interactions.', 'zh-CN': '负责 Wiki 交互。' },
        domain_state: 'confirmed',
        scope: { includes: ['wiki interaction'], excludes: [] },
        parent_id: null,
        relationships: [{ kind: 'depends_on', target_id: 'app-shell' }],
        evidence_refs: ['repo:src/wiki'],
        known_gaps: ['Small-window behavior is not verified.'],
      },
    ],
  });
  assert.equal(result.ok, true);
  return { root, lifecycleRoot: join(root, 'docs', 'project-lifecycle') };
};

const validInput = async (root) => ({ root, ...clone(await readJson(fixturePath)) });

const appShellInput = async (root) => {
  const input = await validInput(root);
  input.domain_id = 'app-shell';
  input.owner_id = 'app-shell';
  input.baseline = 'baseline-alpha';
  input.approval_ref = 'approval:alpha';
  input.dependency_ids = [];
  input.authoritative_evidence_refs = ['repo:src/shell', 'test:shell'];
  input.implementation_refs = ['repo:src/shell'];
  input.verification_refs = ['test:shell'];
  input.targets = {
    en: 'knowledge/app-shell-en.md',
    'zh-CN': 'knowledge/app-shell.md',
  };
  for (const language of ['en', 'zh-CN']) {
    input.pair[language].facts[0].fact_id = 'fact-app-shell';
    input.pair[language].facts[0].evidence_refs = ['repo:src/shell', 'test:shell'];
  }
  return input;
};

const treeSnapshot = async (root, prefix = '') => {
  const entries = await readdir(join(root, prefix), { withFileTypes: true });
  const output = [];
  for (const entry of entries.sort((left, right) => left.name < right.name ? -1 : left.name > right.name ? 1 : 0)) {
    const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      output.push({ path: `${relative}/`, type: 'directory' });
      output.push(...await treeSnapshot(root, relative));
    } else if (entry.isSymbolicLink()) {
      output.push({ path: relative, type: 'symlink', target: await readlink(join(root, relative)) });
    } else {
      output.push({
        path: relative,
        type: 'file',
        bytes: (await readFile(join(root, relative))).toString('base64'),
      });
    }
  }
  return output;
};

const listTree = async (root) => (await treeSnapshot(root)).map(({ path }) => path);

const assertRejectedWithoutMutation = async (context, mutate, expectedCode) => {
  const project = await createProject(context);
  const input = await validInput(project.root);
  await mutate({ input, ...project });
  const before = await treeSnapshot(project.lifecycleRoot);

  const result = await materializeCapability(input);

  assert.equal(result.ok, false);
  assert.equal(result.errors[0].code, expectedCode);
  assert.deepEqual(await treeSnapshot(project.lifecycleRoot), before);
};

test('publishes repository-owned materialization before the governance map', async (context) => {
  const project = await createProject(context);
  const shardRoot = await mkdtemp(join(tmpdir(), 'project-lifecycle-materialization-shard-'));
  context.after(() => rm(shardRoot, { recursive: true, force: true }));
  await mkdir(join(shardRoot, 'docs/project-lifecycle/knowledge'), { recursive: true });
  const mapPath = join(project.lifecycleRoot, 'project-map.json');
  const map = await readJson(mapPath);
  map.repositories = [{
    id: 'backend', purpose: { en: 'Owns backend.', 'zh-CN': '负责后端。' },
    portable_locator: 'github:example/backend', integration_ref: 'refs/heads/main',
    domain_ids: ['wiki-workspace'], knowledge_asset_locators: [], accepted_revision: 'revision:backend',
  }];
  await writeFile(mapPath, `${JSON.stringify(map, null, 2)}\n`);
  const input = await validInput(project.root);
  input.repository_roots = { backend: shardRoot };
  const order = [];

  const result = await materializeCapability(input, {
    afterRepositoryPublish: ({ repository_id: repositoryId }) => order.push(repositoryId),
  });

  assert.equal(result.ok, true, JSON.stringify(result));
  assert.deepEqual(order, ['backend', null]);
  assert.equal(await readFile(join(shardRoot, 'docs/project-lifecycle/knowledge/wiki-workspace-en.md'), 'utf8')
    .then(() => true, () => false), true);
  assert.equal(await readFile(join(project.lifecycleRoot, 'knowledge/wiki-workspace-en.md'), 'utf8')
    .then(() => true, () => false), false);
  const publishedMap = await readJson(mapPath);
  assert.equal(publishedMap.domains.find(({ id }) => id === 'wiki-workspace').paired_assets.repository_id, 'backend');
});

test('capability templates expose only six Frontmatter fields and exactly eight canonical sections', async () => {
  const expectedFields = [
    'id',
    'knowledge_state',
    'paired_asset',
    'last_verified_baseline',
    'implementation_refs',
    'verification_refs',
  ];
  const expectedEnglish = [
    'Purpose and current boundary',
    'Current facts',
    'System and data relationships',
    'Implementation and resource map',
    'Quality state',
    'Dependencies',
    'Known limits and unknowns',
    'Provenance',
  ];
  const expectedChinese = [
    '用途与当前边界',
    '当前事实',
    '系统与数据关系',
    '实现与资源地图',
    '质量状态',
    '依赖',
    '已知限制与未知项',
    '来源',
  ];

  for (const [path, expectedSections] of [
    [englishTemplatePath, expectedEnglish],
    [chineseTemplatePath, expectedChinese],
  ]) {
    const source = await readFile(path, 'utf8');
    const parsed = parseFrontmatter(source);
    assert.equal(parsed.ok, true);
    assert.deepEqual(Object.keys(parsed.value.data), expectedFields);
    assert.deepEqual(
      [...parsed.value.body.matchAll(/^## ([^\n]+)$/gm)].map((match) => match[1]),
      expectedSections,
    );
    assert.equal(/product.*architecture.*development.*test/is.test(source), false);
  }
});

test('requires all semantic content quality gates before current promotion', async () => {
  const reference = await readFile(materializationReferenceUrl, 'utf8');
  const contract = reference.match(/<!-- semantic-content-quality-contract\n([\s\S]*?)\n-->/)?.[1];

  assert.ok(contract, 'materialization must expose its semantic quality contract');
  assert.deepEqual(parseYaml(contract), {
    promotion: 'all-required',
    aggregation: 'non-numeric',
    on_failure: 'absent-or-non-current',
    user_risk_acceptance_overrides_truth: false,
    gates: [
      'BOUNDARY_CLARITY',
      'DURABLE_FACT_COVERAGE',
      'EVIDENCE_QUALITY',
      'RELATIONSHIP_CLARITY',
      'EXTENSION_READINESS',
      'CONCISION',
    ],
  });
});

test('materializes exactly one bilingual pair, map update, and regenerated paired indexes', async (context) => {
  const { root, lifecycleRoot } = await createProject(context);
  const originalMap = await readJson(join(lifecycleRoot, 'project-map.json'));
  const result = await materializeCapability(await validInput(root));

  assert.deepEqual(result, {
    ok: true,
    value: {
      baseline: 'baseline-2026-08-09',
      domain_id: 'wiki-workspace',
      knowledge_state: 'current',
      status: 'materialized',
      cleanup_state: 'complete',
    },
    errors: [],
  });
  assert.deepEqual(await listTree(lifecycleRoot), [
    'INDEX-en.md',
    'INDEX.md',
    'delivery/',
    'knowledge/',
    'knowledge/INDEX-en.md',
    'knowledge/INDEX.md',
    'knowledge/wiki-workspace-en.md',
    'knowledge/wiki-workspace.md',
    'pending-changes.json',
    'project-map.json',
  ]);

  const map = await readJson(join(lifecycleRoot, 'project-map.json'));
  const node = map.domains.find(({ id }) => id === 'wiki-workspace');
  assert.equal(map.project_id, originalMap.project_id);
  assert.deepEqual(map.project_identity, originalMap.project_identity);
  assert.equal(originalMap.knowledge_baseline, 'calibration:initial-user-approval');
  assert.equal(map.knowledge_baseline, 'baseline-2026-08-09');
  assert.equal(node.domain_state, 'materialized');
  assert.equal(node.baseline, 'baseline-2026-08-09');
  assert.deepEqual(node.paired_assets, {
    repository_id: null,
    en: 'knowledge/wiki-workspace-en.md',
    'zh-CN': 'knowledge/wiki-workspace.md',
  });
  const pairResult = await validateBilingualPair(
    join(lifecycleRoot, node.paired_assets.en),
    join(lifecycleRoot, node.paired_assets['zh-CN']),
    map,
  );
  assert.deepEqual(pairResult, { ok: true, value: { fact_ids: ['fact-wiki-layout'] }, errors: [] });
  const englishIndex = await readFile(join(lifecycleRoot, 'INDEX-en.md'), 'utf8');
  const chineseIndex = await readFile(join(lifecycleRoot, 'INDEX.md'), 'utf8');
  const englishKnowledgeIndex = await readFile(join(lifecycleRoot, 'knowledge/INDEX-en.md'), 'utf8');
  const chineseKnowledgeIndex = await readFile(join(lifecycleRoot, 'knowledge/INDEX.md'), 'utf8');
  const englishDocument = await readFile(join(lifecycleRoot, node.paired_assets.en), 'utf8');
  const chineseDocument = await readFile(join(lifecycleRoot, node.paired_assets['zh-CN']), 'utf8');
  assert.equal(englishKnowledgeIndex.includes('[`domain:wiki-workspace`](wiki-workspace-en.md)'), true);
  assert.equal(chineseKnowledgeIndex.includes('[`domain:wiki-workspace`](wiki-workspace.md)'), true);
  assert.equal(englishIndex.includes('approval:user-current-wiki'), false);
  assert.equal(chineseIndex.includes('approval:user-current-wiki'), false);
  for (const value of ['Sample Application', '示例应用', 'calibration:initial-user-approval']) {
    assert.equal(`${englishIndex}\n${chineseIndex}`.includes(value), true);
  }
  assert.equal(englishDocument.includes('Canonical owner: `wiki-workspace`'), true);
  assert.equal(chineseDocument.includes('规范所有者：`wiki-workspace`'), true);
  assert.equal(englishDocument.includes('Declared dependency: `app-shell`'), true);
  assert.equal(chineseDocument.includes('已声明依赖：`app-shell`'), true);
  const englishRelationships = englishDocument.match(
    /## System and data relationships\n\n([\s\S]*?)\n\n## Implementation and resource map/u,
  )?.[1];
  const englishDependencies = englishDocument.match(
    /## Dependencies\n\n([\s\S]*?)\n\n## Known limits and unknowns/u,
  )?.[1];
  const chineseRelationships = chineseDocument.match(
    /## 系统与数据关系\n\n([\s\S]*?)\n\n## 实现与资源地图/u,
  )?.[1];
  const chineseDependencies = chineseDocument.match(
    /## 依赖\n\n([\s\S]*?)\n\n## 已知限制与未知项/u,
  )?.[1];
  assert.doesNotMatch(englishRelationships, /Canonical owner:/u);
  assert.match(englishDependencies, /Canonical owner: `wiki-workspace`/u);
  assert.doesNotMatch(chineseRelationships, /规范所有者：/u);
  assert.match(chineseDependencies, /规范所有者：`wiki-workspace`/u);
  assert.equal(englishDocument.includes('Approval: `approval:user-current-wiki`'), true);
  assert.equal(chineseDocument.includes('批准依据：`approval:user-current-wiki`'), true);
});

test('materializes recursive leaves and parents without fabricating ancestor knowledge', async (context) => {
  const root = await mkdtemp(join(tmpdir(), 'project-lifecycle-recursive-materialization-'));
  context.after(() => rm(root, { recursive: true, force: true }));
  const makeDomain = (id, parentId, includes) => ({
    id,
    kind: 'capability',
    label: { en: id, 'zh-CN': id },
    purpose: { en: `Owns ${id}.`, 'zh-CN': `负责 ${id}。` },
    domain_state: 'confirmed',
    scope: { includes, excludes: [] },
    parent_id: parentId,
    relationships: [],
    evidence_refs: [`repo:${id}`],
    known_gaps: [`No materialized ${id} knowledge yet.`],
  });
  const bootstrapped = await bootstrap({
    root,
    project_id: 'recursive-project',
    label: { en: 'Recursive project', 'zh-CN': '递归项目' },
    purpose: { en: 'Exercises recursive materialization.', 'zh-CN': '用于测试递归知识物化。' },
    calibration_ref: 'calibration:recursive',
    calibration_approved: true,
    domains: [
      makeDomain('loop', 'runtime', ['loop', 'tools']),
      makeDomain('runtime', null, ['loop', 'runtime', 'tools']),
      makeDomain('tools', 'loop', ['tools']),
    ],
  });
  assert.equal(bootstrapped.ok, true, JSON.stringify(bootstrapped));
  const lifecycleRoot = join(root, 'docs/project-lifecycle');
  const materializationInput = async (id, targets, baseline) => {
    const input = await validInput(root);
    input.domain_id = id;
    input.owner_id = id;
    input.targets = targets;
    input.baseline = baseline;
    input.approval_ref = `approval:${id}`;
    input.dependency_ids = [];
    input.authoritative_evidence_refs = [`repo:${id}`, `test:${id}`];
    input.implementation_refs = [`repo:${id}`];
    input.verification_refs = [`test:${id}`];
    for (const language of ['en', 'zh-CN']) {
      input.pair[language].facts[0].fact_id = `fact-${id}`;
      input.pair[language].facts[0].evidence_refs = [`repo:${id}`, `test:${id}`];
    }
    return input;
  };

  const tools = await materializeCapability(await materializationInput('tools', {
    en: 'knowledge/runtime/loop/tools-en.md',
    'zh-CN': 'knowledge/runtime/loop/tools.md',
  }, 'baseline:tools'));
  assert.equal(tools.ok, true, JSON.stringify(tools));
  let map = await readJson(join(lifecycleRoot, 'project-map.json'));
  assert.deepEqual(map.domains.find(({ id }) => id === 'tools').paired_assets, {
    repository_id: null,
    en: 'knowledge/runtime/loop/tools-en.md',
    'zh-CN': 'knowledge/runtime/loop/tools.md',
  });
  assert.equal(await lstat(join(lifecycleRoot, 'knowledge/runtime')).then((state) => state.isDirectory()), true);
  await assert.rejects(lstat(join(lifecycleRoot, 'knowledge/runtime/runtime-en.md')), { code: 'ENOENT' });
  await assert.rejects(lstat(join(lifecycleRoot, 'knowledge/runtime/loop/loop-en.md')), { code: 'ENOENT' });

  const runtime = await materializeCapability(await materializationInput('runtime', {
    en: 'knowledge/runtime/runtime-en.md',
    'zh-CN': 'knowledge/runtime/runtime.md',
  }, 'baseline:runtime'));
  assert.equal(runtime.ok, true, JSON.stringify(runtime));
  const loop = await materializeCapability(await materializationInput('loop', {
    en: 'knowledge/runtime/loop/loop-en.md',
    'zh-CN': 'knowledge/runtime/loop/loop.md',
  }, 'baseline:loop'));
  assert.equal(loop.ok, true, JSON.stringify(loop));

  map = await readJson(join(lifecycleRoot, 'project-map.json'));
  assert.equal(map.domains.every(({ domain_state: state }) => state === 'materialized'), true);
  const knowledgeIndex = await readFile(join(lifecycleRoot, 'knowledge/INDEX-en.md'), 'utf8');
  const runtimeIndex = await readFile(join(lifecycleRoot, 'knowledge/runtime/INDEX-en.md'), 'utf8');
  const loopIndex = await readFile(join(lifecycleRoot, 'knowledge/runtime/loop/INDEX-en.md'), 'utf8');
  assert.match(knowledgeIndex, /domain:runtime/);
  assert.doesNotMatch(knowledgeIndex, /domain:loop|domain:tools/);
  assert.match(runtimeIndex, /domain:loop/);
  assert.doesNotMatch(runtimeIndex, /domain:tools/);
  assert.match(loopIndex, /domain:tools/);
});

test('preserves an unrelated relative symlink during a successful root swap', async (context) => {
  const { root, lifecycleRoot } = await createProject(context);
  await writeFile(join(lifecycleRoot, 'unrelated-target.md'), 'unrelated\n');
  await symlink('unrelated-target.md', join(lifecycleRoot, 'unrelated-link.md'));

  const result = await materializeCapability(await validInput(root));

  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(await readlink(join(lifecycleRoot, 'unrelated-link.md')), 'unrelated-target.md');
});

test('keeps a valid proposed pair proposed without requiring approval', async (context) => {
  const { root, lifecycleRoot } = await createProject(context);
  const input = await validInput(root);
  input.knowledge_state = 'proposed';
  delete input.approval_ref;

  const result = await materializeCapability(input);

  assert.equal(result.ok, true);
  assert.equal(result.value.knowledge_state, 'proposed');
  for (const name of ['wiki-workspace-en.md', 'wiki-workspace.md']) {
    const frontmatter = parseFrontmatter(await readFile(join(lifecycleRoot, 'knowledge', name), 'utf8'));
    assert.equal(frontmatter.ok, true);
    assert.equal(frontmatter.value.data.knowledge_state, 'proposed');
  }
});

test('preserves the accepted alpha baseline when a later beta capability is only proposed', async (context) => {
  const { root, lifecycleRoot } = await createProject(context);
  assert.equal((await materializeCapability(await appShellInput(root))).ok, true);
  const beta = await validInput(root);
  beta.baseline = 'baseline-beta';
  beta.knowledge_state = 'proposed';
  delete beta.approval_ref;

  const proposed = await materializeCapability(beta);
  const map = await readJson(join(lifecycleRoot, 'project-map.json'));
  const index = await readFile(join(lifecycleRoot, 'INDEX-en.md'), 'utf8');
  const knowledgeIndex = await readFile(join(lifecycleRoot, 'knowledge/INDEX-en.md'), 'utf8');
  const selection = await selectContext({
    root,
    knowledge_baseline: 'baseline-alpha',
    primary_domain_id: 'app-shell',
    candidate_domain_ids: ['app-shell'],
    applicable_relationships: [],
    task_delivery_refs: [],
    material_exclusions: [],
    evidence_gaps: [],
    open_questions: [],
    conflicts: [],
  });
  const proposedSelection = await selectContext({
    root,
    knowledge_baseline: 'baseline-alpha',
    primary_domain_id: 'wiki-workspace',
    candidate_domain_ids: ['app-shell', 'wiki-workspace'],
    applicable_relationships: [{
      source_id: 'wiki-workspace', kind: 'depends_on', target_id: 'app-shell',
    }],
    task_delivery_refs: [],
    material_exclusions: [],
    evidence_gaps: [],
    open_questions: [],
    conflicts: [],
  });

  assert.equal(proposed.ok, true, JSON.stringify(proposed));
  assert.equal(map.knowledge_baseline, 'baseline-alpha');
  assert.equal(map.domains.find(({ id }) => id === 'wiki-workspace').baseline, 'baseline-beta');
  assert.match(index, /## Project baseline\n\n- `baseline-alpha`/u);
  assert.match(knowledgeIndex, /domain:wiki-workspace[^\n]*knowledge: `proposed`/u);
  assert.equal(selection.ok, true, JSON.stringify(selection));
  assert.equal(selection.value.stop.code, 'SUFFICIENT');
  assert.equal(proposedSelection.ok, true, JSON.stringify(proposedSelection));
  assert.equal(proposedSelection.value.stop.code, 'NEEDS_EVIDENCE');
  assert.equal(proposedSelection.value.knowledge_baseline, 'baseline-alpha');
  assert.equal(proposedSelection.value.selected_context.some(({ id, version_ref: versionRef }) => (
    id === 'wiki-workspace' && versionRef.endsWith('@baseline-beta')
  )), true);
});

test('rejects duplicate governed anchors injected into a Task 3 candidate before publication', async (context) => {
  const project = await createProject(context);
  const mapPath = join(project.lifecycleRoot, 'project-map.json');
  const map = await readJson(mapPath);
  map.constraints.push({
    id: 'wiki-privacy',
    scope: 'self',
    owner_id: 'wiki-workspace',
    semantic_revision: 1,
    lifecycle_state: 'current',
    knowledge_refs: {
      en: 'knowledge/wiki-workspace-en.md#constraint-wiki-privacy',
      'zh-CN': 'knowledge/wiki-workspace.md#constraint-wiki-privacy',
    },
    exceptions: [],
  });
  await writeFile(mapPath, `${JSON.stringify(map, null, 2)}\n`);
  const before = await treeSnapshot(project.lifecycleRoot);
  const block = '\n<a id="constraint-wiki-privacy"></a>\n<!-- project-lifecycle:constraint id=wiki-privacy revision=1 -->\nPrivacy.\n<!-- /project-lifecycle:constraint -->\n';

  const result = await materializeCapability(await validInput(project.root), {
    atomicWriteValidated: async (options) => {
      const written = await atomicWriteValidated(options);
      if (['knowledge/wiki-workspace-en.md', 'knowledge/wiki-workspace.md'].includes(options.target)) {
        const target = join(options.root, options.target);
        await writeFile(target, `${await readFile(target, 'utf8')}${block}${block}`);
      }
      return written;
    },
  });

  assert.equal(result.ok, false);
  assert.equal(result.errors[0].code, 'MATERIALIZATION_WRITE_FAILED');
  assert.deepEqual(await treeSnapshot(project.lifecycleRoot), before);
});

test('keeps the advanced global baseline byte-identical on an identical materialization retry', async (context) => {
  const { root, lifecycleRoot } = await createProject(context);
  const input = await validInput(root);
  assert.equal((await materializeCapability(input)).ok, true);
  const before = await treeSnapshot(lifecycleRoot);

  const retry = await materializeCapability(input);

  assert.equal(retry.ok, false);
  assert.equal(retry.errors[0].code, 'MATERIALIZATION_NODE_NOT_CONFIRMED');
  assert.equal((await readJson(join(lifecycleRoot, 'project-map.json'))).knowledge_baseline, input.baseline);
  assert.deepEqual(await treeSnapshot(lifecycleRoot), before);
});

for (const entry of [
  {
    name: 'rejects an unconfirmed node',
    code: 'MATERIALIZATION_NODE_NOT_CONFIRMED',
    mutate: async ({ lifecycleRoot }) => {
      const path = join(lifecycleRoot, 'project-map.json');
      const map = await readJson(path);
      const node = map.domains.find(({ id }) => id === 'wiki-workspace');
      node.domain_state = 'retired';
      node.retirement_reason = 'No longer active.';
      await writeFile(path, `${JSON.stringify(map, null, 2)}\n`);
    },
  },
  {
    name: 'rejects a pair without a durable fact',
    code: 'MATERIALIZATION_FACT_REQUIRED',
    mutate: async ({ input }) => {
      input.pair.en.facts = [];
      input.pair['zh-CN'].facts = [];
    },
  },
  {
    name: 'rejects a fact without authoritative evidence',
    code: 'MATERIALIZATION_EVIDENCE_REQUIRED',
    mutate: async ({ input }) => { input.pair.en.facts[0].evidence_refs = []; },
  },
  {
    name: 'rejects an unknown canonical owner',
    code: 'REFERENCE_MISSING',
    mutate: async ({ input }) => { input.owner_id = 'missing-owner'; },
  },
  {
    name: 'rejects a known cross-domain canonical owner',
    code: 'MATERIALIZATION_OWNER_MISMATCH',
    mutate: async ({ input }) => { input.owner_id = 'app-shell'; },
  },
  {
    name: 'rejects an omitted declared dependency',
    code: 'MATERIALIZATION_DEPENDENCY_MISSING',
    mutate: async ({ input }) => { input.dependency_ids = []; },
  },
  {
    name: 'rejects a fact with omitted known limits',
    code: 'FACT_BLOCK_MALFORMED',
    mutate: async ({ input }) => { delete input.pair.en.facts[0].known_limits; },
  },
  {
    name: 'rejects a one-language candidate',
    code: 'MATERIALIZATION_PAIR_REQUIRED',
    mutate: async ({ input }) => { delete input.pair['zh-CN']; },
  },
  {
    name: 'rejects mismatched bilingual fact identifiers',
    code: 'PAIR_MACHINE_MISMATCH',
    mutate: async ({ input }) => { input.pair['zh-CN'].facts[0].fact_id = 'fact-other-layout'; },
  },
  {
    name: 'requires explicit approval for new current truth',
    code: 'MATERIALIZATION_APPROVAL_REQUIRED',
    mutate: async ({ input }) => { delete input.approval_ref; },
  },
  {
    name: 'rejects parent traversal in a target',
    code: 'PATH_ESCAPE',
    mutate: async ({ input }) => { input.targets.en = '../wiki-workspace-en.md'; },
  },
  {
    name: 'rejects duplicate bilingual targets',
    code: 'MATERIALIZATION_TARGET_DUPLICATE',
    mutate: async ({ input }) => { input.targets['zh-CN'] = input.targets.en; },
  },
  {
    name: 'rejects an incomplete baseline',
    code: 'MATERIALIZATION_INPUT_INVALID',
    mutate: async ({ input }) => { input.baseline = ''; },
  },
  {
    name: 'rejects a current entry point outside the authoritative evidence set',
    code: 'MATERIALIZATION_EVIDENCE_REQUIRED',
    mutate: async ({ input }) => { input.implementation_refs = ['repo:src/missing']; },
  },
  {
    name: 'rejects current truth without verification references',
    code: 'MATERIALIZATION_EVIDENCE_REQUIRED',
    mutate: async ({ input }) => { input.verification_refs = []; },
  },
]) {
  test(entry.name, async (context) => {
    await assertRejectedWithoutMutation(context, entry.mutate, entry.code);
  });
}

test('rejects a target locator already owned by another materialized node', async (context) => {
  const project = await createProject(context);
  const input = await validInput(project.root);
  const mapPath = join(project.lifecycleRoot, 'project-map.json');
  const map = await readJson(mapPath);
  const otherNode = map.domains.find(({ id }) => id === 'app-shell');
  otherNode.domain_state = 'materialized';
  otherNode.paired_assets = { repository_id: null, ...clone(input.targets) };
  otherNode.baseline = 'existing-baseline';
  await writeFile(mapPath, `${JSON.stringify(map, null, 2)}\n`);
  const before = await treeSnapshot(project.lifecycleRoot);

  const result = await materializeCapability(input);

  assert.equal(result.ok, false);
  assert.equal(result.errors[0].code, 'MATERIALIZATION_TARGET_DUPLICATE');
  assert.deepEqual(await treeSnapshot(project.lifecycleRoot), before);
});

test('rejects an unowned existing regular target instead of overwriting it', async (context) => {
  const project = await createProject(context);
  const input = await validInput(project.root);
  await writeFile(join(project.lifecycleRoot, input.targets.en), 'orphan bytes\n');
  const before = await treeSnapshot(project.lifecycleRoot);

  const result = await materializeCapability(input);

  assert.equal(result.ok, false);
  assert.equal(result.errors[0].code, 'MATERIALIZATION_TARGET_DUPLICATE');
  assert.deepEqual(await treeSnapshot(project.lifecycleRoot), before);
});

test('rejects a symlinked target and leaves the root byte-identical', async (context) => {
  const project = await createProject(context);
  const input = await validInput(project.root);
  const outside = await mkdtemp(join(tmpdir(), 'project-lifecycle-materialization-outside-'));
  context.after(() => rm(outside, { recursive: true, force: true }));
  await writeFile(join(outside, 'outside.md'), 'outside bytes\n');
  await symlink(join(outside, 'outside.md'), join(project.lifecycleRoot, input.targets.en));
  const before = await treeSnapshot(project.lifecycleRoot);

  const result = await materializeCapability(input);

  assert.equal(result.ok, false);
  assert.equal(result.errors[0].code, 'PATH_SYMLINK_ESCAPE');
  assert.deepEqual(await treeSnapshot(project.lifecycleRoot), before);
  assert.equal(await readFile(join(outside, 'outside.md'), 'utf8'), 'outside bytes\n');
});

test('rejects an outside-pointing docs symlink with project and external trees unchanged', async (context) => {
  const project = await createProject(context);
  const outside = await mkdtemp(join(tmpdir(), 'project-lifecycle-docs-outside-'));
  context.after(() => rm(outside, { recursive: true, force: true }));
  await rename(join(project.root, 'docs'), join(outside, 'docs'));
  await symlink(join(outside, 'docs'), join(project.root, 'docs'));
  const projectBefore = await treeSnapshot(project.root);
  const outsideBefore = await treeSnapshot(outside);

  const result = await materializeCapability(await validInput(project.root));

  assert.equal(result.ok, false);
  assert.equal(result.errors[0].code, 'PATH_SYMLINK_ESCAPE');
  assert.deepEqual(await treeSnapshot(project.root), projectBefore);
  assert.deepEqual(await treeSnapshot(outside), outsideBefore);
});

test('accepts the first publisher moving the root and then rejecting when postconditions hold', async (context) => {
  const project = await createProject(context);
  const before = await treeSnapshot(join(project.root, 'docs'));
  let renameCount = 0;

  const result = await materializeCapability(await validInput(project.root), {
    rename: async (...args) => {
      renameCount += 1;
      await rename(...args);
      if (renameCount === 1) throw new Error('reject after first move');
    },
  });

  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(renameCount, 2);
  assert.notDeepEqual(await treeSnapshot(join(project.root, 'docs')), before);
});

test('restores the original when trusted transition inspection rejects after the backup move', async (context) => {
  const project = await createProject(context);
  const before = await treeSnapshot(join(project.root, 'docs'));

  const result = await materializeCapability(await validInput(project.root), {
    inspectTransition: async ({ phase }) => {
      assert.equal(phase, 'backup-moved');
      throw new Error('controlled transition inspection failure');
    },
  });

  assert.equal(result.ok, false);
  assert.equal(result.errors[0].code, 'MATERIALIZATION_WRITE_FAILED');
  assert.deepEqual(await treeSnapshot(join(project.root, 'docs')), before);
});

test('restores the byte-identical original root after a controlled late verification failure', async (context) => {
  const project = await createProject(context);
  const before = await treeSnapshot(project.lifecycleRoot);

  const result = await materializeCapability(await validInput(project.root), {
    afterPublish: async () => {
      const error = new Error('controlled private marker');
      error.code = 'CONTROLLED_LATE_FAILURE';
      throw error;
    },
  });

  assert.equal(result.ok, false);
  assert.equal(result.errors[0].code, 'MATERIALIZATION_WRITE_FAILED');
  assert.equal(result.errors[0].message.includes('private marker'), false);
  assert.deepEqual(await treeSnapshot(project.lifecycleRoot), before);
});

test('restores the byte-identical original root when candidate publication fails after backup', async (context) => {
  const project = await createProject(context);
  const before = await treeSnapshot(project.lifecycleRoot);
  let renameCount = 0;

  const result = await materializeCapability(await validInput(project.root), {
    rename: async (...args) => {
      renameCount += 1;
      if (renameCount === 2) {
        const error = new Error('controlled candidate publish failure');
        error.code = 'EXDEV';
        throw error;
      }
      return rename(...args);
    },
  });

  assert.equal(result.ok, false);
  assert.equal(result.errors[0].code, 'MATERIALIZATION_WRITE_FAILED');
  assert.equal(renameCount, 2);
  assert.deepEqual(await treeSnapshot(project.lifecycleRoot), before);
});

test('accepts the second publisher moving the stage and then rejecting when postconditions hold', async (context) => {
  const project = await createProject(context);
  const before = await treeSnapshot(join(project.root, 'docs'));
  let renameCount = 0;

  const result = await materializeCapability(await validInput(project.root), {
    rename: async (...args) => {
      renameCount += 1;
      await rename(...args);
      if (renameCount === 2) throw new Error('reject after candidate move');
    },
  });

  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(renameCount, 2);
  assert.notDeepEqual(await treeSnapshot(join(project.root, 'docs')), before);
});

test('preserves a verified live candidate when backup cleanup partially removes then rejects', async (context) => {
  const project = await createProject(context);

  const result = await materializeCapability(await validInput(project.root), {
    removeBackup: async (backupRoot) => {
      await rm(join(backupRoot, 'INDEX.md'));
      throw new Error('controlled partial backup cleanup');
    },
  });

  assert.equal(result.ok, true);
  assert.equal(result.value.status, 'materialized');
  assert.equal(result.value.cleanup_state, 'pending');
  assert.deepEqual(result.value.recovery_artifacts, ['backup']);
  const docsEntries = await readdir(join(project.root, 'docs'));
  assert.equal(docsEntries.includes('project-lifecycle'), true);
  assert.equal(docsEntries.some((name) => name.startsWith('.project-lifecycle-layout-backup-')), true);
  assert.equal(docsEntries.some((name) => name.startsWith('.project-lifecycle-layout-stage-')), false);
  const map = await readJson(join(project.lifecycleRoot, 'project-map.json'));
  assert.equal(map.domains.find(({ id }) => id === 'wiki-workspace').domain_state, 'materialized');
});

test('trusts completed backup cleanup postcondition when remover deletes then rejects', async (context) => {
  const project = await createProject(context);

  const result = await materializeCapability(await validInput(project.root), {
    removeBackup: async (backupRoot) => {
      await rm(backupRoot, { recursive: true, force: true });
      throw new Error('reject after complete cleanup');
    },
  });

  assert.equal(result.ok, true);
  assert.equal(result.value.status, 'materialized');
  assert.equal(result.value.cleanup_state, 'complete');
  assert.equal(Object.hasOwn(result.value, 'recovery_artifacts'), false);
  const docsEntries = await readdir(join(project.root, 'docs'));
  assert.deepEqual(docsEntries, ['project-lifecycle']);
});

test('preserves backup and candidate recovery artifacts when restore rename fails', async (context) => {
  const project = await createProject(context);

  const result = await materializeCapability(await validInput(project.root), {
    afterPublish: async () => { throw new Error('trigger rollback'); },
    restoreRename: async () => { throw new Error('controlled restore failure'); },
  });

  assert.equal(result.ok, false);
  assert.equal(result.errors[0].code, 'MATERIALIZATION_RESTORE_FAILED');
  assert.equal(result.errors[0].message.includes(project.root), false);
  assert.match(result.errors[0].message, /backup, stage/u);
  const docsEntries = await readdir(join(project.root, 'docs'));
  assert.equal(docsEntries.includes('project-lifecycle'), false);
  assert.equal(docsEntries.some((name) => name.startsWith('.project-lifecycle-layout-backup-')), true);
  assert.equal(docsEntries.some((name) => name.startsWith('.project-lifecycle-layout-stage-')), true);
});

test('rejects a no-op publication override without changing or hiding the original root', async (context) => {
  const project = await createProject(context);
  const before = await treeSnapshot(join(project.root, 'docs'));

  const result = await materializeCapability(await validInput(project.root), {
    rename: async () => {},
  });

  assert.equal(result.ok, false);
  assert.equal(result.errors[0].code, 'MATERIALIZATION_WRITE_FAILED');
  assert.deepEqual(await treeSnapshot(join(project.root, 'docs')), before);
});

test('rejects a no-op staged writer without changing the original root', async (context) => {
  const project = await createProject(context);
  const before = await treeSnapshot(join(project.root, 'docs'));

  const result = await materializeCapability(await validInput(project.root), {
    atomicWriteValidated: async () => {},
  });

  assert.equal(result.ok, false);
  assert.equal(result.errors[0].code, 'MATERIALIZATION_WRITE_FAILED');
  assert.deepEqual(await treeSnapshot(join(project.root, 'docs')), before);
});

test('rejects a staged candidate whose untouched pending ledger was corrupted', async (context) => {
  const project = await createProject(context);
  const before = await treeSnapshot(join(project.root, 'docs'));

  const result = await materializeCapability(await validInput(project.root), {
    atomicWriteValidated: async (options) => {
      const written = await atomicWriteValidated(options);
      if (options.target === 'INDEX.md') {
        await writeFile(join(options.root, 'pending-changes.json'), '{}\n');
      }
      return written;
    },
  });

  assert.equal(result.ok, false);
  assert.equal(result.errors[0].code, 'MATERIALIZATION_WRITE_FAILED');
  assert.deepEqual(await treeSnapshot(join(project.root, 'docs')), before);
});

test('negative target validation occurs before any stage or backup becomes visible', async (context) => {
  const project = await createProject(context);
  const input = await validInput(project.root);
  input.targets.en = 'knowledge/other-en.md';
  const docsRoot = join(project.root, 'docs');
  const before = await treeSnapshot(docsRoot);

  const result = await materializeCapability(input);

  assert.equal(result.ok, false);
  assert.equal(result.errors[0].code, 'MATERIALIZATION_TARGET_INVALID');
  assert.deepEqual(await treeSnapshot(docsRoot), before);
});

test('the published documents retain all eight populated sections without a delivery matrix', async (context) => {
  const { root, lifecycleRoot } = await createProject(context);
  assert.equal((await materializeCapability(await validInput(root))).ok, true);

  for (const name of ['wiki-workspace-en.md', 'wiki-workspace.md']) {
    const source = await readFile(join(lifecycleRoot, 'knowledge', name), 'utf8');
    const parsed = parseFrontmatter(source);
    assert.equal(parsed.ok, true);
    const sections = [...parsed.value.body.matchAll(/^## ([^\n]+)\n\n([^#][\s\S]*?)(?=^## |\z)/gm)];
    assert.equal([...parsed.value.body.matchAll(/^## /gm)].length, 8);
    assert.equal(sections.every((match) => match[2].trim().length > 0), true);
    assert.equal(source.includes('PRD / Architecture / Development / Test'), false);
  }
});
