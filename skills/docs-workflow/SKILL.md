---
name: docs-workflow
description: "Route and maintain product documentation for iterative product work. Use before creating or updating PRDs, architecture docs, development guidance, batch logs, test reports, changelogs, feedback notes, or product-doc indexes. Reads the product INDEX first, chooses the correct output path, preserves bilingual pairs when required, and updates the index after changes."
---

# Docs Workflow

Use this skill before producing or changing product documentation.

The skill has two responsibilities:

1. Write product docs to the correct durable location.
2. Guide the agent through the product-iteration flow and identify candidate supporting capabilities.

This skill does not dispatch other skills or tools. The agent remains responsible for choosing and invoking the right supporting capabilities.

## Default Documentation Tree

Assume product docs live under:

```text
docs/product/<product>/
├── INDEX.md
├── README.md
├── requirements/
├── architecture/
├── development/
│   ├── guidance/
│   ├── batches/
│   └── changelog/
├── test-reports/
└── feedback/
```

If the host repo documents a different tree, follow the repo's documented structure and keep the same workflow principles.

## Workflow

1. Read project instructions and the product `INDEX.md`.
2. Identify the current product, version, stage, and document type.
3. Classify the iteration signal: feedback, requirements, architecture, guidance, batch execution, verification, changelog, or retro.
4. Choose the output path from the routing table below.
5. Create or update the product doc with the smallest necessary change.
6. Update `INDEX.md` for new links, changed status, feedback references, and revision tracking.
7. Verify naming, links, index consistency, and bilingual counterparts when the repo requires them.

## Naming Conventions

| Prefix type | Pattern | Meaning | Example |
| --- | --- | --- | --- |
| Product overview | `<product>-v<N>-*` | Whole-version baseline | `desktop-app-v1-prd.md` |
| Stage delta | `<stage>-v<N>-*` | Stage-specific product detail | `review-v1-guidance.md` |
| Feedback | `feedback-<topic>` | Cross-stage feedback record | `feedback-permissions.md` |

Rules:

- Test reports use `<stage>-v<N>-test-report.md`.
- Changelogs use `<stage>-v<N>-changelog.md`.
- Do not add date suffixes unless the host repo explicitly requires them.
- If the repo requires bilingual docs, update the primary file and its `-en` counterpart together.

## Routing Table

| Work type | Candidate capabilities | Output location |
| --- | --- | --- |
| Feedback analysis | feature-request analysis, interview summarization, sentiment analysis, brainstorming | `feedback/feedback-<topic>.md` |
| Product requirements | PRD writing, feature prioritization, user stories, job stories, brainstorming | `requirements/<product>-v<N>-prd.md` or `requirements/<stage>-v<N>-prd.md` |
| Architecture | architecture tradeoff analysis, brainstorming, systematic debugging | `architecture/<product>-v<N>-architecture.md` or `architecture/<stage>-v<N>-architecture.md` |
| Reverse revision | design confirmation, consistency review | update overview docs and `INDEX.md` revision tracking |
| Development guidance | user stories, assumptions, pre-mortem, brainstorming | `development/guidance/<stage>-v<N>-guidance.md` |
| Batch execution record | implementation planning, TDD, execution, subagent workflow when explicitly requested | `development/batches/<stage>-v<N>-batch-log.md` |
| Test verification | test scenarios, intended-vs-implemented review, verification | `test-reports/<stage>-v<N>-test-report.md` |
| Delivery retro or release notes | release notes, retro, shipping artifacts, code review workflow | `development/changelog/<stage>-v<N>-changelog.md` |

## Multi-Batch Stages

At the start of each implementation batch, decide whether unresolved design work exists.

Unresolved design work includes:

- new data model fields
- new interface shape
- new permission, privacy, or security boundary
- architectural tradeoffs with multiple valid approaches

If unresolved design exists, complete design discussion first, then write an implementation plan, then execute with tests.

If the batch only wires existing contracts or performs routine implementation, skip design discussion and proceed directly to the implementation plan and test-driven execution.

The test is whether design is undecided, not whether the batch is early or late in the stage.

## Guidance vs Plan Boundary

Keep long-lived product guidance separate from temporary execution plans.

| Document | Location | Answers | Lifecycle |
| --- | --- | --- | --- |
| Development guidance | `docs/product/<product>/development/guidance/` | What and why | Durable, stage-level |
| Implementation plan | repo-specific tool workspace | How | Temporary, batch-level |

Do not duplicate plan details into product guidance. Guidance should define goals, constraints, boundaries, and acceptance criteria. Plans should define file paths, test steps, and execution order.

## INDEX Maintenance

After every product-doc change:

- Add or update the stage row for changed stage docs.
- Add feedback entries for new feedback notes.
- Add revision-tracking rows when overview docs change.
- Confirm links point to existing files.
- Confirm bilingual counterparts are listed together when required.

## Hard Constraints

- Do not create product docs outside the documented product-doc tree.
- Do not leave `INDEX.md` stale after changing product docs.
- Do not claim bilingual sync unless both files were updated or verified unchanged.
- Do not hide uncertainty about the target stage, version, or document type; ask or infer from `INDEX.md` and state the assumption.
- Keep edits surgical and avoid unrelated doc reorganization.
