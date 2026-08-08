# Task 5 Report: Delivery Handoffs, Receipts, and Obligations

## Status

Implemented and verified on `codex/project-lifecycle-v1` from the accepted Task 1-4 baseline `5ee7a49`.

## Approved scope corrections

The brief's original file list omitted existing integration points required by its produced interfaces and CLI acceptance step. Work stopped before each out-of-scope edit, and the user explicitly approved three narrow corrections:

1. `scripts/lib/schema-registry.mjs`: import and register only the Task 5 schemas.
2. `scripts/lib/validate-json.mjs`: make `project-pointer` semantic validation an explicit branch so Task 5 schema kinds do not fall through to `/governance_locator`; existing project-map, extension, and pointer semantics were preserved.
3. `scripts/lib/validate-json.mjs`: add only deterministic Context Receipt `selected_context[].id` uniqueness and lexical-order checks with stable code/path diagnostics.

No CLI file change was needed or made.

## Implementation

- Added strict Draft 2020-12 schemas for Context Receipt, Knowledge Diff, Archive Access Receipt, owner-local obligation instances, and delivery Frontmatter.
- Registered `context-receipt`, `knowledge-diff`, `archive-access-receipt`, `obligation-instance`, and `delivery-frontmatter` with the shared strict Ajv registry.
- Added Context Receipt's five selected-context kinds, six selection reasons, five exclusion reasons, and five stop codes; `SUFFICIENT` cannot coexist with unresolved questions, while `NEEDS_USER` requires one.
- Added deterministic Context Receipt selected-ID uniqueness and lexical-order gates using `ID_DUPLICATE` or `SCHEMA_INVALID` at `/selected_context/<index>/id`.
- Added deterministic owner-local obligation ID uniqueness at `/obligations/<index>/obligation_id`.
- Added Knowledge Diff `CHANGE` / `NO_CHANGE` gates. `NO_CHANGE` requires empty operations/domain changes and non-empty evidence; `CHANGE` requires at least one fact operation or domain change.
- Added bounded Archive Access Receipts with exact artifact IDs, bounded domain scope, closed reasons, no wildcard-capable IDs, and hash-addressed returned artifacts.
- Added durable delivery Frontmatter with a required primary route, immutable creation identity field, active-only current identity field, domain IDs, baseline, typed Feedback/PRD relationships, bounded legacy and reclassification references, retention tier, and embedded owner-local obligations. `NEEDS_USER` is not accepted as a durable route.
- Added `validateObligationTransition(previous, next)` for creation, resolution, waiver, supersession, reopening, terminal status, and invalid cross-result transitions.
- Kept the four business-result statuses exactly `OPEN`, `RESOLVED`, `WAIVED`, and `SUPERSEDED`; no `IN_PROGRESS`, `BLOCKED`, or global obligation ledger was introduced.

## Interface decisions

- `validateObligationTransition(null, next)` is the creation check; creation must start `OPEN`.
- A resolved result needs evidence plus `resolution_ref`.
- A waived result needs evidence plus `human_approval_ref`; it does not require `resolution_ref`.
- A superseded result needs only qualified `successor_obligation_ref` in `owner-asset#obligation-id` form; evidence and `resolution_ref` are optional.
- Reopening `RESOLVED` or `WAIVED` requires at least one trigger absent from the previous instance and removes `resolution_ref`, `human_approval_ref`, and successor state.
- `SUPERSEDED` is terminal. Same-status updates remain valid only when the target continues to satisfy that status's result requirements.
- `validateObligationTransition(previous, next)` rejects differing obligation IDs before terminal or status checks.
- `validateDeliveryTransition(previous, next)` compares only `artifact_id` and durable `primary_route`: identity must match and the route must not change.
- Obligations are embedded in their delivery owner. The strict obligation schema has no owner/global-ledger field, so a synthetic `owner_ref` is rejected at the exact embedded path.
- Legacy delivery association is represented by bounded `relationships.legacy_artifact_refs`; Feedback and PRD relationships use separate prefix-checked stable ID arrays.

## TDD evidence

### Initial RED: missing schemas and validator

Command:

```text
node --test tests/contracts/handoffs.test.mjs tests/contracts/obligations.test.mjs
```

Result:

```text
exit 1
1..21
# tests 21
# pass 0
# fail 21
```

Valid fixtures failed because all Task 5 schema kinds were unknown, and the transition export test failed because `scripts/lib/obligations.mjs` did not exist.

### First GREEN

After adding schemas, registration, pointer dispatch correction, and transition behavior:

```text
node --test tests/contracts/handoffs.test.mjs tests/contracts/obligations.test.mjs
exit 0
1..22
# pass 22
# fail 0
```

Strict Ajv compilation exposed missing local types/property declarations in conditional branches during the GREEN loop. Those schema-construction errors were fixed without disabling strict mode.

### Hardening RED/GREEN: typed relationships and stale reopen markers

RED:

```text
exit 1
not ok 15 - rejects cross-reference IDs in the wrong typed relationship
not ok 21 - reopens a resolved or waived obligation only for a new trigger without active resolution
1..23
# pass 21
# fail 2
```

GREEN after prefix-checking Feedback/PRD IDs and forbidding all active result markers on reopened `OPEN` instances:

```text
exit 0
1..23
# pass 23
# fail 0
```

### Context Receipt semantic RED/GREEN

RED:

```text
exit 1
not ok 7 - rejects duplicate Context Receipt IDs even when selection fields differ
not ok 8 - rejects Context Receipt selections that are not ID-sorted
1..24
# pass 22
# fail 2
```

GREEN after the approved narrow semantic branch:

```text
exit 0
1..24
# pass 24
# fail 0
```

### Owner-local obligation-ID RED/GREEN

RED:

```text
exit 1
not ok 15 - rejects duplicate owner-local obligation IDs even when instance fields differ
1..25
# pass 24
# fail 1
```

GREEN after the narrow Task 5 structural check:

```text
exit 0
1..25
# pass 25
# fail 0
```

## Final verification

```text
node --test tests/contracts/handoffs.test.mjs tests/contracts/obligations.test.mjs
exit 0; 35 pass, 0 fail

node scripts/bin/project-lifecycle.mjs validate-json context-receipt tests/fixtures/contracts/handoffs/context-receipt.valid.json
exit 0; {"ok":true,...,"errors":[]}

npm test
exit 0; 114 pass, 0 fail

git diff --check
exit 0; no output
```

## Files

Created:

- `scripts/schemas/context-receipt.schema.json`
- `scripts/schemas/knowledge-diff.schema.json`
- `scripts/schemas/archive-access-receipt.schema.json`
- `scripts/schemas/obligation-instance.schema.json`
- `scripts/schemas/delivery-frontmatter.schema.json`
- `scripts/lib/obligations.mjs`
- `tests/contracts/handoffs.test.mjs`
- `tests/contracts/obligations.test.mjs`
- `tests/fixtures/contracts/handoffs/context-receipt.valid.json`
- `tests/fixtures/contracts/handoffs/knowledge-diff.valid.json`
- `tests/fixtures/contracts/handoffs/knowledge-diff.no-change.valid.json`
- `tests/fixtures/contracts/handoffs/archive-access-receipt.valid.json`
- `tests/fixtures/contracts/handoffs/delivery-frontmatter.valid.json`
- `.superpowers/sdd/2026-08-08-project-lifecycle-phase-1-shared-contracts/task-5-report.md`

Modified under explicit scope corrections:

- `scripts/lib/schema-registry.mjs`
- `scripts/lib/validate-json.mjs`

## Self-review

- Scope: no Skills, host manifests, safe-write behavior, aggregate fixture/privacy gate, CLI dispatch, global obligation ledger, remote, tag, or push changes were made.
- Strictness: every Task 5 object rejects unknown fields; arrays are bounded where they can grow; vocabulary and result states are closed.
- Result semantics: mutations removing evidence, resolution, approval, successor, new trigger, or terminal protection are covered by behavior tests with stable first error codes.
- Ownership: delivery obligations are embedded and cannot declare a global owner field.
- Routing: `NEEDS_USER` remains a temporary stop and cannot validate as durable `primary_route`.
- Relationships: Feedback/PRD IDs are prefix-typed, unique, and kept separate; legacy and reclassification references are bounded.
- Context: same-ID/different-object duplicates and unsorted selections fail at the second offending ID path.
- Owner-local identity: same-ID/different-instance obligations fail at the second offending obligation ID path.
- Mutation check: focused tests independently cover each required result field, both valid minimal terminal shapes, exact and differing-object duplicate IDs, obligation identity ordering, delivery identity, primary-route immutability, reopen cleanup, terminal status, typed relationships, and Context Receipt ordering.

## Concerns

- JSON reference arrays validate strict shape, type, uniqueness, and bounds, but external target existence needs the owning project/delivery graph context and is not claimed by these standalone schemas.
- Task 6 safe-write and Task 7 aggregate fixture/privacy gates remain intentionally out of scope.

## Fix Round 1

All four Important review findings were addressed within the existing Task 5 files.

### Finding mapping

1. **Exact result matrix**
   - `RESOLVED` requires `evidence_refs` plus `resolution_ref`.
   - `WAIVED` requires `evidence_refs` plus `human_approval_ref`; a minimal instance without `resolution_ref` passes both schema and transition validation.
   - `SUPERSEDED` requires only qualified `successor_obligation_ref`; a minimal instance with empty evidence and no `resolution_ref` passes both validators.
   - Tests assert evidence and resolution independently for `RESOLVED`, evidence and approval independently for `WAIVED`, successor independently for `SUPERSEDED`, and both minimal valid terminal shapes.
2. **Deterministic duplicate IDs**
   - Removed array-level `uniqueItems` from `selected_context` and owner-local `obligations`, because it intercepted exact duplicates before semantic ID validation.
   - Exact duplicates and same-ID/different-object duplicates now both return `ID_DUPLICATE` at the second `/selected_context/<index>/id` or `/obligations/<index>/obligation_id`.
3. **Obligation identity preservation**
   - `validateObligationTransition` compares `obligation_id` before terminal or result-state logic and returns `OBLIGATION_ID_MISMATCH` at `/obligation_id`.
4. **Durable primary-route immutability**
   - Added `validateDeliveryTransition(previous, next)` to `scripts/lib/obligations.mjs`.
   - It checks only stable `artifact_id` and unchanged `primary_route`; no reclassification or business semantics are inferred.
   - Stable failures use `DELIVERY_ID_MISMATCH` at `/artifact_id` and `PRIMARY_ROUTE_IMMUTABLE` at `/primary_route`.

### RED

```text
node --test tests/contracts/handoffs.test.mjs tests/contracts/obligations.test.mjs
exit 1
1..35
# pass 25
# fail 10
```

The ten failures were the two schema-masked exact duplicates, absent delivery-transition export and its three behavior tests, rejected minimal WAIVED/SUPERSEDED shapes, wrong SUPERSEDED first error, and obligation-ID mismatch losing to the terminal check.

### GREEN

```text
node --test tests/contracts/handoffs.test.mjs tests/contracts/obligations.test.mjs
exit 0
1..35
# pass 35
# fail 0
```
