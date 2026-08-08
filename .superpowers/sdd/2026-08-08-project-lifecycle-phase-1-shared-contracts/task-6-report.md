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
