# Codex installation

Candidate version: `0.1.0`. Evidence status: `NOT_TESTED` until the native matrix is complete.

```text
codex plugin marketplace add https://github.com/jiuchuanll/project-lifecycle
codex plugin add project-lifecycle@project-lifecycle
```

Reload Codex, verify `maintain-project-knowledge` and `run-prd-lifecycle` are discoverable, then run `bin/project-lifecycle version`. Remove the plugin with the native plugin-removal command before retesting a clean profile. If discovery fails, record the Codex version, marketplace identifier, manifest path, and redacted diagnostic; do not fall back to copied Skills.
