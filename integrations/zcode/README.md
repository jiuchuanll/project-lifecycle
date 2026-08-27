# ZCode installation

Candidate version: `0.5.0`. Evidence status: `NOT_TESTED` until the native matrix is complete. Retained `0.1.0` traces are historical evidence, not validation of this candidate.

Add `https://github.com/jiuchuanll/project-lifecycle` as a marketplace, then install the `project-lifecycle` package discovered through `.zcode-plugin/plugin.json` in a disposable profile.

Reload ZCode, verify `maintain-project-knowledge` and `run-prd-lifecycle`, and run `bin/project-lifecycle version`. Remove the native marketplace package and reload to uninstall. Record the ZCode version, manifest path, and redacted diagnostic; do not fall back to a copied Claude Skill tree.
