---
name: Autonomy slot claims
description: Concurrency rule for durable scheduler reservations and retries.
---

Only the scheduler invocation that wins the atomic reservation or retry claim may consume a slot after successful execution. A losing invocation must not consume `RUNNING`, `STARTING`, `RETRY_PENDING`, or retryable `FAILED`.

**Why:** Treating an existing row as success lets a losing concurrent worker advance `lastSlotKey` before the real claimant finishes; if the claimant then fails, durable retries are suppressed.

**How to apply:** Return explicit claim ownership from cycle reservation, condition retries on the previous retry count, consume only on owned success or genuinely terminal observation, and test first-claim and retry races concurrently.