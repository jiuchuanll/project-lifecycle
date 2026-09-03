# DeepSeek Harness installation

Candidate version: `0.7.0`. Evidence status: `NOT_TESTED` until the native matrix is complete. Retained `0.1.0` traces are historical evidence, not validation of this candidate.

Install the repository as a DSH bundle into the target profile, then reload:

```text
dsh plugin --profile <profile> add https://github.com/jiuchuanll/project-lifecycle
```

For isolated local verification use a filesystem spec instead:

```text
dsh plugin --profile <profile> add <absolute-repository-path>
```

Reload DSH, verify `maintain-project-knowledge` and `run-prd-lifecycle` are discoverable, then run `bin/project-lifecycle version`. Remove the bundle with `dsh plugin --profile <profile> remove project-lifecycle` and reload to uninstall. Record the DSH version, profile name, and redacted diagnostic on failure; never copy the Skills into a DSH-only tree.
