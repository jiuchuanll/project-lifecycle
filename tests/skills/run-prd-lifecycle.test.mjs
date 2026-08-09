import assert from 'node:assert/strict';
import { access, readFile } from 'node:fs/promises';
import test from 'node:test';

import { parse as parseYaml } from 'yaml';

const skillUrl = new URL('../../skills/run-prd-lifecycle/SKILL.md', import.meta.url);
const referenceRoot = new URL('../../skills/run-prd-lifecycle/references/', import.meta.url);
const expectedReferences = [
  'closure-and-retention.md',
  'delivery-assets.md',
  'feedback-and-prd-boundaries.md',
  'intake-routing.md',
  'obligations.md',
  'parallel-delivery.md',
];
const orderedStates = [
  'INTAKE',
  'GROUND',
  'ROUTE',
  'MATERIALIZE_MINIMUM',
  'DELIVER',
  'VERIFY',
  'ACCEPT/CLOSE',
  'HANDOFF_KNOWLEDGE',
  'CLEAN_RUNTIME',
];
const routes = ['KNOWLEDGE_UPDATE', 'PRD_DELIVERY', 'NON_PRD_DELIVERY', 'OUTSIDE_PLUGIN'];

const loadSkill = async () => {
  const source = await readFile(skillUrl, 'utf8');
  const match = source.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
  assert.ok(match, 'SKILL.md must contain YAML Frontmatter followed by a body');
  return { frontmatter: parseYaml(match[1]), body: match[2] };
};

test('declares the canonical PRD lifecycle Skill identity and delivery triggers', async () => {
  const { frontmatter } = await loadSkill();

  assert.equal(frontmatter.name, 'run-prd-lifecycle');
  for (const trigger of ['Feedback', 'PRD', 'non-PRD', 'architecture', 'testing', 'closure']) {
    assert.match(frontmatter.description, new RegExp(trigger, 'i'));
  }
});

test('links exactly six focused one-level references', async () => {
  const { body } = await loadSkill();
  const references = [...body.matchAll(/\]\(references\/([^)]+\.md)\)/g)]
    .map(([, reference]) => reference);

  assert.deepEqual([...new Set(references)].sort(), expectedReferences);
  for (const reference of references) {
    assert.doesNotMatch(reference, /\//);
    await access(new URL(reference, referenceRoot));
  }
});

test('classifies before durable creation and preserves the delivery knowledge boundary', async () => {
  const { body } = await loadSkill();

  for (const statement of [
    'Classify the intake before creating durable delivery state.',
    'Do not require a PRD for every change.',
    'Delivery intent and evidence cannot be promoted directly into current project knowledge.',
    'Ordinary architecture, implementation, testing, acceptance, and closure stages are not secondary obligations.',
  ]) {
    assert.ok(body.includes(statement), statement);
  }
});

test('states the complete ordered lifecycle and every state contract', async () => {
  const { body } = await loadSkill();
  const lifecycle = body.match(/## Ordered Lifecycle\n([\s\S]*?)\n## /)?.[1];

  assert.ok(lifecycle, 'SKILL.md must contain an Ordered Lifecycle section');
  assert.match(
    lifecycle,
    /\| State \| Entry evidence \| Minimum next output \| Stop condition \| Human gate \| Owning reference \|/,
  );
  let previous = -1;
  for (const state of orderedStates) {
    const index = lifecycle.indexOf(`| ${state} |`);
    assert.ok(index > previous, `${state} must appear in lifecycle order`);
    const cells = lifecycle.slice(index).split('\n', 1)[0]
      .split('|').slice(1, -1).map((cell) => cell.trim());
    assert.equal(cells.length, 6);
    assert.ok(cells.every(Boolean));
    assert.match(cells[5], /^\[[^\]]+\]\(references\/[^/)]+\.md\)$/);
    previous = index;
  }
});

test('keeps the four routes and temporary NEEDS_USER stop canonical in intake routing', async () => {
  const intake = await readFile(new URL('intake-routing.md', referenceRoot), 'utf8');

  for (const route of routes) assert.match(intake, new RegExp(`\\b${route}\\b`));
  assert.match(intake, /\bNEEDS_USER\b/);
  assert.match(intake, /exactly one active primary route/i);

  for (const reference of expectedReferences.filter((name) => name !== 'intake-routing.md')) {
    const source = await readFile(new URL(reference, referenceRoot), 'utf8');
    for (const route of routes) assert.doesNotMatch(source, new RegExp(`\\b${route}\\b`));
    assert.doesNotMatch(source, /\bNEEDS_USER\b/);
  }
});

test('uses intake routing only for a new intake or material main-flow correction', async () => {
  const { body } = await loadSkill();

  assert.match(body, /load .*intake-routing\.md.*only for a new intake or a material main-flow correction/i);
  assert.match(body, /existing durable owner.*Frontmatter.*current Context Receipt.*before consulting intake routing again/is);
});

test('keeps handoff authority narrow between the two Skills', async () => {
  const { body } = await loadSkill();

  assert.match(body, /sole Context Receipt writer/i);
  assert.match(body, /sole Knowledge Diff candidate producer/i);
  assert.match(body, /cannot apply current project knowledge/i);
  assert.match(body, /maintain-project-knowledge.*accepted knowledge writeback/is);
});

test('exposes the closed native decision contract before reference routing', async () => {
  const { body } = await loadSkill();
  const decision = body.match(/<!-- lifecycle-decision-contract\n([\s\S]*?)\n-->/)?.[1];

  assert.ok(decision, 'root Skill must expose the native decision contract');
  assert.deepEqual(parseYaml(decision), {
    primary_routes: ['KNOWLEDGE_UPDATE', 'NON_PRD_DELIVERY', 'OUTSIDE_PLUGIN', 'PRD_DELIVERY'],
    temporary_stop: 'NEEDS_USER',
    route_selection: {
      accepted_knowledge_only: 'KNOWLEDGE_UPDATE',
      feedback_prd_or_product_delivery: 'PRD_DELIVERY',
      engineering_repair_migration_or_operations_without_prd: 'NON_PRD_DELIVERY',
      no_durable_lifecycle_effect: 'OUTSIDE_PLUGIN',
    },
    selected_solution_id: 'required-before-durable-write',
    intent_materialized_without_acceptance: false,
  });
  assert.ok(body.indexOf('<!-- lifecycle-decision-contract') < body.indexOf('## Reference Routing'));
});
