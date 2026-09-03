# Claude Code installation

Candidate version: `0.7.0`. Evidence status: `NOT_TESTED` until the native matrix is complete. Retained `0.1.0` traces are historical evidence, not validation of this candidate.

For isolated local verification use `claude --plugin-dir <absolute-repository-path>`. Marketplace installation uses `.claude-plugin/marketplace.json` with source `./`.

Start a fresh disposable profile, verify `maintain-project-knowledge` and `run-prd-lifecycle`, and run `bin/project-lifecycle version`. Remove the marketplace entry or local plugin directory and restart to uninstall. Record the Claude version, manifest discovery result, and redacted diagnostic on failure; never copy the Skills into a Claude-only tree.
