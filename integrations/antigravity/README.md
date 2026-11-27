# Antigravity installation

Candidate version: `0.9.0`. Evidence status: `NOT_TESTED` until the native matrix is complete. Retained traces for other hosts are not validation of this candidate on Antigravity.

Install the repository through the Antigravity CLI (`agy`) or register the local repository in `.agents/plugins.json` using `.antigravity-plugin/plugin.json` in a disposable profile:

```text
agy plugin install https://github.com/jiuchuanll/project-lifecycle
```

For isolated local validation and installation from a local checkout:

```text
agy plugin validate --strict <absolute-repository-path>
agy plugin install <absolute-repository-path>
```

Antigravity discovers native plugins via `.antigravity-plugin/plugin.json` when installed globally (`~/.gemini/config/plugins/project-lifecycle/`) or registered in workspace `.agents/plugins.json`.

Verify installation with `agy plugin list` (or the Customizations page / `/plugin`), confirm both `maintain-project-knowledge` and `run-prd-lifecycle` are discoverable, and run `bin/project-lifecycle version` (or `node dist/project-lifecycle.mjs version` as fallback).

Remove the plugin with `agy plugin uninstall project-lifecycle` (or uninstall from the Customizations page) and start a fresh session to verify clean removal. Never hand-edit `~/.gemini/config/config.json` and never copy the Skills into an Antigravity-only tree. If discovery fails, record the Antigravity version, `.antigravity-plugin/plugin.json` discovery result, and redacted diagnostic.
