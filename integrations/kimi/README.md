# Kimi Code installation

Candidate version: `0.3.0`. Evidence status: `FAILED` based on retained `0.1.0` evidence for Kimi Code `0.29.2`; see the root support matrix. Those traces are historical evidence, not validation of this candidate.

```text
/plugins install https://github.com/jiuchuanll/project-lifecycle
/reload
```

In a disposable profile, verify `maintain-project-knowledge` and `run-prd-lifecycle`, then run `bin/project-lifecycle version`. Use the native plugin removal command followed by `/reload` to uninstall. Record the Kimi version, `.kimi-plugin/plugin.json` discovery result, and redacted diagnostic; do not add a session-start dispatcher.
