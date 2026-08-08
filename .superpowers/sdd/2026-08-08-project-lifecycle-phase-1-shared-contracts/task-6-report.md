# Task 6 Report: Atomic Writes and Bounded Path Safety

## Status

Complete. The task commit includes this report and uses the required subject `feat: add bounded atomic writes`.

## RED / GREEN Evidence

### RED 1: missing production module

- Command: `node --test tests/io/atomic-write.test.mjs`
- Result: failed with exit code 1.
- Expected failure: `ERR_MODULE_NOT_FOUND` for `scripts/lib/atomic-write.mjs`.
- Interpretation: the initial six behavior tests were loaded before either production module existed.

### GREEN 1: initial bounded atomic-write contract

- Command: `node --test tests/io/atomic-write.test.mjs`
- Result: passed 6/6 with exit code 0.
- Covered: successful replacement, parent traversal, absolute escape, symlinked-parent escape, validator rejection, rename failure, prior-target preservation, and exact temporary sibling cleanup.

### RED 2: final target symlink coverage

- Self-review identified that a final target symlink had implementation but no independent RED evidence.
- The untested production branch was removed before adding the test.
- Command: `node --test tests/io/atomic-write.test.mjs`
- Result: failed 1/7 with exit code 1.
- Expected failure: `Missing expected rejection` for `PATH_SYMLINK_ESCAPE`; the other six tests passed.

### GREEN 2: final target symlink rejection

- Restored the minimum `lstat` plus `realpath` check after the failing test.
- Command: `node --test tests/io/atomic-write.test.mjs`
- Result: passed 7/7 with exit code 0.

### RED 3: exclusive temporary sibling ownership

- Mutation review identified that `wx` and non-owned sibling preservation needed direct failure evidence.
- The exclusive flag was removed before adding the pre-existing sibling test.
- Command: `node --test tests/io/atomic-write.test.mjs`
- Result: failed 1/8 with exit code 1.
- Expected failure: `Missing expected rejection` for `EEXIST`; the other seven tests passed.

### GREEN 3: exclusive temporary sibling creation

- Restored the minimum `wx` open flag after the failing test.
- Command: `node --test tests/io/atomic-write.test.mjs`
- Result: passed 8/8 with exit code 0; the pre-existing sibling and previous target both remained byte-for-byte unchanged.

## Temporary Safety Boundaries

- Every test creates one sandbox using `mkdtemp(join(tmpdir(), "project-lifecycle-atomic-write-"))`.
- Each explicit allowed root is the sandbox's `allowed/` child.
- Traversal, absolute-path, and symlink escape targets remain inside the same one-test sandbox but outside `allowed/`; no test points at a repository path, home directory, or shared broad temporary root.
- Test cleanup tracks exact files, symlinks, and directories, then uses only `unlink` and bottom-up `rmdir`. It never uses recursive deletion.
- Production creates only the same-directory sibling `.<target basename>.<process ID>.tmp` with exclusive `wx` creation and mode `0600`.
- Production tracks ownership of that exact sibling. It unlinks the sibling only after this invocation created it, ignores only an already-absent sibling, and never deletes a directory or uses recursive deletion.
- If the sibling already exists, exclusive creation returns `EEXIST`; that non-owned sibling is intentionally preserved rather than made absent.

## Implementation

- `scripts/lib/safe-path.mjs`
  - Exports `resolveInside(root, candidate)`.
  - Normalizes and bounds lexical paths against the explicit root.
  - Resolves the real root and real parent directory.
  - Rejects parent-directory and final-target symlink escapes with `PATH_SYMLINK_ESCAPE`.
- `scripts/lib/atomic-write.mjs`
  - Exports `atomicWriteValidated({ root, target, content, validate })`.
  - Opens an exclusive same-directory temporary sibling, writes, fsyncs, and closes it.
  - Reads the temporary content and requires validator result `{ ok: true }` before rename.
  - Preserves an existing target on validation and rename failures and cleans only its owned temporary sibling.
- `tests/io/atomic-write.test.mjs`
  - Contains eight real-filesystem tests with no mocks.
- `tests/fixtures/io/.gitkeep`
  - Retains the Task 6 fixture boundary; runtime fixtures remain isolated `mkdtemp` sandboxes.

## Verification

- `node --check scripts/lib/safe-path.mjs` — passed.
- `node --check scripts/lib/atomic-write.mjs` — passed.
- `node --check tests/io/atomic-write.test.mjs` — passed.
- `node --test tests/io/atomic-write.test.mjs` — passed 8/8.
- `npm test` — passed 122/122.
- `git diff --cached --check` — passed immediately before commit.

## Self-review

- Confirmed lexical traversal and absolute escapes fail before any temporary path is opened.
- Confirmed real-parent and final-target symlinks cannot escape the real allowed root.
- Confirmed `wx` prevents overwriting a pre-existing temporary sibling, while the ownership flag prevents cleanup after open itself fails.
- Confirmed fsync and validation complete before rename.
- Confirmed validator errors include stable `VALIDATION_FAILED` and the supplied error list.
- Confirmed native rename failures remain native errors, the previous target remains unchanged, and absent temporary cleanup is idempotent.
- Confirmed no CLI integration, Task 7 fixture/privacy work, host manifest, remote action, or out-of-scope file was added.

## Concerns

- No blocking concerns.
- As scoped by the brief's real-parent resolution design, the allowed directory tree is assumed not to be concurrently replaced by an untrusted writer between resolution and rename. Node's path-based filesystem APIs do not provide a portable directory-file-descriptor transaction across this sequence.

## Fix Round 1

### Accepted v1 trust boundary

- The user accepted the reviewer-identified precondition: Project Lifecycle is the sole writer beneath the explicit allowed governance root while a v1 path resolution or atomic write is running.
- A later governance lease will serialize Project Lifecycle writers.
- V1 does not claim to defend against an untrusted process concurrently replacing entries in the same directory tree.
- This precondition is now stated directly on both exported APIs. No filesystem injection layer or fake portable TOCTOU guarantee was added.

### RED evidence

- Added twelve focused cases before changing production code: raw absolute inside-root, slash and backslash raw `..` segments, four POSIX interpretations of Windows absolute forms, dangling final symlink, malformed truthy validator result, validator throw cleanup, and validation/rename primary-error preservation when cleanup also fails.
- Command: `node --test tests/io/atomic-write.test.mjs`.
- Result: failed with exit code 1; 9 passed and 11 failed.
- Expected failures:
  - Raw inside-root absolute, both raw parent segments, three backslash Windows forms, dangling final symlink, and truthy `ok` were accepted, producing `Missing expected rejection`.
  - Windows drive-with-slashes produced `ENOENT` instead of `PATH_ESCAPE`.
  - Cleanup `EPERM` replaced `VALIDATION_FAILED`.
  - Cleanup `unlink` replaced the primary `rename` error.
- The validator-throw cleanup case passed immediately as a characterization of existing cleanup behavior; it still protects that required branch going forward.

### GREEN implementation and evidence

- `resolveInside` now rejects every raw absolute candidate categorically, rejects any raw `..` segment before normalization using both separators, and recognizes Windows drive, UNC, and rooted-backslash absolute forms on POSIX.
- A dangling final symlink now deterministically returns `PATH_SYMLINK_ESCAPE` rather than being treated as an absent target.
- `atomicWriteValidated` now accepts only `result.ok === true`.
- If exact temporary cleanup fails, the primary validation or native rename error remains the thrown error; the cleanup error is exposed as `error.cleanupError`.
- Cleanup-failure tests safely replace only the exact sandbox temporary file with an empty directory, causing deterministic `unlink` failure without mocks, injected filesystem operations, permissions changes, or paths outside the one-test `mkdtemp` sandbox.
- Command: `node --test tests/io/atomic-write.test.mjs`.
- Result: passed 20/20 with exit code 0.
- Command: `npm test`.
- Result: passed 134/134 with exit code 0.
- `node --check` passed for both production modules and the focused test file.
- `git diff --check` passed before staging; the staged diff is checked again immediately before the fix commit.

### Fix Round 1 files

- `scripts/lib/safe-path.mjs`
- `scripts/lib/atomic-write.mjs`
- `tests/io/atomic-write.test.mjs`
- `.superpowers/sdd/2026-08-08-project-lifecycle-phase-1-shared-contracts/task-6-report.md`

### Fix Round 1 self-review and concerns

- Confirmed every rejected candidate fails before a temporary sibling can be opened.
- Confirmed all new filesystem tests remain under their exact `mkdtemp` sandbox and cleanup still uses only tracked `unlink` plus bottom-up `rmdir`, never recursive deletion.
- Confirmed Windows-form tests are skipped on `win32`; their purpose is specifically to lock POSIX handling without constructing a possible Windows path outside the sandbox.
- Confirmed cleanup failure is secondary diagnostic evidence and cannot replace the primary validation or rename error covered by the tests.
- No blocking concerns remain under the accepted sole-writer trust precondition.

## Fix Round 2

### Scope and trust boundary

- Fixed the remaining cleanup-diagnostic edge case only in `scripts/lib/atomic-write.mjs` and its focused tests.
- The accepted v1 boundary is unchanged: Project Lifecycle is the sole writer beneath the governance root during an operation; a later governance lease will serialize writers; v1 does not claim defense against an untrusted process concurrently replacing the directory tree.

### RED evidence

- Added three real-filesystem cases where a validator replaces only the exact sandbox temporary file with an empty directory and then throws: an extensible Error, a frozen Error, and a primitive.
- Command: `node --test tests/io/atomic-write.test.mjs`.
- Result: failed with exit code 1; 21 passed and 2 failed.
- The extensible Error characterization passed and proved existing identity preservation.
- The frozen Error and primitive cases failed because the unconditional `Object.defineProperty` produced a TypeError instead of preserving both the primary and cleanup failures.

### GREEN implementation and evidence

- `attachCleanupError` now returns the original primary object after attaching `cleanupError` when the object is extensible.
- If attachment is impossible, it returns the smallest built-in wrapper: an `AggregateError` whose `cause` and `primaryError` retain the original thrown value, whose `cleanupError` retains the unlink failure, and whose ordered `errors` array contains both.
- The atomic-write catch path throws exactly the helper's returned value, so neither failure is swallowed.
- No new class, filesystem injection point, or broader production abstraction was added.
- Command: `node --test tests/io/atomic-write.test.mjs`.
- Result: passed 23/23 with exit code 0.
- Command: `npm test`.
- Result: passed 137/137 with exit code 0.
- `node --check` passed for the changed production module and focused test file.
- `git diff --check` passed before staging; the staged diff is checked again immediately before commit.

### Fix Round 2 files and concerns

- `scripts/lib/atomic-write.mjs`
- `tests/io/atomic-write.test.mjs`
- `.superpowers/sdd/2026-08-08-project-lifecycle-phase-1-shared-contracts/task-6-report.md`
- No blocking concerns under the accepted sole-writer trust precondition.
