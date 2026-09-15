---
name: Owner provisioning
description: Security rule for binding the single SOY MONEY OS owner identity.
---

Owner authorization must fail closed unless the authenticated Clerk identity matches the trusted configured owner. Never restore first-authenticated-user ownership claiming.

**Why:** A public sign-up or login page makes visit order untrustworthy; allowing the first authenticated visitor to claim the singleton can transfer full control to the wrong account.

**How to apply:** Keep owner provisioning separate from normal requests. Require the trusted configured identity before creating or using the persisted singleton binding, and return an explicit unavailable/forbidden response when configuration or identity does not match.