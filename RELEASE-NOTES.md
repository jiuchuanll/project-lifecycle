# Project Lifecycle 0.1.0 candidate notes

Publication status: **PUBLIC PRE-RELEASE EVALUATION CANDIDATE**

Host support gate: **NON-RELEASE CANDIDATE**

This public pre-release evaluation candidate packages the two shared Skills,
five thin host manifests, bundled Node.js 22+ validator, host tool maps,
fixed-root project knowledge lifecycle, PRD delivery lifecycle,
multi-repository governance,
bounded archive access, retained Gold scenarios, and the read-only
KnowledgeVault migration recipe.

## Evidence

- Contract, delivery, knowledge, governance, bundle, fixture, privacy, and
  static-conformance gates are included in the repository phase gate.
- Codex `0.147.0-alpha.6.5`: `FAILED` with 8 retained invariant failures.
- Kimi Code `0.29.2`: `FAILED` with 15 retained invariant failures.
- Claude Code, Cursor, and ZCode: `NOT_TESTED` because native executables were
  unavailable.
- Structural passes remain pending semantic review; they are not promoted to
  host support claims.

After exposing the closed route vocabulary, compact route meanings, required
solution selection, and intent-versus-acceptance boundary in both root Skills,
a bounded remediation regression passed the latest Codex result for 4/4
affected scenario families and Kimi for 6/6. This evidence is retained in
`targeted-regression.json`; its declared support effect is `none`.

## Release blocker

A first-release tag requires all five target hosts to be `SUPPORTED` for exact
tested versions, with three retained independent runs for every Gold scenario
and completed semantic review. This candidate does not meet that gate.

## Packaging boundary

The deterministic archive contains only the explicit release surface. It
excludes source scripts, tests and raw traces, design worktrees, Git metadata,
dependency directories, obsolete `docs-workflow` Skill copies, private product
bodies, and local absolute paths. The adjacent `.sha256` file binds the archive
bytes.
