# Harness Tool Contract

These operations are host-neutral. A mapping must return a structured failure when the native capability is unavailable; it must never silently substitute a broader operation.

### ASK_USER

Input: one bounded question and explicit decision context. Failure: return `UNAVAILABLE` without inventing approval.

### CREATE_REVIEW_REQUEST

Input: reviewed candidate ref, title, body-file locator, and target repository. Failure: preserve the candidate and return the remote error category.

### FETCH_REMOTE

Input: one approved portable locator. Failure: return `UNAVAILABLE` or a redacted retrieval error; never reuse stale content as current.

### READ_FILE

Input: one bounded project-relative locator. Failure: reject traversal, symlinks, and unreadable paths.

### RUN_COMMAND

Input: executable plus argument array and bounded working directory. Failure: return exit category with separated, redacted output.

### RUN_VALIDATOR

Input: bundled validator command plus explicit contract inputs. Failure: return its single JSON error envelope unchanged.

### SEARCH_FILES

Input: bounded root, query, and result limit. Failure: stop on overflow; do not widen the scan automatically.

### WRITE_FILE

Input: exact target, candidate bytes, validation rule, and ownership scope. Failure: leave accepted truth unchanged.
