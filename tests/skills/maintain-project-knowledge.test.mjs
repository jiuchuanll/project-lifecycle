import assert from 'node:assert/strict';
import { access, readFile } from 'node:fs/promises';
import test from 'node:test';

import { parse as parseYaml } from 'yaml';

const skillUrl = new URL('../../skills/maintain-project-knowledge/SKILL.md', import.meta.url);
const expectedReferences = [
  'archive-retrieval.md',
  'bootstrap-and-calibration.md',
  'context-routing.md',
  'deep-domain-calibration.md',
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
const referenceReadAction = String.raw`(?:preload(?:ing)?|load(?:ing)?|read(?:ing)?|open(?:ing)?)`;
const wholeReferenceSet = [
  String.raw`(?:all(?:\s+of\s+the)?|every|each)(?:\s+(?:other|sibling))?\s+references?`,
  String.raw`(?:(?:all|the)\s+)?seven\s+references?`,
  String.raw`(?:the\s+)?(?:whole|entire|full)\s+(?:reference\s+set|set\s+of\s+references)`,
  String.raw`(?:other|sibling)\s+references`,
].join('|');
const wholeReferenceSetInstruction = new RegExp(
  String.raw`\b${referenceReadAction}\s+(?:${wholeReferenceSet})\b`,
  'gi',
);
const explicitLoadingNegation = /(?:\b(?:do\s+not|never|must\s+not|cannot|can't)\b(?:\s+\w+){0,3}\s*|\bwithout(?:\s+\w+){0,3}\s*)$/i;

const instructsWholeReferenceSet = (source) => source.split(/\r?\n/).some((line) => {
  wholeReferenceSetInstruction.lastIndex = 0;
  for (const instruction of line.matchAll(wholeReferenceSetInstruction)) {
    const prefix = line.slice(0, instruction.index);
    if (!explicitLoadingNegation.test(prefix)) return true;
  }
  return false;
});

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

test('routes installed validator calls through the dependency-free plugin runtime', async () => {
  const { body } = await loadSkill();
  const runtime = body.match(/<!-- plugin-runtime-contract\n([\s\S]*?)\n-->/)?.[1];

  assert.ok(runtime, 'root Skill must expose the installed plugin runtime contract');
  assert.deepEqual(parseYaml(runtime), {
    installed_cli: 'bin/project-lifecycle',
    node_fallback: 'dist/project-lifecycle.mjs',
    source_cli: 'repository-development-only',
    cache_dependency_install: 'forbidden',
  });
});

test('advertises receipt-gated archive retrieval for bounded historical investigations', async () => {
  const { frontmatter } = await loadSkill();

  assert.match(frontmatter.description, /receipt-gated archive retrieval/i);
  for (const trigger of ['audit', 'regression', 'incident', 'historical comparison']) {
    assert.match(frontmatter.description, new RegExp(`\\b${trigger}\\b`, 'i'));
  }
});

test('links exactly seven focused references one level below the Skill', async () => {
  const { body } = await loadSkill();
  const references = [...body.matchAll(/\]\(references\/([^)]+\.md)\)/g)]
    .map(([, reference]) => reference);

  assert.deepEqual([...new Set(references)].sort(), expectedReferences);
  for (const reference of references) {
    assert.doesNotMatch(reference, /\//);
    await access(new URL(`../../skills/maintain-project-knowledge/references/${reference}`, import.meta.url));
  }
});

for (const [source, expected] of [
  ['Do not load all references.', false],
  ['Never read every sibling reference.', false],
  ['Agents must not open each other reference.', false],
  ['Continue without loading all references.', false],
  ['The Skill cannot preload the whole reference set.', false],
  ['Load every reference.', true],
  ['Read all references.', true],
  ['Preload the whole reference set.', true],
  ['Open each sibling reference.', true],
  ['Load all other references.', true],
  ['Load all seven references.', true],
  ['Load the seven references.', true],
  ['Preload the full reference set.', true],
  ['Read all of the references.', true],
]) {
  test(`classifies whole-reference instruction: ${source}`, () => {
    assert.equal(instructsWholeReferenceSet(source), expected);
  });
}

test('references never instruct loading the whole reference set recursively', async () => {
  for (const reference of expectedReferences) {
    const source = await readFile(
      new URL(`../../skills/maintain-project-knowledge/references/${reference}`, import.meta.url),
      'utf8',
    );
    assert.equal(instructsWholeReferenceSet(source), false, reference);
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

test('defines the recursive v2 layout, migration, and repository-shard contracts', async () => {
  const { body } = await loadSkill();
  const context = await readFile(new URL('../../skills/maintain-project-knowledge/references/context-routing.md', import.meta.url), 'utf8');
  const bootstrap = await readFile(new URL('../../skills/maintain-project-knowledge/references/bootstrap-and-calibration.md', import.meta.url), 'utf8');
  const materialization = await readFile(new URL('../../skills/maintain-project-knowledge/references/materialization.md', import.meta.url), 'utf8');
  const topology = await readFile(new URL('../../skills/maintain-project-knowledge/references/topology-and-constraints.md', import.meta.url), 'utf8');

  assert.match(body, /schema v2/);
  assert.match(body, /`parent_id` is the only vertical-topology source/);
  assert.match(body, /three bounded classes/);
  assert.match(context, /repository-local Knowledge root or shard index/);
  assert.match(context, /`portable_locator`/);
  assert.match(bootstrap, /ask once for migration approval/);
  assert.match(bootstrap, /ordinary temporary question performs no migration and no durable write/);
  assert.match(materialization, /`knowledge\/<id>-en\.md`/);
  assert.match(materialization, /`paired_assets\.repository_id`/);
  assert.match(topology, /Adding the first child promotes/);
  assert.match(topology, /removing or reparenting the last child demotes/);
  assert.match(topology, /Never synthesize governance ancestor directories/);
});

test('defines a closed user-controlled deep-domain calibration contract', async () => {
  const { body } = await loadSkill();
  const source = await readFile(
    new URL('../../skills/maintain-project-knowledge/references/deep-domain-calibration.md', import.meta.url),
    'utf8',
  ).catch(() => '');
  const contract = source.match(/<!-- deep-domain-calibration-contract\n([\s\S]*?)\n-->/)?.[1];

  assert.ok(contract, 'deep calibration reference must expose its machine-readable contract');
  assert.deepEqual(parseYaml(contract), {
    scope: 'per-domain',
    invocation: {
      signal_action: 'recommend',
      explicit_request: 'authorized',
      choices: ['BRAINSTORMING', 'GRILL_ME', 'BUILT_IN', 'DEFER', 'CONTINUE_LIGHT'],
    },
    capability_install: {
      authorization: 'separate-explicit',
      source: 'exact-trusted',
      unavailable_fallback: 'BUILT_IN',
      cache_edit: 'forbidden',
    },
    persistence: {
      reasoning_transcripts: 'transient',
      complexity_score: 'forbidden',
      calibration_log: 'forbidden',
    },
    intervention_points: [
      'INITIAL_COVERAGE_CALIBRATION',
      'COMPLEXITY_ESCALATION_CHOICE',
      'APPROACH_SELECTION',
      'TACIT_KNOWLEDGE_QUESTION',
      'DOMAIN_BOUNDARY_CONFIRMATION',
      'WHOLE_MAP_CONSISTENCY_REVIEW',
      'CURRENT_TRUTH_PROMOTION',
    ],
    quality_gates: [
      'BOUNDARY_CLARITY',
      'DURABLE_FACT_COVERAGE',
      'EVIDENCE_QUALITY',
      'RELATIONSHIP_CLARITY',
      'EXTENSION_READINESS',
      'CONCISION',
    ],
  });

  const routingRow = body.split('\n').find((line) => line.includes('(references/deep-domain-calibration.md)'));
  assert.ok(routingRow, 'root Skill must route deep-domain calibration');
  for (const trigger of ['complex', 'explicit', 'whole-map', 'quality']) {
    assert.match(routingRow, new RegExp(trigger, 'i'));
  }
});

test('connects bootstrap to user-controlled deepening and affected-only second-pass review', async () => {
  const source = await readFile(
    new URL('../../skills/maintain-project-knowledge/references/bootstrap-and-calibration.md', import.meta.url),
    'utf8',
  );
  const contract = source.match(/<!-- deep-calibration-bootstrap-contract\n([\s\S]*?)\n-->/)?.[1];

  assert.ok(contract, 'bootstrap reference must expose its deep-calibration handoff');
  assert.deepEqual(parseYaml(contract), {
    complexity_scope: 'per-domain',
    signal_action: 'recommend-and-wait',
    explicit_request: 'authorized',
    decline: {
      progress: 'verified-only',
      current_promotion: 'evidence-required',
      repeated_persuasion: 'forbidden',
    },
    second_pass: {
      timing: 'after-authorized-deepening',
      write_gate: 'before-complex-skeleton',
      reopen: 'affected-only',
    },
  });
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

test('keeps the native decision contract at the root without duplicating obligation vocabularies', async () => {
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

  for (const value of [
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

test('keeps knowledge control during confirmed alignment Feedback capture', async () => {
  const bootstrap = await readFile(
    new URL('../../skills/maintain-project-knowledge/references/bootstrap-and-calibration.md', import.meta.url),
    'utf8',
  );
  const materialization = await readFile(
    new URL('../../skills/maintain-project-knowledge/references/materialization.md', import.meta.url),
    'utf8',
  );
  assert.match(bootstrap, /Feedback captured.*PRD materialized.*delivery started/is);
  assert.match(bootstrap, /return control to knowledge (?:construction|maintenance)/i);
  assert.match(materialization, /accepted business decision.*verified implementation state/is);
  assert.match(materialization, /must not claim.*implementation.*removed/is);
});
