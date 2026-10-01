# Bootstrap and Calibration

Use this reference when no accepted project map or resolvable project pointer exists, when a possible domain is discovered, or when user feedback reopens a boundary.

## Bootstrap Entry

Check the fixed `docs/project-lifecycle/` namespace first. Reuse an accepted map in a single repository or governance root. Resolve a compact pointer only for a participating repository in a multi-repository project. When neither exists, do not scan the machine, invent a global registry, ask the user to choose a lifecycle path, or assume directory names are knowledge domains.

After user confirmation, bootstrap may establish the fixed root, the initial `project-map.json`, the single bounded `pending-changes.json` review ledger, paired generated indexes, and the `knowledge/` and `delivery/` directories. Do not create an empty project-extension registry.

Bootstrap schema v2 directly. Create both lifecycle-root indexes and the repository-local Knowledge-root indexes. For a confirmed parent with children, create its direct-child index directory even when the parent does not meet the materialization threshold; do not create a placeholder body or promote it to `current`.

If inspection finds a coherent v1 flat knowledge tree, report the exact move/reference plan and external-link risks, then ask once for migration approval. For multiple repositories, bind every registered owner to its explicit local repository root during inspection. After approval, the internal migration moves the whole accepted bilingual layout atomically, rewrites managed references, publishes repository shards before the governance map, removes old canonical copies, and verifies the v2 result. An ordinary temporary question performs no migration and no durable write.

Inspect delivery independently through `delivery/layout.json`. A missing marker plus flat delivery pairs requires `run-prd-lifecycle` to run `preview-delivery-layout-migration`; knowledge bootstrap must not perform the durable migration itself. The preview binds a selected solution ID, plan hash, source fingerprint, owner mappings, and external-link risks. An ambiguous or missing physical owner returns `NEEDS_USER`. Only after explicit approval and a recoverable backup reference may `run-prd-lifecycle` perform the durable migration, validate the published v2 tree, and roll back on failure.

## Lightweight Evidence Pack

Inspect only high-signal evidence needed to propose boundaries:

- project instructions, intent, and overview documents;
- repository and module topology;
- manifests plus build, runtime, test, and deployment entry points;
- existing product, architecture, design, test, or knowledge indexes;
- observable behavior and stable interfaces or resources;
- a small, relevant slice of recent evolution evidence;
- explicit constraints and user-provided project knowledge.

Separate observations, inferences, unknowns, confidence limits, and the next smallest evidence request. Historical requirements, plans, or tests are candidate evidence, not proof of implemented current state. Stop broad exploration once the pack supports candidate cards.

## Domain Candidate Card

Present one candidate at a time with:

- a user-understandable proposed name, kind, semantic ID, purpose, and scope;
- observed evidence and exact project locations;
- inferred boundary, parent, and likely cross-domain relationships;
- explicit unknowns and confidence limits;
- the smallest next evidence worth inspecting.

The user may confirm, rename, split, merge, reject, or defer it. Confirmation authorizes only the boundary skeleton. It does not verify individual facts or justify a formal knowledge document.

## Domain Complexity and User Choice

Assess complexity separately for each candidate domain. Keep the assessment transient. When a signal exists, show the evidence, inference, downstream risk, recommended deep mode, and expected decision, then recommend a mode and wait for the user's choice. Do not start Brainstorming or Grill Me from a signal alone; an explicit user request is already consent.

If the user declines deepening, continue with the verified boundary work, preserve the smallest material unknown, and do not repeatedly persuade. A user who declines deepening does not approve an unsupported fact as `current`.

<!-- deep-calibration-bootstrap-contract
complexity_scope: per-domain
signal_action: recommend-and-wait
explicit_request: authorized
decline:
  progress: verified-only
  current_promotion: evidence-required
  repeated_persuasion: forbidden
second_pass:
  timing: after-authorized-deepening
  write_gate: before-complex-skeleton
  reopen: affected-only
-->

## Calibration Gates

After presenting the initial candidate map and coverage assessment, stop until the user corrects it or explicitly says to continue. Before that response, explain evidence and refine questions but do not begin bulk domain materialization.

Invite correction using real goals, business boundaries, hidden dependencies, and missing domains. Later corrections reopen only affected boundaries, shared facts, constraints, and dependent assets; unrelated confirmed knowledge remains usable. New user input becomes evidence for a candidate, never current truth by itself.

## Business-to-Implementation Alignment Feedback

When the user explicitly confirms that an implemented capability is obsolete, invalid, or outside the accepted business model, keep `KNOWLEDGE_UPDATE` as the controlling route. Record the accepted business decision and the still-observed implementation as separate claims, create or reuse one bilingual Feedback pair with the controlled alignment marker, synchronize the active alignment projection, and return control to knowledge construction or maintenance.

The bounded handoff obeys this contract:

```text
Feedback captured != PRD materialized != delivery started
```

It creates no PRD or non-PRD owner, Context Receipt, batch, worktree, code change, or test run. `pending-changes.json` remains knowledge-only and never becomes the remediation backlog. During initial bootstrap, collect active items for one bounded closing review. During later maintenance, review the current maintenance batch. If the user requests immediate remediation, capture Feedback first and then present the smallest defensible owner boundary for confirmation. Immediate safety, security, destructive-data, or compliance risk receives immediate attention without silently authorizing delivery.

Reuse an existing Feedback only when its immutable original problem is semantically the same. If equivalence or the meaning of “deprecated” remains material, use the temporary user stop instead of guessing or duplicating the record.

## Whole-Map Consistency Review

Run the whole-map consistency review after authorized domain deepening and before writing a new or materially changed complex skeleton. Check missing capabilities, overlapping or unowned responsibility, false parent-child containment, hidden horizontal dependencies, shared ownership, known extensions, and undeclared downstream impact.

Present material findings for user review. When a finding changes a semantic boundary, reopen only affected domains; unrelated confirmed knowledge remains usable. A simple evidence-clear map still receives the bounded coverage check but does not require an artificial deep-calibration session.

## Allowed Writes

After explicit boundary confirmation, write only the compact skeleton: immutable stable ID, localized label and purpose, kind, scope, state, parent and major relationships, compact evidence pointers, known gaps, and asset links only if already materialized. Keep product, architecture, implementation, test, and delivery prose out of the map.

In multi-repository projects, keep one governance map. Register each repository's portable locator and domain ownership centrally, but create each materialized body and its Knowledge shard only in the owning repository.

### Bounded example

Repository folders named `desktop`, `api`, and `shared` do not automatically become domains. Evidence may support a user-understandable `wiki-workspace` candidate spanning those folders. After the user confirms its boundary, add the skeleton to the map, then stop; create no Wiki capability document until its own facts meet the materialization gate.
