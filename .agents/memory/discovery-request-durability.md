---
name: Discovery request durability
description: Safety contract for idempotent external discovery calls and crash recovery.
---

Reserve each external discovery query durably before issuing the network call. Treat provider-attempt rows, not run summary metadata, as the authority for request outcomes, counters, and recoverable normalized results. Fence every mutation and finalization to the current run owner.

**Why:** A crash between a provider response and a summary update can otherwise repeat a paid request, lose evidence, undercount usage, or let two workers finalize the same run.

**How to apply:** Any new discovery provider or resume path must reuse the pre-call reservation, reconstruct completed results by provider/query, count unknown outcomes as failed, and reject writes from stale owners.