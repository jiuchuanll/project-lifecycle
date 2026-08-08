import assert from 'node:assert/strict';
import { access, readFile } from 'node:fs/promises';
import test from 'node:test';

import { parse as parseYaml } from 'yaml';

const skillUrl = new URL('../../skills/maintain-project-knowledge/SKILL.md', import.meta.url);
const expectedReferences = [
  'archive-retrieval.md',
  'bootstrap-and-calibration.md',
  'context-routing.md',
  'knowledge-absorption.md',
  'materialization.md',
  'topology-and-constraints.md',
];
const orderedStates = [
  'DISCOVER',
  'CALIBRATE',
  'CONFIRM_BOUNDARY',
  'DEEPEN',
  'MATERIALIZE',
  'ROUTE/MAINTAIN',
  'ABSORB',
  'VERIFY',
];
const requiredGateStatements = [
  'English is read by default; update English and Chinese pairs atomically.',
  'Boundary confirmation is not fact verification.',
  'Only verified facts may become current.',
  'Do not read archive bodies without an Archive Access Receipt.',
  'Do not apply a Knowledge Diff whose baseline or ownership is unresolved.',
];

const loadSkill = async () => {
  const source = await readFile(skillUrl, 'utf8');
  const match = source.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
  assert.ok(match, 'SKILL.md must contain YAML Frontmatter followed by a body');
  return { frontmatter: parseYaml(match[1]), body: match[2] };
};

test('declares the canonical bootstrap and maintenance Skill identity', async () => {
  const { frontmatter } = await loadSkill();

  assert.equal(frontmatter.name, 'maintain-project-knowledge');
  assert.match(frontmatter.description, /bootstrap/i);
  assert.match(frontmatter.description, /maintain|maintenance/i);
});

test('links exactly six focused references one level below the Skill', async () => {
  const { body } = await loadSkill();
  const references = [...body.matchAll(/\]\(references\/([^)]+\.md)\)/g)]
    .map(([, reference]) => reference);

  assert.deepEqual([...new Set(references)].sort(), expectedReferences);
  for (const reference of references) {
    assert.doesNotMatch(reference, /\//);
    await access(new URL(`../../skills/maintain-project-knowledge/references/${reference}`, import.meta.url));
  }
});

test('states the ordered lifecycle and the contract carried by every state', async () => {
  const { body } = await loadSkill();
  const lifecycle = body.match(/## Ordered Lifecycle\n([\s\S]*?)\n## /)?.[1];

  assert.ok(lifecycle, 'SKILL.md must contain an Ordered Lifecycle section');
  let previousIndex = -1;
  for (const state of orderedStates) {
    const stateIndex = lifecycle.indexOf(`| ${state} |`);
    assert.ok(stateIndex > previousIndex, `${state} must appear in lifecycle order`);
    const row = lifecycle.slice(stateIndex).split('\n', 1)[0]
      .split('|').slice(1, -1).map((cell) => cell.trim());
    assert.equal(row.length, 5, `${state} must define all lifecycle columns`);
    assert.ok(row.every(Boolean), `${state} lifecycle columns must not be empty`);
    assert.match(row[2], /^\[[^\]]+\]\(references\/[^/)]+\.md\)$/);
    previousIndex = stateIndex;
  }
  assert.match(
    lifecycle,
    /\| State \| Stop condition \| Owning reference \| Allowed durable write \| Human gate \|/,
  );
});

test('makes the five knowledge safety gates explicit', async () => {
  const { body } = await loadSkill();

  for (const statement of requiredGateStatements) assert.ok(body.includes(statement));
});

test('defines only the narrow knowledge-selection handoff to PRD Lifecycle', async () => {
  const { body } = await loadSkill();
  const handoff = body.match(/<!-- prd-lifecycle-handoff\n([\s\S]*?)\n-->/)?.[1];

  assert.ok(handoff, 'SKILL.md must contain the machine-readable PRD Lifecycle handoff shape');
  const parsedHandoff = parseYaml(handoff);
  assert.deepEqual(Object.keys(parsedHandoff), [
    'knowledge_baseline',
    'primary_domain_id',
    'affected_domain_ids',
    'selected_context',
    'applicable_constraints',
    'exclusions',
    'open_questions',
    'stop_code',
  ]);
  assert.deepEqual(Object.keys(parsedHandoff.selected_context[0]), ['id', 'version_ref']);
  assert.deepEqual(Object.keys(parsedHandoff.applicable_constraints[0]), ['id', 'version_ref']);
});

test('does not duplicate the closed route or obligation vocabularies', async () => {
  const { body } = await loadSkill();

  for (const value of [
    'KNOWLEDGE_UPDATE',
    'NON_PRD_DELIVERY',
    'OUTSIDE_PLUGIN',
    'PRD_DELIVERY',
    'KNOWLEDGE_READINESS_REQUIRED',
    'KNOWLEDGE_CHANGE_HANDOFF_REQUIRED',
    'CROSS_DOMAIN_COORDINATION_REQUIRED',
    'DEPENDENCY_RESOLUTION_REQUIRED',
    'CONFLICT_RESOLUTION_REQUIRED',
    'MULTI_REPOSITORY_COORDINATION_REQUIRED',
  ]) {
    assert.doesNotMatch(body, new RegExp(`\\b${value}\\b`));
  }
});
