# Codex tool map

- ASK_USER: `request_user_input`
- CREATE_REVIEW_REQUEST: `GitHub connector draft PR operation`
- FETCH_REMOTE: `web.run or approved connector read`
- READ_FILE: `workspace file read through exec_command`
- RUN_COMMAND: `exec_command with argv-safe command`
- RUN_VALIDATOR: `bin/project-lifecycle`
- SEARCH_FILES: `rg through exec_command`
- WRITE_FILE: `apply_patch`

Canonical Skills: `skills/maintain-project-knowledge/SKILL.md` and `skills/run-prd-lifecycle/SKILL.md`.

## Unsupported operations

- None declared at the static stage; native conformance may mark an operation unavailable.
