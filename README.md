# Project Lifecycle

Project Lifecycle is a shared, platform-neutral plugin package for maintaining
project knowledge and delivery lifecycles without moving a project's source or
private knowledge out of its repository.

## Skill boundary

The package has two complementary Skills:

- `docs-workflow` governs durable product-document routing, naming, indexing,
  and verification.
- `run-prd-lifecycle` will route lifecycle requests between project knowledge
  and PRD delivery work.

Host integrations remain thin entry points. Shared Skills are the authoritative
behavioral source.

## Status and installation

This repository currently provides the Node.js 22+ validator package baseline
and the `docs-workflow` Skill. The lifecycle validator commands listed by the
CLI are introduced incrementally during Phase 1.

Install this package from its distribution channel when one is published. Until
then, use a repository checkout for development and run `npm install` followed
by `npm test`.

## Project assets

Project Lifecycle stores its fixed lifecycle assets at:

```text
docs/project-lifecycle/
```

The path is part of the plugin contract and is not configurable per project.

## Support matrix

| Surface | Current support |
| --- | --- |
| Node.js validator harness | Baseline (Node.js 22+) |
| Shared `docs-workflow` Skill | Available |
| Shared `run-prd-lifecycle` Skill | Planned |
| Codex, Claude Code, Cursor, Kimi Code, ZCode adapters | Planned |
