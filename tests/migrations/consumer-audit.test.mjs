import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import { auditConsumer } from '../../scripts/migrations/audit-consumer.mjs';

const fixtureRoot = fileURLToPath(new URL('../fixtures/migrations/knowledgevault-agent-app', import.meta.url));

const fingerprint = async (root) => {
  const hash = createHash('sha256');
  const visit = async (directory, prefix = '') => {
    for (const entry of (await readdir(directory, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
      const locator = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) await visit(join(directory, entry.name), locator);
      else {
        hash.update(locator);
        hash.update(await readFile(join(directory, entry.name)));
      }
    }
  };
  await visit(root);
  return hash.digest('hex');
};

test('audits both legacy Skills, directive call sites, indexes, pairs, and tool assets without mutation', async () => {
  const before = await fingerprint(fixtureRoot);
  const result = await auditConsumer({
    root: fixtureRoot,
    supportMatrix: {
      hosts: { codex: { status: 'FAILED' }, kimi: { status: 'FAILED' } },
    },
    pluginDiscovery: { maintain_project_knowledge: false, run_prd_lifecycle: false },
    readDirtyPaths: async () => ['src/unrelated-change.kt'],
  });
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.deepEqual(result.value.legacy_skill_copies, [
    '.agents/skills/docs-workflow/SKILL.md',
    '.zcode/skills/docs-workflow/SKILL.md',
  ]);
  assert.deepEqual(result.value.instruction_call_sites, [
    { locator: 'AGENTS.md', lines: [3, 4] },
    { locator: 'docs/product/README.md', lines: [3] },
  ]);
  assert.deepEqual(result.value.product_indexes, ['docs/product/desktop-agent/INDEX.md']);
  assert.deepEqual(result.value.bilingual_pairs, [{
    en: 'docs/product/desktop-agent/requirements/sample-prd-en.md',
    zh: 'docs/product/desktop-agent/requirements/sample-prd.md',
  }]);
  assert.deepEqual(result.value.unpaired_bilingual_assets, ['docs/product/desktop-agent/architecture/orphan-en.md']);
  assert.deepEqual(result.value.superpowers_assets, [
    'docs/superpowers/plans/sample-plan.md',
    'docs/superpowers/specs/sample-spec.md',
  ]);
  assert.deepEqual(result.value.unrelated_dirty_paths, ['src/unrelated-change.kt']);
  assert.deepEqual(result.value.scanned_roots, [
    '.agents/skills/docs-workflow/SKILL.md',
    '.zcode/skills/docs-workflow/SKILL.md',
    'AGENTS.md',
    'docs/product',
    'docs/superpowers/plans',
    'docs/superpowers/specs',
  ]);
  assert.deepEqual(result.value.deletion_candidates, []);
  assert.equal(result.value.migration_status, 'BLOCKED_UPSTREAM_SUPPORT');
  assert.equal(result.value.bootstrap_candidate, 'docs/project-lifecycle/');
  assert.equal(await fingerprint(fixtureRoot), before);
});

test('still requires native discovery of both Skills before proposing old-copy removal', async () => {
  const result = await auditConsumer({
    root: fixtureRoot,
    supportMatrix: { hosts: { codex: { status: 'SUPPORTED' } } },
    pluginDiscovery: { maintain_project_knowledge: true, run_prd_lifecycle: false },
    readDirtyPaths: async () => [],
  });
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.value.migration_status, 'BLOCKED_PLUGIN_DISCOVERY');
  assert.deepEqual(result.value.deletion_candidates, []);
});

test('returns review-only removal candidates after support and both native Skill discoveries', async () => {
  const result = await auditConsumer({
    root: fixtureRoot,
    supportMatrix: { hosts: { codex: { status: 'SUPPORTED' } } },
    pluginDiscovery: { maintain_project_knowledge: true, run_prd_lifecycle: true },
    readDirtyPaths: async () => [],
  });
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.value.migration_status, 'READY_FOR_SEPARATE_CONSUMER_PR');
  assert.deepEqual(result.value.deletion_candidates, result.value.legacy_skill_copies);
  assert.equal(result.value.audit_only, true);
});

test('fails closed for roots outside an explicit absolute consumer directory', async () => {
  const result = await auditConsumer({ root: 'relative-consumer' });
  assert.equal(result.ok, false);
  assert.equal(result.errors[0].code, 'CONSUMER_AUDIT_INVALID');
});
