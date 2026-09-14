---
name: Project cardinality
description: Compatibility constraint for project-per-opportunity enforcement across existing production data.
---

Do not add a database uniqueness requirement for project opportunity IDs unless historical production duplicates are reconciled through an approved data process.

**Why:** Production can contain multiple legacy projects for one opportunity, so a new unique index fails Publish validation even when development data is clean.

**How to apply:** Prevent new duplicates transactionally at the approval state transition. Keep post-approval operations keyed by project ID, and inspect production cardinality before proposing a future uniqueness constraint.