# Open-Source Repository Governance Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Publish `jiuchuanll/project-lifecycle` under Apache-2.0 with `develop` as the default branch and owner-approved pull requests enforced on every protected branch.

**Architecture:** Keep repository governance in a small set of versioned files, then enforce the approved policy with one GitHub repository ruleset. Treat the visibility change as the irreversible boundary: audit and merge all governance changes while private, create `develop` from the updated `main`, activate protections, and verify every remote mutation from GitHub's API.

**Tech Stack:** Git, Node.js 22, Node test runner, YAML, npm, GitHub Actions, GitHub CLI/REST API, CODEOWNERS, GitHub repository rulesets

## Global Constraints

- Repository identity remains exactly `jiuchuanll/project-lifecycle`.
- Use Apache License 2.0.
- Create `develop` from the then-current remote `main` after governance files are merged.
- Change the default branch to `develop` only after branch protections are active.
- One active repository ruleset targets `main`, `develop`, `release/*`, and `hotfix/*`.
- `@jiuchuanll` owns every repository path.
- Protected branches require a pull request, one approval, code-owner approval, stale-review dismissal, resolved conversations, and the `check` status.
- Block force pushes and deletion of protected branches.
- GitHub user ID `129171141` (`@jiuchuanll`) may bypass rules only from a pull request.
- Keep `package.json` set to `"private": true`; do not publish an npm package.
- Do not rewrite Git history without separate explicit approval.
- Stop before changing visibility if any privacy, credential, test, review, or security gate has an unresolved blocking finding.
- Use Codex built-in review, not CodeRabbit. Run a scoped Codex Security diff review because this change affects publication and GitHub permissions.
- Before any push, finish both review gates and use `CODEX_REVIEW_GATE_CONFIRMED=1 git push ...` only after valid findings are resolved.

---

### Task 1: Refresh State and Pass the Pre-Publication Audit

**Files:**
- Inspect: all files reachable from `origin/main`
- Inspect: all commits reachable from `--all`
- Modify: none

**Interfaces:**
- Consumes: authenticated access to `jiuchuanll/project-lifecycle`, local Git objects, `scripts/check-privacy.mjs`
- Produces: a recorded `origin/main` SHA, a clean audit result, and an authenticated GitHub administrative session

- [ ] **Step 1: Confirm checkout scope**

Run:

~~~bash
git status --short --branch
git branch --show-current
git remote get-url origin
git rev-parse HEAD
~~~

Expected: branch is `codex/open-source-governance`, worktree is clean, and `origin` is `https://github.com/jiuchuanll/project-lifecycle.git`.

- [ ] **Step 2: Refresh remote refs**

Run:

~~~bash
git fetch --prune origin '+refs/heads/*:refs/remotes/origin/*'
git fetch --prune --prune-tags --tags origin '+refs/tags/*:refs/tags/*'
git fetch origin \
  '+refs/pull/*/head:refs/remotes/origin/pull/*/head' \
  '+refs/pull/*/merge:refs/remotes/origin/pull/*/merge'
git rev-parse origin/main
git rev-list --left-right --count origin/main...HEAD
test -z "$(comm -23 \
  <(git ls-remote --tags --refs origin | awk '{print $2}' | sort) \
  <(git for-each-ref --format='%(refname)' refs/tags | sort))"
~~~

Expected: fetch succeeds, every remote branch head, pull-request head and merge ref is available for the history audit, every remote tag exists locally, and the comparison exits 0. If `origin/main` moved, rebase this branch onto it, review the new commits, and restart Task 1.

- [ ] **Step 3: Restore GitHub CLI authentication for the exact owner**

Run `gh auth status -h github.com`. If invalid, run `gh auth login -h github.com --web`. Then verify:

~~~bash
test "$(gh api user --jq .login)" = "jiuchuanll"
test "$(gh api repos/jiuchuanll/project-lifecycle --jq .permissions.admin)" = "true"
~~~

Expected: both tests exit 0. Do not substitute another account.

- [ ] **Step 4: Reconfirm the remote boundary**

Run:

~~~bash
gh api repos/jiuchuanll/project-lifecycle --jq '{full_name,visibility,default_branch,archived,permissions}'
gh api repos/jiuchuanll/project-lifecycle/branches/develop
~~~

Expected: repository is private, default branch is `main`, it is not archived, admin permission is true, and `develop` returns HTTP 404.

- [ ] **Step 5: Run current-tree gates**

Run:

~~~bash
npm ci
npm run check
git diff --check
~~~

Expected: all commands exit 0 and privacy output reports `"ok":true`.

- [ ] **Step 6: Audit all reachable history without printing suspected values**

Run this path-only scan. `git grep -l` reports object IDs and paths, not matching lines:

~~~bash
audit_patterns='gh[pousr]_[A-Za-z0-9_]+|github_pat_[A-Za-z0-9_]+|AKIA[A-Z0-9]{16}|BEGIN (OPENSSH |RSA )?PRIVATE KEY|(token|api[_-]?key|password|secret|private[_-]?key|access[_-]?key)[[:space:]]*[:=]|/(Users|home)/|[A-Za-z]:\\Users\\|github\.com[/:][A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+'
while IFS= read -r audit_commit; do
  git grep -I -l -E "$audit_patterns" "$audit_commit" -- . || test $? -eq 1
done < <(git rev-list --all)
~~~

Also scan commit messages and annotated-tag messages without printing matching values:

~~~bash
metadata_patterns='gh[pousr]_[A-Za-z0-9_]+|github_pat_[A-Za-z0-9_]+|AKIA[A-Z0-9]{16}|BEGIN (OPENSSH |RSA )?PRIVATE KEY|(token|api[_-]?key|password|secret|private[_-]?key|access[_-]?key)[[:space:]]*[:=]|/(Users|home)/|[A-Za-z]:\\Users\\'
while IFS= read -r audit_commit; do
  if git show -s --format='%B' "$audit_commit" | LC_ALL=C grep -E -q "$metadata_patterns"; then
    printf 'commit %s METADATA_PATTERN\n' "$audit_commit"
  fi
done < <(git rev-list --all)
while IFS= read -r audit_tag; do
  audit_tag_object=$(git rev-parse "$audit_tag^{tag}" 2>/dev/null) || continue
  if git cat-file tag "$audit_tag_object" | sed '1,/^$/d' | LC_ALL=C grep -E -q "$metadata_patterns"; then
    printf 'tag %s METADATA_PATTERN\n' "$audit_tag_object"
  fi
done < <(git for-each-ref --format='%(refname)' refs/tags)
~~~

The expression covers these categories:

~~~text
GitHub tokens: ghp_, gho_, ghu_, ghs_, ghr_, github_pat_
Cloud keys: AKIA followed by 16 uppercase alphanumeric characters
Private keys: BEGIN OPENSSH PRIVATE KEY, BEGIN RSA PRIVATE KEY, BEGIN PRIVATE KEY
Assignments: token, api_key, password, secret, private_key, access_key followed by : or =
Personal paths: Unix home directories and Windows user-profile directories
Private repository locators: github.com/<owner>/<repo> other than jiuchuanll/project-lifecycle
~~~

Expected: no unexplained path-only or metadata findings. Inspect matches locally without copying secret material into chat or logs. Stop until each match is proven fictional/public or remediated under separate approval.

- [ ] **Step 7: Inspect object integrity and publishable artifacts**

Run:

~~~bash
git fsck --full
git log --all --oneline --decorate
git ls-tree -r --long origin/main
git ls-tree -r origin/main | rg '(^|/)(\.DS_Store|\.env|node_modules)(/|$)|\.(pem|key|p12|pfx)$'
git ls-tree -r origin/main | awk '$1 == "120000" {print $4}'
~~~

Expected: no corruption and no tracked private/local artifacts. Inspect tracked archives and symlinks explicitly.

- [ ] **Step 8: Run a standard Codex Security repository scan**

Resolve the repository root with `pwd -P` and scan that absolute root with scope `.`. Treat validated publication, credential, traversal, archive, local-file, or external-tool findings as blocking.

Expected: no unresolved reportable finding affects safe publication. If the scan cannot complete, report the exact failure and do not change visibility.

### Task 2: Add and Validate Versioned Governance Assets

**Files:**
- Create: `LICENSE`
- Create: `.github/CODEOWNERS`
- Create: `CONTRIBUTING.md`
- Create: `CONTRIBUTING.zh-CN.md`
- Modify: `.github/workflows/ci.yml`

**Interfaces:**
- Consumes: canonical Apache-2.0 text, installed `yaml` package, approved branch policy
- Produces: governance files validated by configuration parsing, the full repository gate, GitHub Actions, and remote API inspection

- [ ] **Step 1: Add canonical license and ownership**

Create `LICENSE` from the unmodified Apache License 2.0 text, beginning:

~~~text
Apache License
Version 2.0, January 2004
http://www.apache.org/licenses/
~~~

Create `.github/CODEOWNERS` with exactly:

~~~text
* @jiuchuanll
~~~

Do not add a custom clause inside the license.

- [ ] **Step 2: Add synchronized contribution guides**

Create `CONTRIBUTING.md` and `CONTRIBUTING.zh-CN.md`. Both state:

~~~text
Normal contributions target develop.
Stable release pull requests flow from release/* to main.
Urgent fixes use hotfix/* and enter protected branches only through pull requests.
main, develop, release/*, and hotfix/* require CI and owner review.
New commits invalidate prior approvals, and review conversations must be resolved.
~~~

Each guide links to its language mirror. Keep semantics synchronized.

- [ ] **Step 3: Extend push CI**

Modify `.github/workflows/ci.yml` so `push.branches` is:

~~~yaml
- main
- develop
~~~

Keep workflow `CI` and job `check` names unchanged.

- [ ] **Step 4: Parse and validate the governance configuration**

Run:

~~~bash
node --input-type=module -e "import assert from 'node:assert/strict'; import { readFile } from 'node:fs/promises'; import YAML from 'yaml'; const workflow=YAML.parse(await readFile('.github/workflows/ci.yml','utf8')); assert.deepEqual(workflow.on.push.branches,['main','develop']); assert.ok(workflow.on.pull_request); assert.ok(workflow.jobs.check); assert.equal(await readFile('.github/CODEOWNERS','utf8'),'* @jiuchuanll\\n');"
npm run check
git diff --check
~~~

Expected: YAML parses, ownership and CI routing assertions pass, and the full repository gate passes.

- [ ] **Step 5: Commit only governance assets**

Run:

~~~bash
git add LICENSE .github/CODEOWNERS CONTRIBUTING.md CONTRIBUTING.zh-CN.md .github/workflows/ci.yml
git diff --cached --check
git commit -m "chore: add open-source repository governance"
~~~

Expected: one focused commit containing only those five paths.

### Task 3: Complete Review Gates and Publish the Governance PR

**Files:**
- Review: `origin/main...HEAD`
- Modify: only Task 2 files when a valid finding requires repair

**Interfaces:**
- Consumes: committed design, plan, governance assets, full tests
- Produces: reviewed remote branch and a PR targeting `main`

- [ ] **Step 1: Run final local verification**

~~~bash
npm ci
npm run check
git diff --check origin/main...HEAD
git status --short
~~~

Expected: all tests pass and worktree is clean.

- [ ] **Step 2: Run Codex built-in review**

Review `origin/main...HEAD`. Repair every valid finding surgically, rerun configuration validation and `npm run check`, and commit repairs separately.

Expected: no unresolved actionable finding.

- [ ] **Step 3: Run Codex Security diff review**

Review `origin/main...HEAD` for publication exposure, CODEOWNERS coverage, CI trust boundaries, local/private data, and GitHub governance assumptions.

Expected: no validated blocking finding. Repair and reverify valid findings.

- [ ] **Step 4: Push after both gates pass**

~~~bash
CODEX_REVIEW_GATE_CONFIRMED=1 git push -u origin codex/open-source-governance
~~~

Expected: remote branch points to the reviewed commit.

- [ ] **Step 5: Open a non-draft PR into main**

Use:

~~~text
Title: chore: prepare repository for open-source governance
Base: main
Head: codex/open-source-governance
Body: summarize Apache-2.0, CODEOWNERS, bilingual contribution guidance, develop CI coverage, audit results, tests, Codex Review, and Codex Security. State that the repository remains private and no ruleset/default-branch mutation has happened.
~~~

Expected: one open PR targeting `main`.

- [ ] **Step 6: Wait for CI and merge**

Run `gh pr checks --watch --fail-fast`.

Expected: `check` succeeds. Re-read PR state and merge with a normal merge commit. Do not merge on failing CI or unresolved review state.

- [ ] **Step 7: Record updated main identity**

~~~bash
git fetch origin main
governance_main_sha=$(git rev-parse origin/main)
test "$governance_main_sha" = "$(gh api repos/jiuchuanll/project-lifecycle/commits/main --jq .sha)"
~~~

Expected: exit 0. Retain `governance_main_sha` for Task 4.

### Task 4: Create develop and Verify CI

**Files:**
- Modify: remote `refs/heads/develop`
- Modify: none locally

**Interfaces:**
- Consumes: `governance_main_sha` from Task 3
- Produces: `develop` at that exact SHA with successful `check` status

- [ ] **Step 1: Create develop from recorded main**

~~~bash
gh api --method POST repos/jiuchuanll/project-lifecycle/git/refs \
  -f ref=refs/heads/develop \
  -f sha="$governance_main_sha"
~~~

Expected: HTTP 201 and `refs/heads/develop`. Never substitute local `HEAD`.

- [ ] **Step 2: Verify branch identity**

~~~bash
test "$(gh api repos/jiuchuanll/project-lifecycle/branches/develop --jq .commit.sha)" = \
  "$(gh api repos/jiuchuanll/project-lifecycle/branches/main --jq .commit.sha)"
~~~

Expected: exit 0.

- [ ] **Step 3: Verify CI context**

~~~bash
gh api repos/jiuchuanll/project-lifecycle/commits/develop/check-runs \
  --jq '.check_runs[] | {name,status,conclusion}'
~~~

Expected: `check` completed successfully.

### Task 5: Protect Branches, Publish, and Change the Default

**Files:**
- Modify: GitHub repository ruleset
- Modify: GitHub visibility
- Modify: GitHub default branch

**Interfaces:**
- Consumes: verified branches, successful `check`, user ID `129171141`
- Produces: active ruleset, public repository, default `develop`

- [ ] **Step 1: Re-read state immediately before mutation**

~~~bash
gh api repos/jiuchuanll/project-lifecycle --jq '{visibility,default_branch,permissions}'
gh api repos/jiuchuanll/project-lifecycle/rulesets --jq '.[] | {id,name,enforcement,target}'
~~~

Expected: private, default `main`, admin true, no conflicting active ruleset.

- [ ] **Step 2: Construct this exact ruleset JSON in memory**

~~~json
{
  "name": "protected-branch-owner-review",
  "target": "branch",
  "enforcement": "active",
  "bypass_actors": [
    {"actor_id": 129171141, "actor_type": "User", "bypass_mode": "pull_request"}
  ],
  "conditions": {
    "ref_name": {
      "include": [
        "refs/heads/main",
        "refs/heads/develop",
        "refs/heads/release/*",
        "refs/heads/hotfix/*"
      ],
      "exclude": []
    }
  },
  "rules": [
    {"type": "deletion"},
    {"type": "non_fast_forward"},
    {
      "type": "pull_request",
      "parameters": {
        "allowed_merge_methods": ["merge", "squash", "rebase"],
        "dismiss_stale_reviews_on_push": true,
        "require_code_owner_review": true,
        "require_last_push_approval": false,
        "required_approving_review_count": 1,
        "required_review_thread_resolution": true
      }
    },
    {
      "type": "required_status_checks",
      "parameters": {
        "do_not_enforce_on_create": true,
        "required_status_checks": [{"context": "check"}],
        "strict_required_status_checks_policy": false
      }
    }
  ]
}
~~~

Pipe it to `gh api --method POST repos/jiuchuanll/project-lifecycle/rulesets --input -`. Do not write authentication material to disk.

- [ ] **Step 3: Prefer activating protection while private**

Submit the Step 2 request.

Expected: HTTP 201, active enforcement. Record the returned ID as `governance_ruleset_id`. If GitHub returns a plan-related 403/404, do not claim protection; continue to Step 4 and repeat the same request immediately in Step 5.

- [ ] **Step 4: Cross the visibility boundary**

~~~bash
gh api --method PATCH repos/jiuchuanll/project-lifecycle \
  -f visibility=public \
  --jq '{full_name,visibility,default_branch}'
~~~

Expected: `visibility: public`.

- [ ] **Step 5: Ensure the ruleset is active**

If Step 3 failed only because private rulesets were unavailable, submit the exact Step 2 request now. Otherwise re-read `governance_ruleset_id` and do not create a duplicate.

Expected: exactly one active `protected-branch-owner-review` ruleset. If activation fails after publication, stop other mutations, report the public-but-unprotected state, and repair only this ruleset.

- [ ] **Step 6: Change default branch after protection**

~~~bash
gh api --method PATCH repos/jiuchuanll/project-lifecycle \
  -f default_branch=develop \
  --jq '{full_name,visibility,default_branch}'
~~~

Expected: public repository with default `develop`.

### Task 6: Verify Remote Enforcement and Close

**Files:**
- Inspect: GitHub metadata, refs, contents, license, checks, effective rules
- Modify: none unless a verified narrow mismatch requires repair

**Interfaces:**
- Consumes: Task 5 remote state
- Produces: evidence for every acceptance criterion and bounded claims for untested behavior

- [ ] **Step 1: Verify metadata and branches**

~~~bash
gh api repos/jiuchuanll/project-lifecycle --jq '{full_name,visibility,default_branch,private,archived}'
gh api repos/jiuchuanll/project-lifecycle/branches/main --jq '{name,sha:.commit.sha,protected}'
gh api repos/jiuchuanll/project-lifecycle/branches/develop --jq '{name,sha:.commit.sha,protected}'
~~~

Expected: public, default `develop`, both branches protected.

- [ ] **Step 2: Verify license and CODEOWNERS**

~~~bash
gh api repos/jiuchuanll/project-lifecycle/license --jq '{license:.license.spdx_id,path}'
gh api 'repos/jiuchuanll/project-lifecycle/contents/.github/CODEOWNERS?ref=develop' \
  --jq -r .content | base64 --decode
~~~

Expected: `Apache-2.0`, `LICENSE`, and `* @jiuchuanll` plus newline.

- [ ] **Step 3: Verify stored and effective rules**

~~~bash
governance_ruleset_id=$(gh api repos/jiuchuanll/project-lifecycle/rulesets \
  --jq '.[] | select(.name == "protected-branch-owner-review") | .id')
gh api "repos/jiuchuanll/project-lifecycle/rulesets/$governance_ruleset_id"
gh api repos/jiuchuanll/project-lifecycle/rules/branches/main
gh api repos/jiuchuanll/project-lifecycle/rules/branches/develop
~~~

Expected: one active ruleset with four exact patterns, user `129171141` in PR-only bypass mode, deletion and non-fast-forward protection, approved PR parameters, and required `check`.

- [ ] **Step 4: Verify default-branch files and CI**

~~~bash
gh api 'repos/jiuchuanll/project-lifecycle/contents/CONTRIBUTING.md?ref=develop' --jq .sha
gh api 'repos/jiuchuanll/project-lifecycle/contents/CONTRIBUTING.zh-CN.md?ref=develop' --jq .sha
gh api repos/jiuchuanll/project-lifecycle/commits/develop/check-runs \
  --jq '.check_runs[] | select(.name == "check") | {status,conclusion}'
~~~

Expected: both guides exist and `check` succeeded.

- [ ] **Step 5: Run final local gates**

~~~bash
git fetch --prune origin
npm run check
git diff --check
git status --short --branch
~~~

Expected: gates pass.

- [ ] **Step 6: Report exact evidence**

Report repository URL, visibility, default branch, `main`/`develop` SHAs, ruleset ID, PR URL, CI result, modified files, review results, and unresolved risks.

Do not claim a real external user was blocked unless tested with a non-bypass account. Active rules and effective-rule API responses are the authoritative configuration evidence.
