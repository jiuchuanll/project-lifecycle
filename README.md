# Project Lifecycle

Project Lifecycle is a shared, host-neutral plugin for building low-noise,
traceable project knowledge and running a separate PRD delivery lifecycle. It
keeps project source and private knowledge in the project repository.

## Shared Skills

- `maintain-project-knowledge` bootstraps, routes, materializes, updates, and
  retrieves durable capability knowledge at `docs/project-lifecycle/`.
- `run-prd-lifecycle` routes feedback and delivery work through PRD,
  architecture, development guidance, implementation batches, tests, closure,
  and knowledge-diff absorption.

The shared Skills are authoritative. Codex, Claude Code, Cursor, Kimi Code, and
ZCode integrations contain installation and tool-mapping differences only.

## Candidate status

Version `0.1.0` is a private **non-release candidate**. The package, bundled
validator, manifests, Skills, and retained conformance evidence are available,
but no native host currently satisfies the release support gate. Do not create
a first-release tag from this matrix.

## Support matrix

This table is bound to `tests/harnesses/support-matrix.json`; packaging fails if
the README diverges from that retained evidence.

| Host | Status | Observed version | Evidence |
| --- | --- | --- | --- |
| codex | FAILED | 0.147.0-alpha.6.5 | invariant-failures:codex:8, targeted-regression:codex:4of4, trace-set:codex:ae5b5ad |
| claude | NOT_TESTED | — | availability:claude:unavailable |
| cursor | NOT_TESTED | — | availability:cursor:unavailable |
| kimi | FAILED | 0.29.2 | invariant-failures:kimi:15, targeted-regression:kimi:6of6, trace-set:kimi:ae5b5ad |
| zcode | NOT_TESTED | — | availability:zcode:unavailable |

`FAILED` means the tested native host violated one or more closed Gold
invariants. `NOT_TESTED` means no available native executable was used. Static
conformance and Skill discovery alone never produce `SUPPORTED`.

## Installation evidence and host instructions

The release archive is self-contained for Node.js 22+: it includes the bundled
validator at `dist/project-lifecycle.mjs` and requires no dependency install in
the managed plugin copy.

- [Codex installation and removal](integrations/codex/README.md)
- [Claude Code installation and removal](integrations/claude/README.md)
- [Cursor installation and removal](integrations/cursor/README.md)
- [Kimi Code installation and removal](integrations/kimi/README.md)
- [ZCode installation and removal](integrations/zcode/README.md)

These are installation instructions, not support claims. Use the exact tested
host versions from the matrix when repeating native conformance.

## Fixed project assets

Project knowledge uses the fixed root:

```text
docs/project-lifecycle/
```

Delivery runtime files remain PRD-bound and are cleaned at closure; accepted
knowledge is absorbed through explicit diffs rather than by copying PRD prose.

## Known limitations

- Native conformance currently fails on Codex and Kimi because generated routes
  in the complete retained run set frequently left the closed route vocabulary;
  one Kimi run also omitted a required selected solution. A later bounded
  remediation regression passed Codex 4/4 and Kimi 6/6 affected scenario
  families, but does not replace the complete support gate.
- Claude Code, Cursor, and ZCode have no retained native run evidence.
- External approval authentication and hostile concurrent filesystem mutation
  remain host responsibilities under the documented sole-writer boundary.
- KnowledgeVault consumer migration is audit-only until one host is supported
  and both shared Skills are discovered natively. See the
  [migration recipe](docs/migrations/knowledgevault-agent-app.md).

See [RELEASE-NOTES.md](RELEASE-NOTES.md) for the exact 0.1.0 candidate scope.
