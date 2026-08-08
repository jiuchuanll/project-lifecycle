import assert from 'node:assert/strict';
import {
  lstat,
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

import { bootstrap } from '../../scripts/knowledge/bootstrap.mjs';
import { materializeCapability } from '../../scripts/knowledge/materialize.mjs';
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
  const englishDocument = await readFile(join(lifecycleRoot, node.paired_assets.en), 'utf8');
  const chineseDocument = await readFile(join(lifecycleRoot, node.paired_assets['zh-CN']), 'utf8');
  assert.equal(englishIndex.includes('[`wiki-workspace`](knowledge/wiki-workspace-en.md)'), true);
  assert.equal(chineseIndex.includes('[`wiki-workspace`](knowledge/wiki-workspace.md)'), true);
  assert.equal(englishIndex.includes('approval:user-current-wiki'), false);
  assert.equal(chineseIndex.includes('approval:user-current-wiki'), false);
  for (const value of ['Sample Application', '示例应用', 'calibration:initial-user-approval']) {
    assert.equal(`${englishIndex}\n${chineseIndex}`.includes(value), true);
  }
  assert.equal(englishDocument.includes('Canonical owner: `wiki-workspace`'), true);
  assert.equal(chineseDocument.includes('规范所有者：`wiki-workspace`'), true);
  assert.equal(englishDocument.includes('Declared dependency: `app-shell`'), true);
  assert.equal(chineseDocument.includes('已声明依赖：`app-shell`'), true);
  assert.equal(englishDocument.includes('Approval: `approval:user-current-wiki`'), true);
  assert.equal(chineseDocument.includes('批准依据：`approval:user-current-wiki`'), true);
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
  otherNode.paired_assets = clone(input.targets);
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

test('restores the original when the first publisher moves the root and then rejects', async (context) => {
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

  assert.equal(result.ok, false);
  assert.equal(result.errors[0].code, 'MATERIALIZATION_WRITE_FAILED');
  assert.equal(renameCount, 1);
  assert.deepEqual(await treeSnapshot(join(project.root, 'docs')), before);
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

test('restores the original when the second publisher moves the stage and then rejects', async (context) => {
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

  assert.equal(result.ok, false);
  assert.equal(result.errors[0].code, 'MATERIALIZATION_WRITE_FAILED');
  assert.equal(renameCount, 2);
  assert.deepEqual(await treeSnapshot(join(project.root, 'docs')), before);
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
  assert.equal(docsEntries.some((name) => name.startsWith('.project-lifecycle-materialize-backup-')), true);
  assert.equal(docsEntries.some((name) => name.startsWith('.project-lifecycle-materialize-stage-')), false);
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
  assert.equal(docsEntries.some((name) => name.startsWith('.project-lifecycle-materialize-backup-')), true);
  assert.equal(docsEntries.some((name) => name.startsWith('.project-lifecycle-materialize-stage-')), true);
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
