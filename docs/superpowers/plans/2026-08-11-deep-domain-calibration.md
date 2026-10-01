# Deep Domain Calibration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a user-controlled, domain-level deep-calibration protocol that improves domain decomposition and capability-document quality without adding persistent reasoning state or taking semantic decisions away from the user.

**Architecture:** Introduce one focused declarative reference owned by `maintain-project-knowledge`, route to it only for domain complexity, explicit deep-thinking requests, second-pass review, or semantic quality review, and keep bootstrap and materialization as the existing evidence/write owners. Enforce the interaction contract with Skill tests and the existing host-neutral Gold scenario model; strengthen the bilingual capability templates without changing schemas or CLI behavior.

**Tech Stack:** Markdown Agent Skills, Node.js `node:test`, JSON Gold scenarios, existing Project Lifecycle validators and bundle harness.

## Global Constraints

- Assess complexity per candidate domain, never by labeling the whole project simple or complex.
- Complexity signals recommend a deep mode; they never authorize automatic invocation of an external Skill.
- Explicit user requests for Brainstorming or Grill Me do not require redundant consent.
- Consent to deepen is separate from consent to install a global plugin.
- Use only an exact trusted plugin source and the host's native install mechanism after explicit approval; otherwise use the built-in equivalent.
- A user may decline deepening, but may not bypass evidence truth or the semantic quality gate for `current` knowledge.
- Keep reasoning transcripts, discarded alternatives, and complexity assessments transient.
- Keep `project-map.json` authoritative for topology and routing; add no complexity score, interview log, global fact index, schema field, CLI command, or persistent workflow-state file.
- Read English by default; update Chinese and English template or design pairs atomically.
- Preserve the existing schema-v2 recursive topology, explicit migration, repository-shard, archive receipt, Knowledge Diff, and PRD handoff contracts.
- Keep changes surgical: no version bump, release packaging change, README rewrite, or unrelated refactor in this plan.

---

### Task 1: Add the focused deep-domain calibration protocol and root routing

**Files:**
- Create: `skills/maintain-project-knowledge/references/deep-domain-calibration.md`
- Modify: `skills/maintain-project-knowledge/SKILL.md`
- Modify: `tests/skills/maintain-project-knowledge.test.mjs`

**Interfaces:**
- Consumes: bounded evidence, candidate domain cards, explicit user requests, and the existing `DISCOVER`/`CALIBRATE`/`CONFIRM_BOUNDARY`/`DEEPEN` lifecycle.
- Produces: a declarative recommendation-and-consent protocol; no JSON value, CLI output, durable project file, or new lifecycle route.
- Preserves: the one-reference-at-a-time loading rule and all existing primary routes and stop codes.

- [ ] **Step 1: Write the failing reference and routing tests**

Add `deep-domain-calibration.md` to `expectedReferences`, changing the existing test description from six to seven. Add this focused contract test after the recursive-v2 contract test:

```js
test('defines user-controlled domain-level deep calibration without persistent reasoning state', async () => {
  const { body } = await loadSkill();
  const deep = await readFile(
    new URL('../../skills/maintain-project-knowledge/references/deep-domain-calibration.md', import.meta.url),
    'utf8',
  );

  assert.match(body, /domain complexity.*explicit deep-thinking request.*whole-map consistency.*semantic quality review/is);
  assert.match(deep, /Complexity is assessed per candidate domain\./);
  assert.match(deep, /A signal recommends deeper calibration; it never authorizes starting it\./);
  assert.match(deep, /Brainstorming/i);
  assert.match(deep, /Grill Me/i);
  assert.match(deep, /built-in equivalent/i);
  assert.match(deep, /explicit user request.*already consent/is);
  assert.match(deep, /Installation requires separate explicit approval/i);
  assert.match(deep, /exact trusted plugin source/i);
  assert.match(deep, /reasoning transcripts remain transient/i);
  assert.match(deep, /Do not create a complexity score, interview log, or persistent calibration state/i);
  for (const intervention of [
    'initial coverage calibration',
    'complexity escalation choice',
    'approach selection',
    'tacit-knowledge questions',
    'domain boundary confirmation',
    'whole-map consistency review',
    'current-truth promotion',
  ]) {
    assert.match(deep, new RegExp(intervention, 'i'));
  }
});
```

Update the exact-reference assertions:

```js
const expectedReferences = [
  'archive-retrieval.md',
  'bootstrap-and-calibration.md',
  'context-routing.md',
  'deep-domain-calibration.md',
  'knowledge-absorption.md',
  'materialization.md',
  'topology-and-constraints.md',
];
```

Update the whole-set detector from `six` to `seven`, and update its positive examples so the safety test continues to reject instructions to load the entire current reference set:

```js
const wholeReferenceSet = [
  String.raw`(?:all(?:\s+of\s+the)?|every|each)(?:\s+(?:other|sibling))?\s+references?`,
  String.raw`(?:(?:all|the)\s+)?seven\s+references?`,
  String.raw`(?:the\s+)?(?:whole|entire|full)\s+(?:reference\s+set|set\s+of\s+references)`,
  String.raw`(?:other|sibling)\s+references`,
].join('|');
```

Use `Load all seven references.` and `Load the seven references.` in the classification cases. Keep the explicit negation cases unchanged.

- [ ] **Step 2: Run the focused test and verify it fails**

Run:

```bash
node --test tests/skills/maintain-project-knowledge.test.mjs
```

Expected: FAIL because the seventh reference does not exist and the root Skill does not route deep-domain decisions.

- [ ] **Step 3: Create the minimal normative reference**

Create `deep-domain-calibration.md` with these exact sections and normative boundaries:

```markdown
# Deep Domain Calibration

Use this reference when one candidate domain shows material complexity, the user explicitly asks for deeper domain thinking, an authorized domain-deepening pass has finished and the whole map needs consistency review, or a capability needs semantic content-quality review before promotion. Complexity is assessed per candidate domain.

## Recommendation, Not Autonomy

A signal recommends deeper calibration; it never authorizes starting it. Explain the domain, evidence, inference, risk, recommended mode, and expected decision, then let the user choose Brainstorming, Grill Me, the built-in equivalent, defer, or continue lightly. An explicit user request for one mode is already consent for that mode.

One approval covers the current mode and domain branch. Ask again only to switch modes, install a global capability, materially change the candidate, resolve cross-domain impact, confirm the boundary, or promote semantic truth.

## Domain Signals and Mode Selection

Recommend Brainstorming when two or more material decompositions are plausible, purpose or extension direction is unresolved, hierarchy choices change routing, repository layout conflicts with business capabilities, or a discovery could reshape the map.

Recommend Grill Me when a candidate already exists but ownership, dependencies, parentage, shared constraints, conflicting evidence, tacit business knowledge, or another high-impact assumption needs pressure-testing. Investigate project evidence first, then ask one question at a time and provide a recommended answer with its main trade-off.

Do not start a full deep workflow for wording, formatting, translation, index repair, one locally answerable fact, or an accepted design with no reopened design question. Ask one focused question when only one bounded fact is missing.

## Capability Resolution and Built-In Fallback

Resolve an external capability only after the user chooses a mode. If it is absent, offer global installation only when the host has a native installer and an exact trusted plugin source is known. Name the source, global scope, and reload boundary. Installation requires separate explicit approval.

If installation is declined, unsupported, unsuccessful, untrusted, or not discoverable in the current session, continue with the built-in equivalent. Built-in exploration presents two or three approaches, trade-offs, a recommendation, and staged approval. Built-in pressure-testing investigates first, asks one question at a time with a recommended answer, and resolves dependent decisions. Never edit a plugin cache or copy Skill files as an installation substitute.

## User Intervention and Active Thinking

Preserve seven intervention points: initial coverage calibration, complexity escalation choice, approach selection, tacit-knowledge questions, domain boundary confirmation, whole-map consistency review, and current-truth promotion. Global installation is a separate authorization point.

At each point ask only the most decision-relevant question. Explain why it matters, what evidence establishes, the recommended answer, and the main cost or risk. Prompts may test owned outcome, exclusions, independent evolution, containment versus collaboration, shared ownership, unowned responsibility, known extensions, current truth versus plan, future retrieval value, and removable prose.

If the user declines deepening, continue safely without repeated persuasion, keep the risk visible, and reopen it only when new evidence or downstream impact makes it relevant. Declining deepening never approves an unverified fact.

## Two-Pass Convergence

First create a lightweight whole-project candidate map, assess each domain, deepen only authorized domains, and confirm their boundaries. Then audit the complete candidate map for missing capabilities, overlap, unowned responsibility, false hierarchy, hidden horizontal dependencies, unclear shared ownership, extensions that do not fit, and undeclared downstream impact. Reopen only affected domains and require user review for material findings.

## Transient Reasoning and Semantic Quality

Complexity assessments, discarded alternatives, full reasoning chains, and reasoning transcripts remain transient. Persist only accepted skeletons, verified facts, concise rationale that affects future routing, and explicit gaps or limits.

Before `current`, require boundary clarity, durable fact coverage, evidence quality, relationship clarity, extension readiness, and concision. Do not combine them into a numeric score. A failed critical gate leaves the asset absent or non-current.

Do not create a complexity score, interview log, or persistent calibration state. Do not duplicate map, Feedback, PRD, test-report, delivery, or other domain bodies.
```

- [ ] **Step 4: Add the one-reference-at-a-time root route**

Add this row to the `Reference Routing` table in `SKILL.md`, between bootstrap and materialization:

```markdown
| Explain domain complexity, honor an explicit deep-thinking request, run whole-map consistency review, or review semantic content quality | [Deep domain calibration](references/deep-domain-calibration.md) |
```

Add this sentence after the table so ordinary work stays bounded:

```markdown
Complexity is assessed per candidate domain. Load deep calibration only for an explained recommendation, an explicit user request, the authorized second pass, or semantic quality review; a clear domain continues through the ordinary focused reference.
```

Do not add a primary route, stop code, machine-readable field, or lifecycle state.

- [ ] **Step 5: Run the focused Skill tests**

Run:

```bash
node --test tests/skills/maintain-project-knowledge.test.mjs
```

Expected: PASS, including exactly seven direct references and no instruction to preload the whole reference set.

- [ ] **Step 6: Commit the protocol boundary**

```bash
git add skills/maintain-project-knowledge/SKILL.md skills/maintain-project-knowledge/references/deep-domain-calibration.md tests/skills/maintain-project-knowledge.test.mjs
git commit -m "feat: add user-controlled domain calibration"
```

---

### Task 2: Connect user consent, two-pass convergence, and Gold behavior

**Files:**
- Modify: `skills/maintain-project-knowledge/references/bootstrap-and-calibration.md`
- Modify: `tests/skills/maintain-project-knowledge.test.mjs`
- Modify: `tests/behavior/gold/scenarios.json`
- Modify: `tests/behavior/gold.test.mjs`

**Interfaces:**
- Consumes: the Task 1 deep-calibration reference and existing Domain Candidate Card contract.
- Produces: an initial per-domain recommendation gate and a final whole-map consistency gate before writing a complex calibrated skeleton.
- Reuses: the existing Gold scenario fields, `NEEDS_USER`, human-gate validation, acceptable solution range, and completion-unit checks; introduces no Gold schema field.

- [ ] **Step 1: Write failing bootstrap and Gold assertions**

Extend the Skill contract test with exact bootstrap assertions:

```js
test('keeps deep calibration user-controlled and runs a bounded second pass', async () => {
  const bootstrap = await readFile(
    new URL('../../skills/maintain-project-knowledge/references/bootstrap-and-calibration.md', import.meta.url),
    'utf8',
  );

  assert.match(bootstrap, /Assess complexity separately for each candidate domain\./);
  assert.match(bootstrap, /recommend a mode and wait for the user's choice/i);
  assert.match(bootstrap, /Run the whole-map consistency review after authorized domain deepening\./);
  assert.match(bootstrap, /reopen only affected domains/i);
  assert.match(bootstrap, /declines deepening.*does not approve.*current/is);
});
```

Add a Gold contract test:

```js
test('gates complex calibration without forcing deepening on every domain', () => {
  const complex = scenarios.find(({ scenario_id: id }) => id === 'reconnaissance-calibration');
  const evidenceClear = scenarios.find(({ scenario_id: id }) => id === 'professional-domain-materialization');

  assert.ok(complex.required_human_gates.includes('DEEP_CALIBRATION_CONSENT'));
  assert.ok(complex.required_human_gates.includes('WHOLE_MAP_CONSISTENCY_REVIEW'));
  assert.ok(complex.completion_unit_ids.includes('unit:whole-map-consistency-review'));
  assert.ok(complex.required_durable_files.every((path) => !/brainstorm|calibration-log|interview/u.test(path)));
  assert.equal(evidenceClear.required_human_gates.includes('DEEP_CALIBRATION_CONSENT'), false);
});
```

- [ ] **Step 2: Run both test files and verify failure**

Run:

```bash
node --test tests/skills/maintain-project-knowledge.test.mjs tests/behavior/gold.test.mjs
```

Expected: FAIL because bootstrap lacks per-domain recommendation and second-pass language, and the reconnaissance Gold scenario lacks the two new human gates.

- [ ] **Step 3: Add the bounded domain-assessment and second-pass contract**

Add a `## Domain Complexity and User Choice` section after `Domain Candidate Card` in `bootstrap-and-calibration.md`:

```markdown
## Domain Complexity and User Choice

Assess complexity separately for each candidate domain. Keep the assessment transient. When a signal exists, show the evidence, inference, downstream risk, recommended deep mode, and expected decision, then recommend a mode and wait for the user's choice. Do not start Brainstorming or Grill Me from a signal alone; an explicit user request is already consent.

If the user declines deepening, continue with the verified boundary work, preserve the smallest material unknown, and do not repeatedly persuade. A user who declines deepening does not approve an unsupported fact as `current`.
```

Add this section before `Allowed Writes`:

```markdown
## Whole-Map Consistency Review

Run the whole-map consistency review after authorized domain deepening and before writing a new or materially changed complex skeleton. Check missing capabilities, overlapping or unowned responsibility, false parent-child containment, hidden horizontal dependencies, shared ownership, known extensions, and undeclared downstream impact.

Present material findings for user review. When a finding changes a semantic boundary, reopen only affected domains; unrelated confirmed knowledge remains usable. A simple evidence-clear map still receives the bounded coverage check but does not require an artificial deep-calibration session.
```

Keep the existing initial calibration and explicit boundary-confirmation gates intact.

- [ ] **Step 4: Strengthen only the reconnaissance Gold scenario**

In the `reconnaissance-calibration` scenario, use these exact additions:

```json
"required_human_gates": [
  "DEEP_CALIBRATION_CONSENT",
  "INITIAL_CALIBRATION",
  "WHOLE_MAP_CONSISTENCY_REVIEW"
],
"supplied_approval_refs": [
  "approval:deep-calibration",
  "approval:initial-calibration",
  "approval:whole-map-review"
],
"completion_unit_ids": [
  "unit:calibration-invitation",
  "unit:confirmed-map-skeleton",
  "unit:whole-map-consistency-review"
]
```

Mirror the approval refs and human gates in `positive_path.observation`, and add `unit:whole-map-consistency-review` to its completed units. Change the adversarial path to prove the consent gate fails closed:

```json
"adversarial_path": {
  "expected_result": "FAIL",
  "critical_error": "MISSING_HUMAN_GATE",
  "observation": {
    "observed_human_gates": [
      "INITIAL_CALIBRATION",
      "WHOLE_MAP_CONSISTENCY_REVIEW"
    ]
  }
}
```

Do not add a transcript or deep-calibration file to `required_durable_files`. Leave `professional-domain-materialization` without `DEEP_CALIBRATION_CONSENT` so the suite proves the protocol is not globally mandatory.

- [ ] **Step 5: Run focused contract and behavior tests**

Run:

```bash
node --test tests/skills/maintain-project-knowledge.test.mjs tests/behavior/gold.test.mjs
```

Expected: PASS. The reconnaissance positive path must include both new human gates; the adversarial path must fail with `MISSING_HUMAN_GATE`; the evidence-clear materialization scenario must remain valid without a deepening gate.

- [ ] **Step 6: Commit user-agency and convergence behavior**

```bash
git add skills/maintain-project-knowledge/references/bootstrap-and-calibration.md tests/skills/maintain-project-knowledge.test.mjs tests/behavior/gold/scenarios.json tests/behavior/gold.test.mjs
git commit -m "test: gate deep domain calibration behavior"
```

---

### Task 3: Enforce semantic content quality and improve the bilingual template

**Files:**
- Modify: `skills/maintain-project-knowledge/references/materialization.md`
- Modify: `skills/maintain-project-knowledge/assets/capability-en.md`
- Modify: `skills/maintain-project-knowledge/assets/capability.md`
- Modify: `tests/knowledge/materialization.test.mjs`

**Interfaces:**
- Consumes: one confirmed domain, authoritative evidence, the accepted baseline, the existing bilingual-pair contract, and Task 1's six semantic quality dimensions.
- Produces: either one concise evidence-backed bilingual `current` capability pair or a non-current/absent asset with the smallest actionable gap.
- Preserves: the existing six Frontmatter fields, eight canonical section headings, fact identity rules, generated indexes, and atomic write boundary.

- [ ] **Step 1: Write failing semantic-quality and template-guidance tests**

Add a reference URL beside the existing template URLs:

```js
const materializationReferenceUrl = new URL(
  '../../skills/maintain-project-knowledge/references/materialization.md',
  import.meta.url,
);
```

Add these tests after the existing template-shape test:

```js
test('requires all six semantic content gates before current promotion', async () => {
  const reference = await readFile(materializationReferenceUrl, 'utf8');
  for (const gate of [
    'Boundary clarity',
    'Durable fact coverage',
    'Evidence quality',
    'Relationship clarity',
    'Extension readiness',
    'Concision',
  ]) {
    assert.match(reference, new RegExp(`\\*\\*${gate}:\\*\\*`));
  }
  assert.match(reference, /must pass all six/i);
  assert.match(reference, /Do not combine.*numeric score/i);
  assert.match(reference, /failed critical gate.*absent or non-current/i);
});

test('capability templates prompt for precise boundaries, evidence, limits, and deduplication', async () => {
  const english = await readFile(englishTemplatePath, 'utf8');
  const chinese = await readFile(chineseTemplatePath, 'utf8');

  for (const phrase of ['included and excluded scope', 'evidence references', 'verification baseline', 'link instead of duplicating']) {
    assert.match(english, new RegExp(phrase, 'i'));
  }
  for (const phrase of ['包含与排除范围', '证据引用', '验证基线', '通过链接而不是复制']) {
    assert.match(chinese, new RegExp(phrase));
  }
});
```

- [ ] **Step 2: Run the materialization test and verify failure**

Run:

```bash
node --test tests/knowledge/materialization.test.mjs
```

Expected: FAIL because the materialization reference has no named six-gate section and the templates do not contain the precise authoring prompts.

- [ ] **Step 3: Add the semantic quality gate to materialization**

Insert this section before `Truth and Bilingual Gates` in `materialization.md`:

```markdown
## Semantic Content Quality Gate

A candidate must pass all six semantic gates before promotion to `current`:

1. **Boundary clarity:** purpose, included and excluded scope, and distinction from parent and peer domains are understandable.
2. **Durable fact coverage:** stable facts likely to support future retrieval and decisions are present without placeholder prose.
3. **Evidence quality:** every current fact has supporting evidence, a verification baseline, and limits proportional to risk.
4. **Relationship clarity:** canonical owner, parentage, major dependencies, shared constraints, and repository ownership are explicit.
5. **Extension readiness:** stable identities, likely change seams, known extensions, unknowns, and unresolved risks are clear.
6. **Concision:** link instead of duplicating map, Feedback, PRD, test-report, delivery, or other domain bodies.

Do not combine these gates into a numeric score. A failed critical gate leaves the asset absent or non-current and reports the smallest actionable gap. User acceptance of risk does not turn unsupported content into verified truth. Structural validation cannot override this semantic review.
```

- [ ] **Step 4: Tighten authoring guidance without changing template structure**

Replace only the instructional sentences under the existing eight headings. Keep all Frontmatter keys and headings unchanged. The English instructions must include:

```markdown
## Purpose and current boundary

State the owned outcome, included and excluded scope, and the distinction from parent and peer domains.

## Current facts

Add only durable facts. For each independently addressable fact, retain its stable ID and revision, current statement, evidence references, verification baseline, and explicit limits. Do not fill missing knowledge with placeholder prose.

## System and data relationships

Describe only the containment, horizontal collaboration, shared data, interfaces, and constraints that affect this capability.

## Implementation and resource map

List the smallest stable implementation and resource entry points; link instead of duplicating implementation prose.

## Quality state

State verified coverage, supporting checks, and any unmet semantic quality gate.

## Dependencies

Identify the canonical owner and declared major dependencies used for routing.

## Known limits and unknowns

State evidence-bounded limits, confidence limits, known extension seams, unknowns, and unresolved risks.

## Provenance

Summarize authoritative evidence and human decisions without copying Feedback, PRD, test-report, delivery, or historical bodies.
```

Write the Chinese asset as a semantic mirror using these corresponding terms: `包含与排除范围`, `证据引用`, `验证基线`, and `通过链接而不是复制`. Do not translate stable IDs, state values, or machine fields.

- [ ] **Step 5: Run materialization and bilingual contract tests**

Run:

```bash
node --test tests/knowledge/materialization.test.mjs tests/contracts/bilingual-pair.test.mjs tests/contracts/fact-blocks.test.mjs
```

Expected: PASS. The templates still expose exactly six Frontmatter fields and eight canonical sections, and the new semantic guidance is present in both languages.

- [ ] **Step 6: Commit the quality gate and paired template**

```bash
git add skills/maintain-project-knowledge/references/materialization.md skills/maintain-project-knowledge/assets/capability-en.md skills/maintain-project-knowledge/assets/capability.md tests/knowledge/materialization.test.mjs
git commit -m "feat: strengthen capability knowledge quality"
```

---

### Task 4: Run cross-contract verification and review gates

**Files:**
- Modify only if a focused test or review exposes a defect in Tasks 1-3; keep every repair within the approved design scope.

**Interfaces:**
- Consumes: the three committed task deliverables.
- Produces: a clean candidate branch with passing focused, full, bundle, and review gates.

- [ ] **Step 1: Run the complete focused suite together**

```bash
node --test tests/skills/maintain-project-knowledge.test.mjs tests/behavior/gold.test.mjs tests/knowledge/materialization.test.mjs tests/contracts/bilingual-pair.test.mjs tests/contracts/fact-blocks.test.mjs
```

Expected: PASS with no skipped or cancelled tests.

- [ ] **Step 2: Run the full repository gate**

```bash
npm run check
```

Expected: all Node tests pass, fixtures validate, and the privacy check passes.

- [ ] **Step 3: Rebuild and verify the distributable bundle**

```bash
npm run check:bundle
```

Expected: bundle build and clean managed-plugin-copy test pass, and the new reference is included through the existing recursive `skills` copy.

- [ ] **Step 4: Check diff hygiene and scope**

```bash
git diff --check codex/hierarchical-knowledge-index...HEAD
git status --short
git diff --stat codex/hierarchical-knowledge-index...HEAD
```

Expected: no whitespace errors; no uncommitted files; changes limited to the approved design, Skill/reference, paired template, and relevant tests.

- [ ] **Step 5: Run the required Codex review gate**

```bash
codex review --base codex/hierarchical-knowledge-index "Review only the deep-domain-calibration change. Check user consent boundaries, one-reference-at-a-time routing, optional global-install safety, transient-versus-durable knowledge, bilingual template alignment, Gold behavior validity, and regression risk."
```

Expected: no unresolved actionable findings. For each valid finding, add the smallest reproducing test, fix it, rerun the focused suite plus `npm run check`, and commit with a narrowly scoped message.

- [ ] **Step 6: Run the narrow security review required by global-install guidance**

Invoke `codex-security:security-diff-scan` against `codex/hierarchical-knowledge-index...HEAD`, scoped to plugin-install consent, trusted-source wording, cache-edit prohibition, and unintended external-write authority.

Expected: no validated blocking finding. Fix any validated issue surgically, rerun the affected tests and `npm run check`, then commit the repair.

- [ ] **Step 7: Record the final verified state**

```bash
git status --short --branch
git log --oneline --decorate codex/hierarchical-knowledge-index..HEAD
```

Expected: clean `codex/deep-domain-calibration` worktree and an intentional commit series for protocol, behavior, quality, and any review repair. Do not push or alter the globally installed marketplace in this plan.
