# Owner-Centric Delivery Layout Design

Status: Approved

Date: 2026-08-27

Repository: `jiuchuanll/project-lifecycle`

Primary route: `NON_PRD_DELIVERY`

Selected solution ID: `solution-owner-centric-delivery-layout-v2`

Chinese mirror: [2026-08-27-owner-centric-delivery-layout-design.zh-CN.md](./2026-08-27-owner-centric-delivery-layout-design.zh-CN.md)

## Objective

Replace the flat `docs/project-lifecycle/delivery/` namespace with an owner-centric hierarchy that remains readable and deterministically navigable as Feedback, PRD, non-PRD, architecture, guidance, batch, test, and closure assets accumulate. Preserve Feedback-to-owner many-to-many relationships, bilingual pairing, evidence retention, archive gates, and atomic migration from the legacy layout.

## Problem

The current materializer writes every durable delivery asset directly beneath `docs/project-lifecycle/delivery/` as `<artifact-id>-en.md` and `<artifact-id>.md`. This preserves a knowledge-versus-delivery boundary but loses the internal structure of a delivery. As the number of PRDs grows, unrelated owners and phases share one directory, human browsing becomes noisy, an Agent must reconstruct ownership from many files, and retention or migration logic cannot operate on one bounded owner subtree.

The first `docs-workflow` design separated requirements, architecture, development guidance, batch logs, test reports, changelogs, and Feedback. The new lifecycle needs that clarity while retaining the stronger durable-owner model introduced later. A purely type-centric tree would still force one PRD continuation to read across several global directories. The selected design therefore uses Feedback and generated views as global categories while grouping delivery-process assets beneath one physical PRD or non-PRD owner.

## Confirmed Principles

- Every delivery-process asset has exactly one physical durable owner.
- A PRD or non-PRD delivery is the physical owner of its architecture, guidance, batch, test-report, and closure assets.
- Feedback remains physically independent because Feedback and delivery owners have a many-to-many relationship.
- Semantic cross-owner relationships remain in Frontmatter and do not create multiple physical copies.
- Stable cross-PRD truths leave delivery through the accepted Knowledge Diff flow rather than becoming permanent shared delivery documents.
- Generated activity views are isolated from authoritative or manually maintained assets.
- Directory names use stable IDs, not localized titles, dates, or mutable lifecycle states.
- English remains the Agent-default asset; English and Chinese logical pairs change together and remain in the same directory.
- Existing projects migrate only through an explicit, previewed, atomic operation.

## Canonical Layout

The canonical active layout is:

```text
docs/project-lifecycle/delivery/
├── layout.json
├── INDEX.md
├── INDEX-en.md
├── feedback/
│   ├── feedback-<id>.md
│   └── feedback-<id>-en.md
├── prds/
│   └── prd-<id>/
│       ├── INDEX.md
│       ├── INDEX-en.md
│       ├── prd-<id>.md
│       ├── prd-<id>-en.md
│       ├── architecture/
│       ├── guidance/
│       ├── batches/
│       ├── test-reports/
│       └── closure/
├── non-prd/
│   └── <delivery-id>/
│       ├── INDEX.md
│       ├── INDEX-en.md
│       ├── <delivery-id>.md
│       ├── <delivery-id>-en.md
│       ├── architecture/
│       ├── guidance/
│       ├── batches/
│       ├── test-reports/
│       └── closure/
└── views/
    ├── alignment-review.md
    └── alignment-review-en.md
```

Empty optional phase directories are not required. They appear only when the owner has a justified asset of that kind. The root and owner `INDEX` pairs are generated from validated Frontmatter and filesystem inventory; users and Agents do not maintain them manually.

### Deterministic Placement

| Artifact kind | Canonical active location |
| --- | --- |
| `feedback` | `delivery/feedback/<artifact-id>{-en,}.md` |
| `prd` | `delivery/prds/<artifact-id>/<artifact-id>{-en,}.md` |
| `non-prd-delivery` | `delivery/non-prd/<artifact-id>/<artifact-id>{-en,}.md` |
| `architecture` | `<owner-root>/architecture/<artifact-id>{-en,}.md` |
| `guidance` | `<owner-root>/guidance/<artifact-id>{-en,}.md` |
| `batch` | `<owner-root>/batches/<artifact-id>{-en,}.md` |
| `test-report` | `<owner-root>/test-reports/<artifact-id>{-en,}.md` |
| `closure-summary` | `<owner-root>/closure/<artifact-id>{-en,}.md` |
| generated alignment view | `delivery/views/alignment-review{-en,}.md` |

The materializer computes these paths from validated machine fields. Callers cannot supply an arbitrary target locator.

## Physical Ownership Contract

Add `owner_artifact_id` to delivery Frontmatter.

- A `prd` or `non-prd-delivery` root sets `owner_artifact_id` to its own `artifact_id`.
- `architecture`, `guidance`, `batch`, `test-report`, and `closure-summary` require the unique owning PRD or non-PRD ID.
- `feedback` must not set `owner_artifact_id` because its physical location is owner-independent.
- `relationships.prd_ids` continues to express semantic relationships and may contain multiple IDs. It no longer determines physical placement.
- A child asset whose owner does not exist, has the wrong kind, is closed against an invalid transition, or conflicts with its relationship fields is rejected before any write.

One physical owner does not prohibit cross-owner references. A changed contract used by several PRDs may be owned by the PRD that introduces it and referenced by dependent PRDs. If the contract becomes accepted current truth, closure hands it to `maintain-project-knowledge`; delivery does not retain a duplicate shared authority.

## Active, Closed, and Archived State

While an owner is active, its root document and all justified phase assets remain under its canonical owner directory. The generated owner index reports status, Feedback coverage, available assets, and the next legal lifecycle action.

After an owner is accepted, rejected, cancelled, or withdrawn:

1. Keep the canonical owner directory at the same stable path.
2. Retain only its generated index and compact bilingual closure summary in default delivery retrieval.
3. Move the root owner body and detailed phase evidence to the mirrored archive subtree:

   ```text
   docs/project-lifecycle/archive/delivery/prds/<prd-id>/
   docs/project-lifecycle/archive/delivery/non-prd/<delivery-id>/
   ```

4. Record archive locators, outcome, acceptance, exact evidence, Feedback coverage, residual risks, and Knowledge Diff disposition in the retained closure summary and generated index.
5. Require an archive receipt before later reading detailed archived bodies.

This keeps stable owner identity visible without allowing completed process bodies to pollute default retrieval. Lifecycle state never appears in the owner directory name.

Active, deferred, or still-covered Feedback remains under `delivery/feedback/`. After every required owner has an accepted closure and the corresponding Knowledge Diff or no-change result is resolved, the Feedback pair moves to `archive/delivery/feedback/`. Completed Feedback contributes no row to the generated alignment view.

## Layout Version Contract

`docs/project-lifecycle/delivery/layout.json` is a machine-owned physical-layout declaration:

```json
{
  "schema_version": 1,
  "layout_version": 2
}
```

It records no migration progress, chat history, owner state, or execution chronology.

- No layout file plus flat delivery Markdown means legacy layout detection.
- `layout_version: 2` permits only the canonical hierarchy.
- A mixed flat-and-hierarchical write layout is invalid.
- The migration publishes `layout.json` only after all moves, managed-reference rewrites, indexes, and validations succeed.
- `project-map.json` remains responsible for project identity, domains, knowledge topology, and routing; it does not acquire delivery filesystem state.

## Explicit Migration

Migration is a separate authorized operation, never an automatic side effect of plugin upgrade, asset creation, index generation, or ordinary lifecycle continuation.

### Preview

The migration first performs a read-only bounded inventory of active and archived delivery roots. It returns:

- exact old and proposed new locators;
- artifact IDs, kinds, languages, and proposed physical owners;
- managed references that can be rewritten deterministically;
- external Markdown reference risks represented by scheme, authority, and target hash without returning raw URLs;
- incomplete bilingual pairs, duplicate IDs, invalid Frontmatter, unsafe paths, and ambiguous owners;
- the exact write, move, and removal set.

Preview creates no directories, layout marker, indexes, backups, or document changes.

### Legacy Owner Inference

Only evidence-backed mappings are allowed:

- `feedback` maps to `delivery/feedback/`.
- `prd` owns itself beneath `delivery/prds/<artifact-id>/`.
- `non-prd-delivery` owns itself beneath `delivery/non-prd/<artifact-id>/`.
- A process child with exactly one valid `relationships.prd_ids` entry may use that PRD as owner.
- A closure summary uses its validated closure payload `owner_artifact_id`.
- The generated alignment view maps to `delivery/views/`.
- Missing, multiple, or contradictory owner candidates produce `NEEDS_USER`; filename similarity is not evidence.

The user must explicitly confirm the complete migration plan, including every supplied owner mapping, before execution.

### Atomic Execution

Execution stages validated files in a bounded temporary location, rewrites only verified managed references, generates all required indexes, and validates the complete projected tree. Only then does it publish the hierarchy and `layout.json` and remove legacy canonical copies. Any failure restores the exact pre-migration state and reports the incomplete stage.

The migration creates no symlinks, redirect stubs, permanent duplicate bodies, or indefinite dual-write compatibility. Archived flat assets migrate in the same operation so active and archived trees cannot use different physical contracts.

## Read and Write Compatibility

The new runtime may detect and inventory the legacy flat layout to produce a migration preview. It must not add new assets to the old layout. A lifecycle request against an unmigrated legacy project stops with the migration requirement before durable delivery writes.

After `layout_version: 2` is present, all materialization, update, index, retention, archive discovery, alignment projection, and closure logic uses only the hierarchical resolver. Compatibility is intentionally read-for-migration, not permanent dual writing.

## Index and Retrieval Behavior

The root delivery index separates:

- active PRD owners;
- active non-PRD owners;
- retained closed-owner summaries;
- active Feedback;
- generated activity views.

Each owner index links only the validated assets physically owned by that owner, plus semantic cross-owner and Feedback relationships from Frontmatter. Recursive discovery has explicit maximum depth, file count, file size, realpath containment, and symlink rejection. Unknown Markdown or JSON files inside managed delivery directories fail validation instead of being silently ignored.

Default context selection reads the root index, the selected owner index, and only the minimum required active assets. It does not recursively load sibling owners or archived bodies.

## Failure Handling and Safety

- Reject half-created bilingual pairs and machine-field divergence.
- Reject missing, ambiguous, or incompatible owner IDs before path calculation.
- Reject path traversal, absolute asset locators, symlinked managed roots, realpath escapes, duplicate IDs, and excessive inventory.
- Reject mixed layout versions and layout markers that disagree with the filesystem.
- Preserve source hashes, artifact IDs, relationships, evidence references, and managed link targets through migration.
- Do not delete a legacy file until its new pair and all affected indexes validate.
- Keep preview and validation read-only.
- Treat user confirmation of the design, migration plan, migration execution, delivery acceptance, and knowledge writeback as separate gates.

## Validation and Acceptance

Implementation must cover at least:

1. Deterministic paths for every artifact kind and both languages.
2. Root owners self-own and every process child resolves to one valid owner.
3. Feedback many-to-many relationships do not alter its independent path.
4. Semantic cross-owner references do not create duplicate physical files.
5. English and Chinese pairs share a directory and identical machine fields.
6. Root and owner indexes render active owners, closed summaries, Feedback, and views without scanning unrelated bodies into context.
7. Closure retains a compact summary while moving detailed bodies to the mirrored archive.
8. Archived details require a valid archive receipt for retrieval.
9. Legacy preview performs no write and reports the exact proposed mutation set.
10. Ambiguous legacy ownership stops with `NEEDS_USER`.
11. Explicit migration preserves IDs, relationships, bodies, hashes, and managed references.
12. A forced mid-migration failure restores the byte-identical legacy tree and publishes no layout marker.
13. Mixed layouts, path traversal, symlink escape, duplicate IDs, excessive depth, unknown managed files, and incomplete pairs are rejected.
14. Alignment views are generated only under `delivery/views/` and contain no completed history.
15. Installed-cache entrypoints can detect, preview, migrate, validate, materialize, close, and index without repository `node_modules`.
16. Existing route, Feedback immutability, closure, retention, Knowledge Diff, and bilingual behavior tests continue to pass.

## Implementation Boundary

The implementation should introduce one shared delivery path resolver and use it everywhere rather than duplicating path rules across commands. It may update the delivery Frontmatter schema, materialization, index discovery, alignment projection, closure and retention, archive discovery, fixtures, behavior scenarios, installed CLI surface, README tree, and both lifecycle Skill references.

The change must not redesign route vocabulary, Feedback semantics, Knowledge Diff authority, project-map topology, obligation behavior, or human acceptance gates. It must not migrate any user's project during repository tests or plugin installation.

## Recovery

Before executing migration on a real project, retain a verified recoverable snapshot outside the target tree or use the repository's existing recoverable version-control state. The migration result must report the backup or recovery reference, layout version, exact moved paths, validation result, and any unresolved external links. Recovery restores the pre-migration tree and removes the unpublished or invalid v2 layout marker; it never rewrites unrelated project assets.
