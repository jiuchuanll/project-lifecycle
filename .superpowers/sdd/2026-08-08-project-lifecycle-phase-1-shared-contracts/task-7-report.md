# Task 7 Report: Fixture Validation and Privacy Gates

## Status

Complete. The Phase 1 aggregate fixture validator and tracked-file privacy gate are implemented and wired into the existing `npm run check` command.

## RED / GREEN Evidence

### RED 1: missing aggregate and privacy commands

- Command: `node --test tests/cli/validate-fixtures.test.mjs tests/cli/privacy.test.mjs`
- Result: failed 5/5 with exit code 1.
- Expected failures:
  - `validate-fixtures` reached `CLI_UNKNOWN_COMMAND` and exited 2.
  - The privacy checks failed because `scripts/check-privacy.mjs` did not exist.
- Interpretation: the tests exercised the requested CLI surfaces before either implementation existed.

### GREEN 1: minimum aggregate and privacy implementation

- Command: `node --test tests/cli/validate-fixtures.test.mjs tests/cli/privacy.test.mjs`
- Result: passed 5/5 with exit code 0.
- Covered: declared positive and negative fixture results, deterministic path sorting, unlisted fixture rejection without content echo, duplicate manifest path rejection, redacted privacy categories and line numbers, tracked-file exclusions, and the clean repository scan.

### RED 2: explicit-root symlink boundary

- Self-review found that a listed fixture symlink could follow an explicitly declared path outside the fixture root.
- Command: `node --test tests/cli/validate-fixtures.test.mjs`
- Result: failed 1/4 with exit code 1; the new escape case exited 0 instead of 1.
- Interpretation: lexical fixture-root checks alone did not preserve the explicit-root boundary.

### GREEN 2: realpath-bounded fixture reads

- Added the minimum realpath check for existing listed fixture paths and included symlinks in the unlisted path inventory.
- Command: `node --test tests/cli/validate-fixtures.test.mjs tests/cli/privacy.test.mjs`
- Result: passed 6/6 with exit code 0.

## Fixture Gate

- `tests/fixtures/manifest.json` contains 19 sorted declarations covering the existing handoff JSON, bilingual pair, and project-map fixture sets.
- Each declaration names its fixture path, validator kind, and expected result code.
- The aggregate command reads fixture contents only through manifest-declared paths and emits one JSON summary sorted by fixture path.
- Directory enumeration reads names and file types only to detect unlisted files; `.gitkeep` is the sole fixture placeholder exclusion.
- Duplicate primary fixture paths fail before validator execution.
- Existing declared paths are checked against the real explicit fixture root, so a symlink cannot redirect content reads outside it.

## Privacy Scan Scope and Exclusions

- The scan root is explicit: the command argument when supplied, otherwise the current repository root used by the package script.
- Candidate files come only from `git ls-files -z` for that root.
- `.git/`, `node_modules/`, and `.privacy-test-tmp/` path segments are excluded. The last exclusion bounds the test's intentionally bad temporary material.
- Tracked symbolic links are not followed; files containing a NUL byte are not decoded.
- Findings contain only relative tracked path, line number, and redacted category code. Matched content is never placed in output.
- The isolated bad-repository test covers all three required categories while asserting that none of the matched values appear in stdout or stderr.

## Files

- `scripts/validate-fixtures.mjs`
- `scripts/check-privacy.mjs`
- `scripts/bin/project-lifecycle.mjs`
- `tests/fixtures/manifest.json`
- `tests/cli/validate-fixtures.test.mjs`
- `tests/cli/privacy.test.mjs`
- `.superpowers/sdd/2026-08-08-project-lifecycle-phase-1-shared-contracts/task-7-report.md`

`package.json` and `package-lock.json` were not changed because the required scripts were already present at the accepted Task 6 baseline.

## Verification

- `node --check` passed for both new scripts and both new test files.
- Focused Task 7 tests passed 6/6.
- `npm run check` passed:
  - `npm test`: 143/143 passed.
  - `npm run validate:fixtures`: 19/19 declarations matched.
  - `npm run check:privacy`: passed on the final staged set of 68 tracked text files.
- `git diff --cached --check` passed on the staged Task 7 set before commit.

## Phase 1 Self-Review

- The manifest invokes the existing canonical JSON and bilingual validators; it does not duplicate schema, vocabulary, fact, pair, or state logic.
- Existing full-suite tests continue to cover closed vocabularies, unknown fields, identity and references, state-conditional fields, sorting, bilingual pairing, structured fact blocks, obligation transitions, and bounded atomic writes.
- The new code adds no semantic inference, knowledge promotion, repository adapter, host behavior, product fixture body, or legacy Skill deletion.
- Fixture validation and privacy scanning are deterministic, root-bounded, and emit machine-readable summaries.
- Every changed line is confined to Task 7's aggregate gate, tests, CLI integration, manifest, or this report.

## Concerns

- No blocking concerns.
- The private-locator category is intentionally conservative for repository-shaped locators. If a later phase needs public repository URLs in tracked package content, that phase should add an explicit reviewed allowlist rather than weakening redaction or emitting matched values.
- The secret gate is a deterministic pattern gate, not an entropy-based credential scanner; broader secret detection can be layered later without changing this Phase 1 result contract.

## Fix Round 1

### Scope

- Addressed all six Important review findings only in the Task 7 aggregate fixture validator, privacy scanner, focused tests, and this report.
- Did not change schemas, shared validators, fixture bodies, package scripts, host surfaces, or later-phase behavior.
- The Minor finding for binary content without a NUL byte is deliberately not addressed in this round and remains on the final-review ledger.

### RED evidence

- Command: `node --test tests/cli/validate-fixtures.test.mjs tests/cli/privacy.test.mjs`.
- Result: failed with exit code 1; 5 passed and 24 failed across 29 tests.
- Expected failures demonstrated:
  - quoted and JSON-style secret assignments were not detected;
  - a valid tracked basename beginning with two dots was skipped;
  - manifest top-level, entry, validator, expected-code, and bilingual-input declarations were not closed or type-safe;
  - malformed entry types leaked Node stack traces instead of one JSON summary;
  - escaping and Windows-form paths reached fixture execution instead of declaration rejection;
  - canonical aliases were neither deduplicated nor used consistently for coverage and output;
  - default locale sorting disagreed with the required mixed case, punctuation, and non-ASCII order.
- After removing the previously untested aggregate exception wrapper, the real unreadable-directory inventory test failed 1/1 and emitted a stack containing its temporary locator. This proved the wrapper is required for the no-leak result contract.
- A supplementary-plane/BMP ordering pair then failed 2/2 under UTF-16 string comparison, proving that locale independence alone was insufficient for true code-point ordering.

### GREEN implementation

- Privacy root containment now rejects only an exact parent path or a parent path followed by the platform separator; valid names that merely begin with two dots are scanned.
- Secret matching accepts unquoted, quoted, and JSON-style assignments while output remains limited to category, tracked relative path, and line number.
- Manifest processing now validates a closed top-level and entry contract before inventory or execution:
  - schema version, fixture array, entry fields, field types, and expected codes are checked;
  - JSON kinds must resolve through the existing schema registry;
  - bilingual inputs contain exactly `en`, `zh-CN`, and `project_map`;
  - JSON entries cannot carry bilingual inputs.
- POSIX fixture locators are normalized before duplicate detection, coverage, execution, and result output. Escapes, absolute paths, backslashes, and Windows drive forms are rejected at their declaration paths.
- Manifest, inventory, sort, and entry-shape failures produce one stable JSON summary without exception text, source content, or matched values.
- Fixture and privacy ordering compare Unicode code points directly, including supplementary-plane characters, without locale-dependent APIs.

### GREEN evidence

- Focused command: `node --test tests/cli/validate-fixtures.test.mjs tests/cli/privacy.test.mjs` — passed 30/30.
- `npm test` — passed 167/167.
- `npm run check` — passed against the final staged round with 167/167 tests, 19/19 fixture declarations, and a clean privacy scan of 68 tracked text files.
- `node --check` passed for both changed scripts and both changed test files.
- `git diff --check` and `git diff --cached --check` passed before commit.

### Fix Round 1 self-review and concerns

- Confirmed declaration failures stop before inventory and validator execution, and a JSON kind typo cannot claim an expected schema error.
- Confirmed canonical aliases collapse to one identity, while a legitimate basename beginning with two dots remains inside the scan root.
- Confirmed all sensitive test values are assembled at runtime and none appear in scanner output.
- Confirmed result ordering covers mixed case, punctuation, BMP non-ASCII, and supplementary-plane characters.
- No blocking concerns remain for the six Important findings.
- Final-review ledger: the scanner currently treats NUL-containing files as binary. A binary file without a NUL byte can still be decoded as text; this scoped Minor remains intentionally unresolved.
