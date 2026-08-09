# Parallel Delivery

Use this reference when active delivery owners overlap in domains, facts, constraints, contracts, repositories, or acceptance seams. Route ownership remains defined by [Intake routing](intake-routing.md).

## Declaration Before Coordination

Each durable owner declares its starting knowledge baseline, primary and affected domains, stable fact targets when known, constraint revisions, changed contracts, repository/worktree scopes, and relationships to other owners. The Agent supplies the overlap class; scripts validate the cited IDs and evidence rather than classifying prose.

Parallel work can continue when overlap is informational, facts are disjoint, or a shared seam is explicitly composable. Stop closure for a same-fact semantic conflict, an unmet acceptance seam, or a stale baseline that cannot be replayed without changing intended meaning.

## Worktree and Repository Boundaries

Split execution by independently testable code ownership, not automatically by document type. One Feedback may yield a product owner with separate frontend, backend, and module worktrees. Each worktree keeps its own runtime Context Receipt and implementation evidence; durable delivery owners link the results.

In multi-repository projects, central governance identifies the project and accepted knowledge authority while each repository retains its local implementation evidence. Do not copy the central knowledge base into every repository or let a repository-local outcome silently change project-wide truth.

## Baseline Reconciliation

Before closure, compare the owner's starting baseline with the accepted current baseline. A replayable change refreshes the bounded selection and reruns affected verification. An unreplayable conflict records the competing fact or contract, affected owners, evidence, and required decision; unaffected owners remain active.

## Minimal Coordination

Use ordinary links for expected architecture, implementation, testing, and acceptance flow. Create a secondary obligation only for an exceptional cross-owner result that must survive independently. The obligation vocabulary and storage rules are owned by [Obligations](obligations.md).
