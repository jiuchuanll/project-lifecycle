# docs-workflow Skill

`docs-workflow` is a standalone Codex skill for keeping product documentation routed, named, indexed, and verified consistently across product iterations.

It is useful when a repo has a durable product documentation tree and the agent must decide where to write PRDs, architecture notes, development guidance, batch logs, test reports, changelogs, and feedback records.

## What It Does

- Routes product docs to a canonical `docs/product/<product>/` tree.
- Reads `INDEX.md` first and keeps it current after doc changes.
- Separates long-lived product docs from temporary execution plans.
- Preserves bilingual doc pairs when the host repo uses them.
- Guides the agent toward the right supporting capabilities for each stage without dispatching tools itself.

## Repository Layout

```text
skills/
└── docs-workflow/
    └── SKILL.md
```

The skill itself is only `skills/docs-workflow/SKILL.md`. This README is repository-level documentation for humans.

## Install

Clone this repository, then copy the skill folder into one of these locations:

```bash
# User-level install
mkdir -p "${CODEX_HOME:-$HOME/.codex}/skills"
cp -R skills/docs-workflow "${CODEX_HOME:-$HOME/.codex}/skills/docs-workflow"

# Or project-level install
mkdir -p .agents/skills
cp -R skills/docs-workflow .agents/skills/docs-workflow
```

If you install it at project level, mention it in your `AGENTS.md` or equivalent agent instructions so future agents route product-doc work through this skill.

## Expected Project Structure

By default, the skill assumes a product documentation tree like this:

```text
docs/product/<product>/
├── INDEX.md
├── README.md
├── requirements/
├── architecture/
├── development/
│   ├── guidance/
│   ├── batches/
│   └── changelog/
├── test-reports/
└── feedback/
```

You can customize the directory names and naming rules inside `SKILL.md` for your own repo.

## Usage

Ask Codex to use the skill before product documentation work, for example:

```text
Use docs-workflow to turn this feedback into a product-doc update.
```

or:

```text
Use docs-workflow before writing the test report for this stage.
```

The agent should read the relevant `INDEX.md`, decide the stage and output path, update the doc, and keep the index synchronized.

## Customization Checklist

- Replace `<product>` with your product folder name.
- Adjust stage names and naming patterns.
- Decide whether bilingual `-en` counterparts are required.
- Update the stage routing table to match your team's tools and workflows.
- Add repo-specific hard constraints in your project instructions, not in this shared skill, unless they are reusable.

## Privacy

This shared package intentionally contains no local filesystem paths, credentials, private repository URLs, personal email addresses, or account-specific instructions.

Before sharing a fork or public copy, run:

```bash
rg -n "/Users|@|token|secret|password|private|github.com/.+/.+" .
```

Review any matches before publishing.
