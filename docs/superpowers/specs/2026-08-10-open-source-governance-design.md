# Open-Source Repository Governance Design

Status: Approved

Date: 2026-08-10

Repository: `jiuchuanll/project-lifecycle`

Chinese mirror: [2026-08-10-open-source-governance-design.zh-CN.md](./2026-08-10-open-source-governance-design.zh-CN.md)

## Objective

Publish the existing GitHub repository as an Apache-2.0 open-source project, make `develop` the default contribution branch, and require owner review before external contributions can enter any protected branch.

## Confirmed Decisions

- Use the Apache License 2.0.
- Create `develop` from the then-current remote `main` after governance files are merged.
- Make `develop` the GitHub default branch.
- Protect `main`, `develop`, `release/*`, and `hotfix/*` with one repository ruleset.
- Make `@jiuchuanll` the code owner for the entire repository.
- Permit repository administrators to bypass the rules only through a pull request. This preserves a PR record while allowing the sole owner to merge their own emergency or release PR when GitHub cannot accept self-approval.
- Keep `package.json` marked `"private": true`; opening the GitHub repository does not authorize npm publication.

## Scope

The change includes:

- a pre-publication privacy and credential audit of the current tree and Git history;
- Apache-2.0 license text;
- repository-wide CODEOWNERS ownership;
- English and Chinese contribution guidance;
- CI coverage for both `main` and `develop`;
- creation of `develop`;
- changing repository visibility to public;
- an active branch ruleset; and
- changing the default branch to `develop`.

This change does not publish an npm package, transfer the repository to an organization, add maintainers, rewrite Git history without a separately approved remediation, or introduce release automation.

## Publication Sequence

1. Refresh and inspect the remote repository state. Confirm the target is still `jiuchuanll/project-lifecycle`, is private, and has `main` as its default branch.
2. Audit the current `main` tree and reachable Git history for credentials, private paths, personal data, unintended archives, unsafe symlinks, and assets that are not approved for publication.
3. Run the repository's existing release gates, including `npm run check`, fixture validation, privacy checks, and `git diff --check`.
4. On a branch based on the latest `origin/main`, add the governance files and CI adjustment. Run tests, Codex Review, and a narrowly scoped security review.
5. Merge the governance pull request into `main` while the repository remains private.
6. Create `develop` from that updated remote `main` so it contains the governance files and excludes unrelated unmerged branch commits.
7. Change the repository visibility to public.
8. Immediately create and activate the repository ruleset.
9. Change the default branch to `develop`.
10. Re-read repository metadata, branch refs, CODEOWNERS, license detection, and ruleset state from GitHub.

Publication must stop before step 7 if the audit finds unresolved sensitive data or if required verification fails. Because public Git data may be copied immediately, changing visibility back to private is not considered a sufficient remediation.

## Repository Files

- `LICENSE`: unmodified Apache License 2.0 text.
- `.github/CODEOWNERS`: `* @jiuchuanll`.
- `CONTRIBUTING.md`: English contribution flow and protected-branch policy.
- `CONTRIBUTING.zh-CN.md`: synchronized Chinese mirror.
- `.github/workflows/ci.yml`: run push CI on both `main` and `develop`; pull-request CI remains enabled for all target branches.

The contribution guide will direct normal external work to `develop`. Stable releases flow through `release/*` into `main`; urgent production fixes use `hotfix/*`. All protected-branch changes use pull requests.

## Ruleset

Use one active repository branch ruleset targeting:

- `main`
- `develop`
- `release/*`
- `hotfix/*`

The ruleset will:

- require a pull request before merging;
- require at least one approving review;
- require review from a code owner;
- dismiss stale approvals when new commits change the reviewed diff;
- require all review conversations to be resolved;
- require the existing CI `check` job to pass;
- block force pushes;
- block deletion of matching branches; and
- grant repository administrators bypass access for pull requests only.

The ruleset will not require signed commits or linear history in this change because those constraints were not requested and could unnecessarily reject valid external contributions.

## Failure Handling

- If GitHub authentication cannot perform an administrative mutation, stop and request re-authentication; do not substitute a different account or repository.
- If a ruleset cannot be created while the repository is private under the current GitHub plan, create it immediately after visibility changes to public and verify it before changing the default branch.
- If the required CI context is not discoverable, keep PR and review protections active, repair CI context detection, and do not claim the complete acceptance gate has passed.
- If any GitHub mutation partially succeeds, report the exact live state and complete or safely reverse only the incomplete governance steps. Never assume a local command reflects remote success.

## Acceptance Criteria

- GitHub reports the repository visibility as `public`.
- GitHub reports `develop` as the default branch.
- `develop` points to the governance-enabled `main` commit at creation time.
- GitHub recognizes the Apache-2.0 license.
- CODEOWNERS assigns every path to `@jiuchuanll`.
- The active ruleset targets all four approved branch names or patterns.
- A pull request into a protected branch requires the `check` status, one approval, code-owner approval, and resolved conversations.
- New commits dismiss stale approvals.
- Non-bypass actors cannot directly update, force-push, or delete protected branches.
- Repository administrators can bypass only from a pull request.
- Local verification, Codex Review, and the scoped security review have no unresolved blocking findings.

## Security Boundary

Making the repository public is the only irreversible publication boundary in this design. It must occur only after the repository-content audit and governance-change review pass. Secrets or private data found in history require explicit remediation and a fresh audit before publication.
