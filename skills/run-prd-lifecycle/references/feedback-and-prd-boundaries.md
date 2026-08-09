# Feedback and PRD Boundaries

Use this reference to preserve the user-origin record, decide whether a product-requirement owner is justified, and relate Feedback to delivery without forcing one Feedback to equal one PRD. Route definitions remain owned by [Intake routing](intake-routing.md).

## Feedback Is the Source Record

Feedback preserves the original problem, scenario, expectation, source reference, and later coverage markings. After creation, do not rewrite that narrative to match the eventual solution. Correct an error with an explicit erratum or successor and preserve the original hash.

Feedback is not automatically a task, specification, or acceptance decision. Several Feedback records may motivate one PRD, and one Feedback may need several PRDs or non-PRD outcomes. Track coverage by the exact part satisfied, deferred, rejected, or superseded.

## PRD Threshold

A PRD is a bounded development-stage requirement input. Create it when the work needs durable product intent, scope, success criteria, non-goals, a starting knowledge baseline, and coordinated acceptance. An explicit user request is sufficient authorization. Agent-inferred creation requires a compact boundary proposal and confirmation.

Continue an existing PRD when the new request refines its accepted goal and can be evaluated under the same product boundary. Create a linked successor or peer when the goal, owner, acceptance boundary, or baseline-conflict handling must evolve independently. Avoid splitting merely by frontend/backend repository; repository execution can remain separate under one product owner.

## Grounding

Consume the bounded knowledge selection: baseline, primary and affected domains, selected stable facts, applicable constraints, exclusions, questions, and stop. Do not paste entire capability documents into Feedback or PRD bodies. If the selection is insufficient, resolve that stop before presenting product assumptions as current facts.

## Closure Semantics

PRD completion does not close every linked Feedback. Mark only the coverage demonstrated by accepted evidence. A partially addressed Feedback remains open for its uncovered expectation without reopening already accepted work.
