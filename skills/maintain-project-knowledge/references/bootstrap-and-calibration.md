# Bootstrap and Calibration

Use this reference when no accepted project map or resolvable project pointer exists, when a possible domain is discovered, or when user feedback reopens a boundary.

## Bootstrap Entry

Check the fixed `docs/project-lifecycle/` namespace first. Reuse an accepted map in a single repository or governance root. Resolve a compact pointer only for a participating repository in a multi-repository project. When neither exists, do not scan the machine, invent a global registry, ask the user to choose a lifecycle path, or assume directory names are knowledge domains.

After user confirmation, bootstrap may establish the fixed root, the initial `project-map.json`, the single bounded `pending-changes.json` review ledger, paired generated indexes, and the `knowledge/` and `delivery/` directories. Do not create an empty project-extension registry.

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

## Calibration Gates

After presenting the initial candidate map and coverage assessment, stop until the user corrects it or explicitly says to continue. Before that response, explain evidence and refine questions but do not begin bulk domain materialization.

Invite correction using real goals, business boundaries, hidden dependencies, and missing domains. Later corrections reopen only affected boundaries, shared facts, constraints, and dependent assets; unrelated confirmed knowledge remains usable. New user input becomes evidence for a candidate, never current truth by itself.

## Allowed Writes

After explicit boundary confirmation, write only the compact skeleton: immutable stable ID, localized label and purpose, kind, scope, state, parent and major relationships, compact evidence pointers, known gaps, and asset links only if already materialized. Keep product, architecture, implementation, test, and delivery prose out of the map.

### Bounded example

Repository folders named `desktop`, `api`, and `shared` do not automatically become domains. Evidence may support a user-understandable `wiki-workspace` candidate spanning those folders. After the user confirms its boundary, add the skeleton to the map, then stop; create no Wiki capability document until its own facts meet the materialization gate.
