# Project Lifecycle

[简体中文](README.zh-CN.md)

Project Lifecycle is a shared, host-neutral plugin for building low-noise,
traceable project knowledge and running a separate PRD delivery lifecycle. It
keeps durable knowledge in the project repository and keeps delivery work from
silently becoming accepted project truth.

> [!IMPORTANT]
> Version `0.1.0` is a private **non-release candidate**. The package and
> retained conformance evidence are available for evaluation, but no native
> host currently satisfies the release support gate. Do not create a first
> release tag or treat the installation guides as production-support claims.

## What the plugin provides

Project Lifecycle separates two related workflows:

| Need | Shared Skill | Result |
| --- | --- | --- |
| Build or update durable project knowledge | `maintain-project-knowledge` | A confirmed project map, bilingual capability knowledge, bounded pending changes, and low-noise context routing under `docs/project-lifecycle/` |
| Turn feedback into an implementable and testable delivery | `run-prd-lifecycle` | Feedback, PRD, architecture, development guidance, implementation batches, test evidence, closure, and an explicit knowledge diff |

The shared Skills are authoritative. Codex, Claude Code, Cursor, Kimi Code,
and ZCode integrations contain installation and tool-mapping differences only.

Core rules:

- The project map is a compact routing and ownership index, not a second
  knowledge body.
- English and Chinese assets are one logical pair and must advance together.
- Only verified and accepted facts enter current knowledge. Delivery prose is
  never copied into the knowledge base automatically.
- Important topology, constraint identity, baseline, conflict, and
  parallel-delivery decisions require explicit user review.
- Agents read the smallest sufficient context first and access archived
  material only through an explicit, receipt-bound request.

## Quick start

Prerequisites:

- Node.js 22 or newer for the bundled validator.
- One of the five target hosts. Use a disposable profile while this version
  remains a non-release candidate.
- A project repository in which `docs/project-lifecycle/` may be created.

1. Follow the native guide for your host in
   [Installation and host guides](#installation-and-host-guides).
2. Reload the host and verify that both `maintain-project-knowledge` and
   `run-prd-lifecycle` are discoverable.
3. Verify the bundled CLI:

   ```text
   bin/project-lifecycle version
   bin/project-lifecycle help
   ```

4. Start with a natural-language request. For example:

   ```text
   Inspect this project with a bounded evidence pass, propose an initial
   capability map, and ask me to calibrate it before materializing knowledge.
   ```

   ```text
   Record this feedback, route it against the current project knowledge, and
   help me decide whether it needs a PRD delivery lifecycle.
   ```

On a new project, the knowledge workflow performs a lightweight evidence pass,
proposes a capability map, and waits for user calibration before bulk
materialization. On an existing project, it routes from the current map and
reads only the context needed for the task.

## Project assets

The lifecycle root is fixed and is not user-configurable:

```text
docs/project-lifecycle/
├── project-map.json        # machine-readable routing and ownership map
├── pending-changes.json    # bounded review ledger; not current truth
├── INDEX.md                # generated Chinese navigation mirror
├── INDEX-en.md             # generated Agent-default navigation
├── knowledge/              # paired durable capability knowledge
└── delivery/               # PRD-bound delivery assets and runtime records
```

Capability knowledge may be split by a user-understandable domain and then by
specific capability. Frontend, backend, testing, or another implementation
concern can have separate paired documents when they have independent facts,
owners, or change cadence. `project-map.json` keeps those documents connected
without merging their bodies.

The typical lifecycle is:

```text
feedback -> route -> PRD/delivery assets -> implementation and tests -> closure
         -> reviewed knowledge diff -> accepted project knowledge
```

Delivery runtime files remain PRD-bound and are cleaned at closure according to
their retention policy. Historical delivery assets remain evidence; they do not
become default retrieval context.

## Validator CLI

The release archive includes `dist/project-lifecycle.mjs` and the executable
`bin/project-lifecycle`; the managed plugin copy requires no dependency install.
The CLI emits one JSON result object and provides these commands:

- `collect-evidence`
- `validate-json`
- `validate-pair`
- `parse-facts`
- `validate-fixtures`
- `version` and `help`

Use `bin/project-lifecycle help` to inspect the available command set. The
validator enforces structural contracts such as schema shape, IDs, references,
bilingual pairing, fact blocks, and fixture integrity; it does not replace
Agent judgment or human approval of product meaning.

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

## Installation and host guides

- [Codex installation and removal](integrations/codex/README.md)
- [Claude Code installation and removal](integrations/claude/README.md)
- [Cursor installation and removal](integrations/cursor/README.md)
- [Kimi Code installation and removal](integrations/kimi/README.md)
- [ZCode installation and removal](integrations/zcode/README.md)

Use the exact tested host versions from the matrix when repeating native
conformance. Installation instructions describe discovery mechanics only; they
do not override the evidence status above.

## Development and verification

```text
npm ci
npm run check
npm run check:bundle
```

`npm run check` runs the contract and behavior suites, validates fixtures, and
applies the privacy gate. `npm run check:bundle` rebuilds and verifies the
self-contained validator. On a clean candidate tree,
`node scripts/package-release.mjs` rebuilds the deterministic archive and
checksum.

## Trust boundaries and known limitations

- Codex and Kimi currently fail the complete retained native run set. A later
  bounded remediation regression passed Codex 4/4 and Kimi 6/6 affected
  scenario families, but it does not replace the complete support gate.
- Claude Code, Cursor, and ZCode have no retained native run evidence.
- The host is responsible for authenticating external approvals and controlling
  any model or network transport. References, receipts, and hashes bind local
  decisions but do not authenticate a human by themselves.
- Hostile concurrent filesystem mutation and crash durability are outside the
  documented sole-writer boundary.
- KnowledgeVault consumer migration is audit-only until one host is supported
  and both shared Skills are discovered natively. See the
  [migration recipe](docs/migrations/knowledgevault-agent-app.md).

See [RELEASE-NOTES.md](RELEASE-NOTES.md) for the exact 0.1.0 candidate scope.
