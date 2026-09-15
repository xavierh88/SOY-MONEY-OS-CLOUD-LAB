---
name: Windmill callback boundary
description: Security and idempotency requirements before Windmill can participate in the Golden Path.
---

Windmill must not participate in the Golden Path until its callbacks use an explicit machine-authenticated API boundary and every external dispatch has durable, externally correlated idempotency.

**Why:** Owner-only Clerk routes reject current server-to-server flow calls, while retrying an ambiguously accepted POST can create multiple external jobs that local state cannot reconcile.

**How to apply:** Keep the existing flows classified as unavailable for orchestration until machine authentication, dispatch correlation, callback validation, and timeout reconciliation are implemented and tested. Do not weaken owner authorization to make flows work.