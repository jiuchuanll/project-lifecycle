# Deep Domain Calibration Design

Status: Approved

Date: 2026-08-11

Selected solution: `solution:deep-domain-calibration-protocol`

Chinese mirror: [2026-08-11-deep-domain-calibration-design.zh-CN.md](./2026-08-11-deep-domain-calibration-design.zh-CN.md)

## Objective

Improve `maintain-project-knowledge` so that it recognizes complexity per candidate domain, helps the user think through difficult boundaries and relationships, and produces complete, concise, evidence-backed knowledge without taking semantic decisions away from the user.

The Skill may recommend `superpowers:brainstorming`, `grill-me`, or a built-in equivalent protocol. It must not start an interactive deep-thinking workflow merely because a complexity signal exists. The user chooses whether and how to deepen the domain.

## Confirmed Decisions

- Assess complexity per domain, not by classifying the whole project as simple or complex.
- Treat complexity conditions as recommendation signals. They do not authorize automatic invocation of an external Skill.
- Respect an explicit user request to use Brainstorming or Grill Me without asking the same consent question again.
- Use Brainstorming when multiple materially different domain models need comparison.
- Use Grill Me when a candidate model exists but high-impact assumptions require pressure-testing or user knowledge.
- Allow Brainstorming to hand off to Grill Me only when important unknowns remain after approach selection.
- Ask before installing any missing global capability. Consent to deepen a domain is not consent to modify the global plugin environment.
- If installation is declined, unsupported, unsuccessful, untrusted, or not active in the current session, use the built-in equivalent protocol.
- Preserve user agency when deepening is declined. Continue safely, record the unresolved risk, and do not promote insufficiently verified knowledge to `current`.
- Use two-pass convergence: deepen selected domains individually, then audit the complete candidate map for cross-domain consistency.
- Keep reasoning and interview transcripts transient. Persist only accepted boundaries, verified facts, concise durable decision rationale, and unresolved gaps that affect future work.
- Add a semantic quality gate before a capability asset becomes `current`; structural validation alone is insufficient.
- Keep `project-map.json` authoritative for topology and routing. Do not add a complexity score, interview log, global fact index, or new persistent workflow-state file.

## Scope

This design changes the interactive contract of `maintain-project-knowledge` during bootstrap, calibration, topology reconsideration, and capability materialization. It adds one focused reference for deep domain calibration and connects it to the existing lifecycle only when a domain signal or explicit user request makes it relevant.

The change also strengthens behavioral scenarios and materialization guidance. It does not build a deterministic domain classifier, add a long-lived reasoning store, modify the project-map schema, duplicate external Skills, or make plugin installation a prerequisite for knowledge construction.

## Protocol Boundary

Add `skills/maintain-project-knowledge/references/deep-domain-calibration.md` as the single owner of:

- domain-level complexity signals;
- user escalation consent;
- Brainstorming, Grill Me, and built-in-mode routing;
- capability discovery and installation consent;
- the seven user intervention points;
- active-thinking prompts;
- the two-pass convergence audit; and
- the semantic content-quality review.

`bootstrap-and-calibration.md` continues to own evidence collection, candidate cards, and boundary confirmation. `materialization.md` continues to own evidence thresholds, truth state, bilingual assets, and promotion to `current`. The new protocol coordinates deeper reasoning between those owners without becoming a new knowledge or topology owner.

The main Skill loads the deep-calibration reference only when a complexity recommendation must be explained, the user requests deeper reasoning, or the second-pass audit is due. Ordinary clear-boundary work must remain lightweight.

## Domain-Level Complexity Signals

The Agent performs a bounded risk scan for each candidate domain. The scan is analytical preparation, not an autonomous decision about the final topology.

Recommend Brainstorming when one or more of these conditions apply:

- two or more materially different decompositions are plausible;
- the purpose, boundary, or known extension direction is unresolved;
- parent-child, sibling, or single-domain modeling would produce different future routing;
- repository/module layout conflicts with user or business capabilities;
- a newly discovered capability could materially reshape the accepted map; or
- the user says the project understanding or solution space needs broader exploration.

Recommend Grill Me when one or more of these conditions apply:

- the user already supplied a map or preferred decomposition that needs pressure-testing;
- authoritative project evidence cannot settle a high-impact business boundary;
- ownership, dependency, parentage, shared constraints, or propagation remains disputed;
- evidence conflicts or depends on tacit organizational knowledge;
- a wrong answer would materially affect future knowledge routing, PRDs, architecture, or delivery; or
- Brainstorming selected an approach but left a high-impact assumption unresolved.

Do not recommend a full deep workflow for wording, formatting, translation, index repair, a single locally answerable fact, or work under an already accepted design with no newly opened design question. Ask one focused question when only one bounded fact is missing.

## Recommendation and Consent Gate

When a signal exists, the Agent first presents:

1. the affected domain;
2. the observed evidence and explicit inference;
3. the complexity signal and downstream risk;
4. the recommended mode and what it is expected to resolve; and
5. the available choices: recommended external Skill, the other deep mode when applicable, built-in mode, defer, or continue lightly.

The Agent then waits for the user's choice. It must not frame the recommendation as a completed decision.

One approval covers the selected mode for the current domain and current calibration branch. Do not ask again for every minor question. Ask again only when switching from Brainstorming to Grill Me, installing a global capability, materially changing the candidate, exposing cross-domain impact, confirming the boundary, or promoting facts to `current`.

If the user declines deepening, continue without repeated persuasion. Keep the unresolved risk visible and reopen it only when new evidence appears or it begins to affect a later decision. Acknowledging a risk never substitutes for fact verification.

## Deep-Reasoning Modes

### Brainstorming

Use Brainstorming to explore a solution space. It must:

- establish the domain's intended user or business outcome;
- present two or three materially distinct domain models;
- compare scope, ownership, dependencies, extensibility, and maintenance cost;
- recommend one model with reasons and explicit trade-offs; and
- obtain user confirmation section by section before treating the model as selected.

### Grill Me

Use Grill Me to pressure-test a candidate. It must:

- investigate code and documents before asking the user;
- ask one question at a time;
- explain why the question matters now;
- provide a recommended answer and its main trade-off;
- follow dependencies between decisions until high-impact branches are resolved; and
- stop when shared understanding is sufficient for the next gate.

### Built-In Equivalent

The built-in mode preserves the same interaction semantics without claiming that an unavailable external Skill ran. Its exploration form presents alternatives, trade-offs, a recommendation, and staged approval. Its pressure-test form investigates first, asks one question at a time with a recommended answer, and resolves dependent decisions.

The built-in mode is a first-class fallback. It may be less specialized than an installed capability, but it cannot skip the consent, evidence, user-agency, two-pass, or quality gates.

## Capability Discovery and Global Installation

Capability resolution happens only after the user chooses a deep mode.

If the selected external capability is unavailable, the Agent may offer global installation only when the host exposes a native installation mechanism and an exact trusted plugin selector or source is known. The offer must identify the capability, plugin source, global scope, and any reload requirement.

Installation requires a separate explicit approval. On approval, use the host's native plugin workflow, then re-check discovery. Do not edit a plugin cache or copy Skill files as a substitute. If discovery still fails, the source is unknown, the host is unsupported, installation fails, or the user declines, continue with the built-in protocol and report the fallback briefly.

The current knowledge task must never be blocked solely because an optional external thinking capability is absent.

## Seven User Intervention Points

1. **Initial coverage calibration:** after the lightweight candidate map, the user corrects project intent, missing business capabilities, and major boundaries.
2. **Complexity escalation offer:** after a domain signal, the user chooses whether and how to deepen.
3. **Approach selection:** after Brainstorming alternatives, the user selects, combines, modifies, rejects, or defers them.
4. **Tacit-knowledge question:** when evidence cannot answer a high-impact question, the user supplies business, team, or future-direction knowledge one question at a time.
5. **Domain boundary confirmation:** the user confirms, renames, splits, merges, rejects, or defers the candidate.
6. **Whole-map consistency review:** after the second pass, the user resolves material gaps, overlaps, hierarchy errors, shared ownership, and extension risks.
7. **Current-truth promotion:** before semantic facts become `current`, the user reviews the exact facts, evidence, limits, and affected domains.

Global installation is a separate authorization point and cannot be bundled with any of these approvals.

## Active-Thinking Prompts

At an intervention point, select only the most decision-relevant prompt. Do not dump a generic questionnaire. A prompt should include why the issue matters, what the evidence establishes, the recommended answer, and the main cost or risk of accepting it.

Useful prompts include:

- What user or business outcome does this domain own?
- What is explicitly outside its boundary?
- Can it evolve independently without changing another domain's meaning?
- Is this relationship true containment or horizontal collaboration?
- Who owns shared data, interfaces, or constraints?
- If this domain disappeared, which responsibility would become unowned?
- Where would the next known extension naturally belong?
- Is this claim implemented current truth, an accepted design, or a future plan?
- Who will retrieve this fact later, and for which decision?
- Would removing this paragraph lose reusable knowledge? If not, omit it.

The Agent may prepare and recommend; it must not silently convert its recommendation into user acceptance.

## Two-Pass Convergence

The first pass creates a lightweight project-wide candidate map, assesses each domain, deepens only the domains the user authorizes, and confirms their individual boundaries.

The second pass audits the complete candidate map for:

- missing core capabilities;
- overlapping or unowned responsibilities;
- parent-child relationships that are not true containment;
- horizontal dependencies modeled as hierarchy;
- unclear shared capability, data, constraint, or repository ownership;
- known extensions that do not fit naturally; and
- undeclared downstream impact when a domain changes.

Only affected domains reopen when the audit finds a problem. Unrelated confirmed boundaries remain usable. The user reviews material findings before the skeleton is written or changed.

## Transient Reasoning and Durable Knowledge

Complexity assessments, interview transcripts, discarded alternatives, and full chains of reasoning remain in the conversation. They do not become canonical project knowledge.

Durable writes remain limited to:

- accepted domain skeletons and relationships in `project-map.json`;
- verified current facts in bilingual capability assets;
- concise decision rationale only when it will affect future routing or interpretation; and
- explicit gaps, limits, and unknowns that affect future work.

Use existing review and pending-change mechanisms for unresolved semantic candidates. Do not create a deep-calibration log or duplicate PRD, test, implementation, or historical prose in capability documents.

## Semantic Content-Quality Gate

Before a capability asset becomes `current`, require all six gates:

1. **Boundary clarity:** purpose, inclusions, exclusions, and distinction from its parent and peers are understandable.
2. **Durable fact coverage:** the stable facts most likely to support future retrieval and decisions are present without placeholder prose.
3. **Evidence quality:** every current fact has supporting evidence, a verification baseline, and explicit limits proportional to risk.
4. **Relationship clarity:** canonical owner, parentage, major dependencies, shared constraints, and repository ownership are explicit.
5. **Extension readiness:** stable identities, likely change seams, known extensions, unknowns, and unresolved risks are clear.
6. **Concision:** the asset links instead of duplicating map, Feedback, PRD, test-report, delivery, or other domain bodies.

Do not aggregate these gates into a numeric score. A failed critical gate leaves the asset absent or non-current and reports the smallest actionable gap. Structural validation proves contract integrity but cannot override a failed semantic gate.

## Failure and Stop Handling

- If the user defers deepening, continue only within verified scope and preserve the unresolved risk.
- If evidence cannot settle a high-impact fact, stop promotion and ask one focused question or retain the gap.
- If the user declines global installation, switch to built-in mode without treating the decline as refusal to deepen.
- If installation succeeds but the capability is not discoverable in the current session, disclose the reload boundary and use built-in mode now.
- If the user declines both external and built-in deepening, do not repeatedly prompt; retain only the boundary or facts that satisfy existing gates.
- If the second pass exposes a semantic conflict, reopen only the affected domains and require user review before durable topology change.
- If a quality gate fails, do not manufacture content to fill a section and do not promote the asset to `current`.

## Implementation Boundary

The implementation should be primarily declarative and behavioral:

- add the focused deep-domain-calibration reference;
- route to it from `maintain-project-knowledge/SKILL.md`;
- connect bootstrap/calibration and materialization guidance to its consent, second-pass, and quality gates;
- refine the capability template only where necessary to make boundaries and durable facts easier to review;
- add Skill-contract and gold-behavior coverage; and
- keep English and Chinese template or design pairs synchronized.

Do not add a runtime scoring engine, a new CLI command, a schema field for complexity, or a persistent conversation ledger. Existing validators may enforce stable structural signals, but semantic intent stays with the Agent and user.

## Acceptance Criteria

- Complexity is assessed and explained per domain.
- A complexity signal produces a recommendation and consent question, not automatic external Skill invocation.
- Explicit user requests invoke the selected mode without redundant confirmation.
- Brainstorming and Grill Me have distinct, testable routing conditions.
- The built-in fallback preserves the approved interaction and quality gates.
- No global installation occurs without separate explicit approval and a trusted exact source.
- Declining deepening does not block safe progress or permit unverified current truth.
- Seven intervention points preserve user ownership of semantic decisions.
- Active-thinking prompts are focused, evidence-aware, and include a recommendation.
- The second pass catches cross-domain gaps without reopening unrelated domains.
- Reasoning transcripts do not become canonical project knowledge.
- All six semantic quality gates must pass before promotion to `current`.
- No new persistent workflow state, complexity score, or duplicate knowledge index is introduced.
- Relevant Skill-contract, behavioral, bilingual, and regression tests pass.
