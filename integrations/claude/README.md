# Claude Code installation

Candidate version: `0.8.0`. Evidence status: `FAILED` based on retained native traces for Claude Code `2.1.286`; see the root support matrix. Those traces are evidence for that host build, not a validation pass for this candidate.

For isolated local verification use `claude --plugin-dir <absolute-repository-path>`. Marketplace installation uses `.claude-plugin/marketplace.json` with source `./`.

Start a fresh disposable profile, verify `maintain-project-knowledge` and `run-prd-lifecycle`, and run `bin/project-lifecycle version`. Remove the marketplace entry or local plugin directory and restart to uninstall. Record the Claude version, manifest discovery result, and redacted diagnostic on failure; never copy the Skills into a Claude-only tree.
