---
schema_version: 1
artifact_id: feedback-template
artifact_kind: feedback
primary_route: PRD_DELIVERY
project_id_at_creation: sample-project
current_project_id: sample-project
domain_ids: [sample-domain]
knowledge_baseline: replace-with-baseline
relationships: { feedback_ids: [], prd_ids: [], legacy_artifact_refs: [] }
retention_tier: active
reclassified_from_refs: []
obligations: []
---
# Feedback title

<!-- project-lifecycle:section original_problem -->
## Original problem
Record the user's original problem without solution rewriting.
<!-- /project-lifecycle:section -->

<!-- project-lifecycle:section scenario -->
## Scenario
Record when and where the problem occurs.
<!-- /project-lifecycle:section -->

<!-- project-lifecycle:section expectation -->
## Expectation
Record the user's expected outcome.
<!-- /project-lifecycle:section -->

<!-- project-lifecycle:section marking -->
## Marking
Record standardized status markings only.

> Optional: insert this marker only after the business-to-implementation divergence is confirmed. This fenced example is inert.

```text
<!-- project-lifecycle:alignment
schema_version: 1
classification: BUSINESS_IMPLEMENTATION_DIVERGENCE
primary_domain_id: sample-domain
-->
```
<!-- /project-lifecycle:section -->

<!-- project-lifecycle:section coverage -->
## Coverage
Link exact covered, deferred, rejected, or superseded portions.
<!-- /project-lifecycle:section -->
