# Archive Retrieval

Use this reference only when current knowledge, task-linked active delivery, and the relevant closed summary cannot answer a bounded audit, regression, incident, explicit-ID, or historical-comparison question.

## Default Retrieval Order

1. Read current project and capability knowledge.
2. Read only task-linked active delivery metadata or evidence.
3. Read the relevant immutable closed summary.
4. Stop if those layers answer the question.
5. Otherwise prepare and validate one Archive Access Receipt before reading any archived body.

Indexes and normal routing exclude archive paths and bodies. An archive catalog may expose compact identity, status, hash, and locator metadata only; it is not a fact or relationship owner.

## Receipt Gate

The receipt must identify the task, one allowed reason (`AUDIT`, `REGRESSION`, `INCIDENT`, `EXPLICIT_ID`, or `HISTORICAL_COMPARISON`), the exact question, why current knowledge and the closed summary are insufficient, exact artifact IDs, and a bounded domain scope. Validate it with the shared Phase 1 contract.

Reject missing or unknown reasons, globs, directory targets, recursive reads, unsorted or duplicate IDs, and unbounded artifact sets. The controlled resolver returns only approved artifacts. Record returned IDs and content hashes so unchanged content is reused within the task.

Any scope expansion requires a new receipt. Repeated expansion or a cross-domain archive request requires explicit user confirmation. A receipt is task-local and temporary unless retrieved content materially affects an accepted product decision, incident conclusion, or knowledge change; then retain only the necessary resolvable evidence reference, not an archive-body copy.

The gate controls compliance and writeback claims; it does not claim that an unrestricted filesystem is physically isolated. If archive content changes a knowledge candidate, it still passes ordinary evidence, ownership, bilingual, topology, conflict, and human-review gates.

### Bounded examples

- A regression asks which accepted layout behavior changed. Current knowledge and the closed summary lack the former acceptance evidence, so a receipt names one prior layout PRD and the Wiki domain; the resolver returns only that artifact.
- “Read all old PRDs for context” has no bounded question or IDs. Stop without reading archive bodies and ask for the decision or artifact to investigate.
