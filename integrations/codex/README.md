# Codex installation

Candidate version: `0.6.0`. Evidence status: `FAILED` based on retained `0.1.0` evidence for Codex `0.147.0-alpha.6.5`; see the root support matrix. Those traces are historical evidence, not validation of this candidate.

```text
codex plugin marketplace add https://github.com/jiuchuanll/project-lifecycle
codex plugin add project-lifecycle@project-lifecycle
```

Reload Codex, verify `maintain-project-knowledge` and `run-prd-lifecycle` are discoverable, then run `bin/project-lifecycle version`. Remove the plugin with the native plugin-removal command before retesting a clean profile. If discovery fails, record the Codex version, marketplace identifier, manifest path, and redacted diagnostic; do not fall back to copied Skills.
