import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import { parseRestrictedYaml } from '../../scripts/lib/markdown.mjs';
import { deliveryLayoutContent } from '../../scripts/delivery/delivery-layout.mjs';

const repository = fileURLToPath(new URL('../..', import.meta.url));
const cli = process.env.DELIVERY_TEST_CLI ?? join(repository, 'scripts/bin/project-lifecycle-source.mjs');
const run = (root, command, ...args) => {
  const result = spawnSync(process.execPath, [cli, command, '--root', root, ...args], { encoding: 'utf8' });
  assert.equal(result.stderr, '');
  const envelope = JSON.parse(result.stdout);
  assert.equal(result.status, envelope.ok ? 0 : 1, result.stdout);
  return envelope;
};
const fixture = async (context) => {
  const root = await mkdtemp(join(tmpdir(), 'delivery-workflow-'));
  context.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, 'docs/project-lifecycle/delivery'), { recursive: true });
  await writeFile(join(root, 'docs/project-lifecycle/delivery/layout.json'), deliveryLayoutContent());
  return root;
};
const request = async (kind, id, owner) => {
  const body = {};
  let frontmatter;
  for (const [language, suffix] of [['en', '-en'], ['zh-CN', '']]) {
    const source = await readFile(join(repository, `skills/run-prd-lifecycle/assets/${kind}${suffix}.md`), 'utf8');
    const end = source.indexOf('\n---\n', 4);
    frontmatter = parseRestrictedYaml(source.slice(4, end), '/').value;
    body[language] = source.slice(end + 5);
  }
  frontmatter.artifact_id = id;
  if (owner) frontmatter.owner_artifact_id = owner;
  return { frontmatter, body, reason: 'Exercise delivery creation and indexing', creation_origin: 'explicit_user', changed_contract_ref: 'decision:changed-search-contract' };
};
const create = async (root, input) => {
  const path = join(root, 'request.json');
  await writeFile(path, JSON.stringify(input));
  return run(root, 'materialize-delivery-asset', '--input', path);
};

test('CLI creates template Feedback, PRD and architecture with -en IDs and generates repeatable indexes', async (context) => {
  const root = await fixture(context);
  for (const [kind, id, owner] of [
    ['feedback', 'feedback-search-en', null],
    ['prd', 'prd-search-en', 'prd-search-en'],
    ['architecture', 'architecture-search-en', 'prd-search-en'],
  ]) {
    const result = await create(root, await request(kind, id, owner));
    assert.equal(result.ok, true, JSON.stringify(result));
  }
  assert.equal(run(root, 'validate-delivery-layout').ok, true);
  const first = run(root, 'generate-delivery-indexes');
  assert.equal(first.ok, true, JSON.stringify(first));
  const ownerIndex = await readFile(join(root, 'docs/project-lifecycle/delivery/prds/prd-search-en/INDEX-en.md'), 'utf8');
  assert.match(ownerIndex, /architecture-search-en-en\.md/u);
  const repeated = run(root, 'generate-delivery-indexes');
  assert.equal(repeated.ok, true);
  assert.deepEqual(repeated.value.changed, []);
});

test('CLI identifies Frontmatter fields without leaking their values or misreporting paths', async (context) => {
  const root = await fixture(context);
  const input = await request('prd', 'prd-search', 'prd-search');
  input.frontmatter.title = 'private-input-marker';
  const rejected = await create(root, input);
  assert.equal(rejected.errors[0].path, '/frontmatter/title');
  assert.doesNotMatch(JSON.stringify(rejected), /private-input-marker/u);
  delete input.frontmatter.title;
  assert.equal((await create(root, input)).ok, true);
  const path = join(root, 'docs/project-lifecycle/delivery/prds/prd-search/prd-search-en.md');
  const original = await readFile(path, 'utf8');
  for (const [source, code, field] of [
    [original.replace('schema_version: 2', 'schema_version: 2\ntitle: private-input-marker'), 'DELIVERY_FRONTMATTER_INVALID', 'title'],
    [original.replace(/^knowledge_baseline:.*\n/mu, ''), 'DELIVERY_FRONTMATTER_INVALID', 'knowledge_baseline'],
    [original.replace(/^domain_ids:[\s\S]*?(?=knowledge_baseline:)/mu, 'domain_ids: private-input-marker\n'), 'DELIVERY_FRONTMATTER_INVALID', 'domain_ids'],
    [original.replace('schema_version: 2', 'schema_version: [private-input-marker'), 'DELIVERY_FRONTMATTER_MALFORMED', ''],
    [original.replace('artifact_id: prd-search', 'artifact_id: prd-other'), 'DELIVERY_FRONTMATTER_INVALID', 'owner_artifact_id'],
  ]) {
    await writeFile(path, source);
    const result = run(root, 'generate-delivery-indexes');
    assert.equal(result.ok, false);
    assert.equal(result.errors[0].code, code, JSON.stringify(result));
    assert.equal(result.errors[0].path, `/delivery/prds/prd-search/prd-search-en.md/frontmatter${field ? `/${field}` : ''}`);
    assert.notEqual(result.errors[0].message, 'Validation failed.');
    assert.doesNotMatch(JSON.stringify(result), /private-input-marker/u);
    assert.equal(await readFile(path, 'utf8'), source);
  }
});

test('CLI preserves occupied manual indexes and explains the recovery action', async (context) => {
  const root = await fixture(context);
  assert.equal((await create(root, await request('prd', 'prd-search', 'prd-search'))).ok, true);
  const path = join(root, 'docs/project-lifecycle/delivery/INDEX.md');
  await writeFile(path, '# User maintained navigation\n');
  const result = run(root, 'generate-delivery-indexes');
  assert.equal(result.errors[0].code, 'DELIVERY_INDEX_OCCUPIED');
  assert.match(result.errors[0].message, /Preserve or relocate/u);
  assert.equal(await readFile(path, 'utf8'), '# User maintained navigation\n');
});

test('the documented JSON request can create a PRD and generate indexes', async (context) => {
  const root = await fixture(context);
  const guide = await readFile(join(repository, 'skills/run-prd-lifecycle/references/delivery-assets.md'), 'utf8');
  const example = /```json\n([\s\S]*?)\n```/u.exec(guide);
  assert.ok(example);
  const result = await create(root, JSON.parse(example[1]));
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(run(root, 'generate-delivery-indexes').ok, true);
});

test('preview is read-only, reports old blockers, and integrated creation is safely repeatable', async (context) => {
  const root = await fixture(context);
  const input = await request('prd', 'prd-preview', 'prd-preview');
  const path = join(root, 'request.json');
  await writeFile(path, JSON.stringify(input));
  const before = await import('../../scripts/knowledge/layout-transaction.mjs').then(({ inspectLifecycleTree }) => inspectLifecycleTree({ repositoryRoot: root }));
  const preview = run(root, 'preview-delivery-asset', '--input', path);
  assert.equal(preview.ok, true, JSON.stringify(preview));
  assert.equal(preview.value.files_changed, false);
  assert.equal(preview.value.indexes, 'ready');
  const { inspectLifecycleTree } = await import('../../scripts/knowledge/layout-transaction.mjs');
  assert.deepEqual(await inspectLifecycleTree({ repositoryRoot: root }), before);

  const manual = join(root, 'docs/project-lifecycle/delivery/INDEX.md');
  await writeFile(manual, '# Manual index\n');
  const blocked = run(root, 'materialize-delivery-asset', '--input', path, '--update-indexes');
  assert.equal(blocked.ok, false);
  assert.equal(blocked.context.files_changed, false);
  assert.equal(blocked.context.request_valid, true);
  assert.equal(blocked.errors[0].origin, 'existing_inventory');
  await assert.rejects(readFile(join(root, 'docs/project-lifecycle/delivery/prds/prd-preview/prd-preview-en.md')), { code: 'ENOENT' });
  await rm(manual);

  const first = run(root, 'materialize-delivery-asset', '--input', path, '--update-indexes');
  assert.equal(first.ok, true, JSON.stringify(first));
  assert.equal(first.value.asset_saved, true);
  assert.equal(first.value.indexes, 'updated');
  const after = await inspectLifecycleTree({ repositoryRoot: root });
  const repeated = run(root, 'materialize-delivery-asset', '--input', path, '--update-indexes');
  assert.equal(repeated.ok, true, JSON.stringify(repeated));
  assert.equal(repeated.value.status, 'unchanged');
  assert.deepEqual(repeated.value.index_changes, []);
  assert.deepEqual(await inspectLifecycleTree({ repositoryRoot: root }), after);

  input.body.en += '\nChanged intent.\n';
  await writeFile(path, JSON.stringify(input));
  const changed = run(root, 'materialize-delivery-asset', '--input', path, '--update-indexes');
  assert.equal(changed.ok, false);
  assert.equal(changed.errors[0].code, 'ASSET_REDUNDANT');
  assert.deepEqual(await inspectLifecycleTree({ repositoryRoot: root }), after);
});

test('reports multiple independent errors with precise reasons, actions and no private values', async (context) => {
  const root = await fixture(context);
  for (const id of ['prd-first', 'prd-second']) {
    assert.equal((await create(root, await request('prd', id, id))).ok, true);
    const path = join(root, `docs/project-lifecycle/delivery/prds/${id}/${id}-en.md`);
    const text = await readFile(path, 'utf8');
    await writeFile(path, id === 'prd-first'
      ? text.replace('schema_version: 2', 'schema_version: 2\ntitle: private-input-marker')
      : text.replace(/^knowledge_baseline:.*\n/mu, ''));
  }
  const errors = run(root, 'validate-delivery-layout');
  assert.equal(errors.ok, false);
  assert.deepEqual(errors.errors.map(({ reason }) => reason), ['additionalProperties', 'required']);
  assert.equal(errors.context.files_changed, false);
  assert.equal(errors.context.truncated, false);
  assert.ok(errors.errors.every(({ action }) => action.length > 0));
  assert.match(errors.errors[0].message, /not supported/u);
  assert.match(errors.errors[1].message, /missing/u);
  assert.doesNotMatch(JSON.stringify(errors), /private-input-marker/u);
});

test('shipped request examples run through preview and integrated creation without private implementation knowledge', async (context) => {
  const root = await fixture(context);
  for (const kind of ['feedback', 'prd', 'architecture']) {
    const input = JSON.parse(await readFile(join(repository, `skills/run-prd-lifecycle/assets/${kind}-request.json`), 'utf8'));
    const path = join(root, 'request.json');
    await writeFile(path, JSON.stringify(input));
    const preview = run(root, 'preview-delivery-asset', '--input', path);
    assert.equal(preview.ok, true, JSON.stringify(preview));
    assert.equal(preview.value.files_changed, false);
    const saved = run(root, 'materialize-delivery-asset', '--input', path, '--update-indexes');
    assert.equal(saved.ok, true, JSON.stringify(saved));
    assert.equal(saved.value.indexes, 'updated');
    const retry = run(root, 'materialize-delivery-asset', '--input', path, '--update-indexes');
    assert.equal(retry.ok, true, JSON.stringify(retry));
    assert.equal(retry.value.status, 'unchanged');
  }
});
