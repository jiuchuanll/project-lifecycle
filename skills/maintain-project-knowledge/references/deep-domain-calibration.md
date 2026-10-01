# Deep Domain Calibration

Use this reference when one candidate domain shows material complexity, the user explicitly asks for deeper domain thinking, an authorized domain-deepening pass has finished and the whole map needs consistency review, or a capability needs semantic content-quality review before promotion. Complexity is assessed per candidate domain.

<!-- deep-domain-calibration-contract
scope: per-domain
invocation:
  signal_action: recommend
  explicit_request: authorized
  choices:
    - BRAINSTORMING
    - GRILL_ME
    - BUILT_IN
    - DEFER
    - CONTINUE_LIGHT
capability_install:
  authorization: separate-explicit
  source: exact-trusted
  unavailable_fallback: BUILT_IN
  cache_edit: forbidden
persistence:
  reasoning_transcripts: transient
  complexity_score: forbidden
  calibration_log: forbidden
intervention_points:
  - INITIAL_COVERAGE_CALIBRATION
  - COMPLEXITY_ESCALATION_CHOICE
  - APPROACH_SELECTION
  - TACIT_KNOWLEDGE_QUESTION
  - DOMAIN_BOUNDARY_CONFIRMATION
  - WHOLE_MAP_CONSISTENCY_REVIEW
  - CURRENT_TRUTH_PROMOTION
quality_gates:
  - BOUNDARY_CLARITY
  - DURABLE_FACT_COVERAGE
  - EVIDENCE_QUALITY
  - RELATIONSHIP_CLARITY
  - EXTENSION_READINESS
  - CONCISION
-->

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
