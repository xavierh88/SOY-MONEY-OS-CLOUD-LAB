---
name: Windmill callback boundary
description: Security and idempotency requirements before Windmill can participate in the Golden Path.
---

Windmill has a local HMAC callback boundary with dispatch-level provider, operation, transition, and replay validation. Existing external flows remain `LEGACY_UNUSED`; they must not participate in the Golden Path until they emit exact dispatch correlation and pass a controlled end-to-end test.

**Why:** Owner-only Clerk routes are intentionally unavailable to services, and an authenticated service must still be prevented from mutating dispatches belonging to another provider or operation. Ambiguous POST retries can also create duplicate external jobs.

**How to apply:** Keep Replit/PostgreSQL as the only lifecycle authority. Accept callbacks only for matching WINDMILL dispatches and allowlisted transitions. Never weaken owner authorization or promote existing flows without exact correlation and a controlled test.