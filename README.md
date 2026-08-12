# Project Lifecycle

[简体中文](README.zh-CN.md)

[![CI](https://github.com/jiuchuanll/project-lifecycle/actions/workflows/ci.yml/badge.svg?branch=develop)](https://github.com/jiuchuanll/project-lifecycle/actions/workflows/ci.yml?query=branch%3Adevelop)
[![License: Apache-2.0](https://img.shields.io/badge/License-Apache--2.0-blue.svg)](LICENSE)
[![Status: pre-release](https://img.shields.io/badge/status-pre--release-orange.svg)](#project-status)

Project Lifecycle is a shared, host-neutral plugin for building low-noise,
traceable project knowledge and running a separate PRD delivery lifecycle. It
keeps durable knowledge in the project repository and keeps delivery work from
silently becoming accepted project truth.

## Project status

> [!IMPORTANT]
> This repository is open source, but version `0.4.0` remains a **pre-release
> evaluation candidate**. It is not published to npm, and no native host
> currently satisfies the release support gate. Treat the installation guides
> as evaluation instructions, not production-support claims.

The source, deterministic release archive, and retained conformance evidence
are public for inspection and contribution. Support claims remain bound to the
[evidence-backed support matrix](#support-matrix).

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
- Schema-v2 `parent_id` is the only vertical-topology source. Generated
  directories and indexes are navigation views, never competing topology.
- English and Chinese assets are one logical pair and must advance together.
- Only verified and accepted facts enter current knowledge. Delivery prose is
  never copied into the knowledge base automatically.
- Important topology, constraint identity, baseline, conflict, and
  parallel-delivery decisions require explicit user review.
- Domain complexity is assessed per candidate domain. Complexity signals may
  recommend deeper thinking, but never start brainstorming or Grill Me without
  the user's choice.
- Installing a missing deep-thinking capability requires separate approval for
  the exact trusted global source; declining or failing installation selects the
  bounded built-in equivalent instead of blocking calibration.
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
├── knowledge/
│   ├── INDEX.md            # generated Chinese Knowledge-root/shard index
│   ├── INDEX-en.md         # generated English Knowledge-root/shard index
│   └── <parent>/
│       ├── INDEX.md        # generated direct-child navigation
│       ├── INDEX-en.md
│       ├── <parent>.md     # optional only when the parent is materialized
│       ├── <parent>-en.md
│       └── <child>-en.md   # recursive child bodies share the parent directory
└── delivery/               # PRD-bound delivery assets and runtime records
```

Canonical body locations are computed from map topology. A top-level leaf is
`knowledge/<id>-en.md`; a node with children owns
`knowledge/<ancestor...>/<id>/<id>-en.md`, and descendants recurse beneath that
directory. Chinese files use the same path without `-en`. A confirmed parent
may have a directory and index without a body until it independently satisfies
the materialization gate.

In multi-repository projects, governance identity stays in one map while each
repository keeps its implementation knowledge in a local Knowledge shard.
Cross-repository indexes use registered portable locators; bodies are not
copied into governance. Filesystem-backed index generation reads only the
active shard. An Agent routes with the accepted governance map, the authenticated
current repository identity, and explicit authenticated roots for additional
selected owners; missing roots remain portable-locator handoffs.

Existing `0.1.0` flat knowledge trees require one explicit migration approval.
The Agent previews moves and external-link risks, then invokes the internal
atomic migration, preserving bilingual content and managed references while
removing old canonical copies. There is intentionally no public migration CLI,
schema-v1 registry, redirect stub, symlink, or duplicate body.

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

## Contributing

Contributions are welcome. Read [CONTRIBUTING.md](CONTRIBUTING.md) before
opening a pull request, and use the
[issue tracker](https://github.com/jiuchuanll/project-lifecycle/issues) for
reproducible bugs or bounded feature proposals.

- Target normal contributions at `develop`.
- Include tests and synchronized English/Chinese documentation when behavior
  or user-facing guidance changes.
- Do not commit credentials, private data, generated local state, or
  machine-specific paths.
- Protected branches require the `check` status, owner review, and resolved
  review conversations before merge.

## License

Project Lifecycle is licensed under the [Apache License 2.0](LICENSE).

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

See [RELEASE-NOTES.md](RELEASE-NOTES.md) for the exact 0.4.0 candidate scope and upgrade notes.
