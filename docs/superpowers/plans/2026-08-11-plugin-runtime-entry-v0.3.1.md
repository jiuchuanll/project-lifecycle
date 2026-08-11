# Plugin Runtime Entry v0.3.1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ensure an installed Project Lifecycle plugin never requires uninstalled npm dependencies and publish the verified fix as `0.3.1`.

**Architecture:** Installed and accidental compatibility entry points execute the self-contained bundle. Repository development and bundle construction use a separately named source entry with declared npm dependencies. Both root Skills carry one machine-readable runtime contract that directs Agents to the bundled executable and forbids dependency installation inside plugin caches.

**Tech Stack:** Node.js 22 ESM, Node test runner, esbuild, Codex plugin manifests, Markdown Agent Skills.

## Global Constraints

- Do not add or vendor `node_modules` to the plugin or release archive.
- Do not run package installation inside any Codex plugin cache.
- Installed execution uses `bin/project-lifecycle`; `dist/project-lifecycle.mjs` is the explicit Node fallback.
- `scripts/bin/project-lifecycle-source.mjs` is repository-development-only.
- Preserve the two existing Skill identities and all unrelated behavior.
- Publish as immutable prerelease `v0.3.1` only after merge to `develop`.

---

### Task 1: Reproduce the cache failure and protect runtime entry behavior

**Files:**
- Modify: `tests/harnesses/bundle.test.mjs`

**Interfaces:**
- Consumes: the repository's `scripts/bin/project-lifecycle.mjs`, `bin/project-lifecycle`, and `dist/project-lifecycle.mjs`.
- Produces: a regression test that runs the compatibility path from a clean cache-shaped copy with no `node_modules`.

- [ ] **Step 1: Write the failing test**

Add a test that copies `scripts/` and `dist/project-lifecycle.mjs` into a temporary install without `node_modules`, invokes `node scripts/bin/project-lifecycle.mjs version`, and expects the normal `0.3.0` JSON envelope with empty stderr.

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/harnesses/bundle.test.mjs`

Expected: FAIL because `scripts/lib/markdown.mjs` cannot resolve `yaml`.

- [ ] **Step 3: Preserve the failing evidence**

Record that the test failed on `ERR_MODULE_NOT_FOUND` for `yaml`, proving it catches the reported cache defect.

### Task 2: Separate development source from installed compatibility execution

**Files:**
- Move: `scripts/bin/project-lifecycle.mjs` to `scripts/bin/project-lifecycle-source.mjs`
- Create: `scripts/bin/project-lifecycle.mjs`
- Modify: `scripts/lib/bundle-build.mjs`
- Modify: `package.json`
- Modify: source-CLI test call sites under `tests/`

**Interfaces:**
- Consumes: the existing CLI source module and generated bundle.
- Produces: a dependency-free compatibility entry at the old path and an explicit development source entry.

- [ ] **Step 1: Move the implementation source**

Move the current CLI implementation unchanged to `scripts/bin/project-lifecycle-source.mjs`.

- [ ] **Step 2: Add the minimal compatibility entry**

Create `scripts/bin/project-lifecycle.mjs` containing only:

```js
#!/usr/bin/env node
await import(new URL('../../dist/project-lifecycle.mjs', import.meta.url));
```

- [ ] **Step 3: Route development and build call sites to the source entry**

Update bundle construction, repository scripts, and source-oriented CLI tests to use `project-lifecycle-source.mjs`. Leave the new cache regression on `project-lifecycle.mjs`.

- [ ] **Step 4: Run focused tests**

Run: `npm run build && node --test tests/harnesses/bundle.test.mjs tests/cli/*.test.mjs tests/contracts/*.test.mjs tests/knowledge/reconnaissance.test.mjs`

Expected: PASS, including the cache-shaped no-dependency reproduction.

### Task 3: Make the Agent runtime contract explicit

**Files:**
- Modify: `skills/maintain-project-knowledge/SKILL.md`
- Modify: `skills/run-prd-lifecycle/SKILL.md`
- Modify: `tests/skills/maintain-project-knowledge.test.mjs`
- Modify: `tests/skills/run-prd-lifecycle.test.mjs`

**Interfaces:**
- Consumes: plugin-root-relative bundled CLI paths.
- Produces: identical machine-readable `plugin-runtime-contract` blocks in both Skills.

- [ ] **Step 1: Add failing contract tests**

Parse a `plugin-runtime-contract` YAML comment from each Skill and require:

```yaml
installed_cli: bin/project-lifecycle
node_fallback: dist/project-lifecycle.mjs
source_cli: repository-development-only
cache_dependency_install: forbidden
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test tests/skills/maintain-project-knowledge.test.mjs tests/skills/run-prd-lifecycle.test.mjs`

Expected: FAIL because neither Skill exposes the runtime contract.

- [ ] **Step 3: Add the minimal Skill instructions**

Add the identical contract and concise prose stating that installed execution resolves the plugin root, uses `bin/project-lifecycle`, may use `node dist/project-lifecycle.mjs` only as fallback, never invokes `scripts/`, and never installs dependencies in a cache.

- [ ] **Step 4: Validate and retest both Skills**

Run structural validation for each Skill with `quick_validate.py`, then rerun both Skill test files.

Expected: both structural validations and tests PASS.

### Task 4: Version, package, and verify `0.3.1`

**Files:**
- Modify: version-bearing manifests, package metadata, CLI version, integration notes, bilingual README files, support matrix, release notes, and version assertions.
- Regenerate: `dist/project-lifecycle.mjs`
- Replace: `dist/project-lifecycle-0.3.0.zip` and checksum with `0.3.1` assets.

**Interfaces:**
- Consumes: completed runtime-entry fix.
- Produces: synchronized `0.3.1` source, bundle, archive, and release metadata.

- [ ] **Step 1: Update all active version surfaces to `0.3.1`**

Keep historical plan text and prior release records unchanged. Add `0.3.1` release notes describing the cache-entry fix and unchanged schema/host-support boundary.

- [ ] **Step 2: Build deterministic assets**

Run: `npm run build` and the repository packaging command.

- [ ] **Step 3: Run complete verification**

Run: `npm run check`, `npm run check:bundle`, `npm run conformance:static`, `node --test tests/harnesses/release-package.test.mjs`, and `git diff --check`.

Expected: all tests pass, privacy findings are zero, bundle reports `0.3.1`, and archive checksum is deterministic.

### Task 5: Review, merge, release, and update the installed plugin

**Files:**
- No additional source files unless review finds a valid defect.

**Interfaces:**
- Consumes: verified `0.3.1` branch.
- Produces: merged PR, immutable `v0.3.1` prerelease, and develop-bound local plugin at `0.3.1`.

- [ ] **Step 1: Run Codex review and scoped security review**

Review the complete diff. Treat valid findings as blocking, fix them, and rerun affected verification.

- [ ] **Step 2: Commit, push, and open the PR**

Commit only task files, push with the review gate marker, and open a PR targeting `develop`.

- [ ] **Step 3: Verify GitHub CI and merge**

Require a successful CI run and an unchanged expected head SHA before merge.

- [ ] **Step 4: Publish immutable prerelease `v0.3.1`**

Tag the actual merge commit, upload the deterministic ZIP and checksum, and verify prerelease metadata and asset digests.

- [ ] **Step 5: Refresh the local plugin with native tooling**

Run `codex plugin marketplace upgrade project-lifecycle --json`; verify the marketplace remains on `develop`, the installed plugin is enabled at `0.3.1`, both Skills are present, and both bundled and compatibility CLI entries work without cache dependencies.
