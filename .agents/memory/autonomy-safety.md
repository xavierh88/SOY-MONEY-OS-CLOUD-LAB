---
name: Autonomy safety boundary
description: Durable guardrails for Autonomous Monetization Engine work.
---

Autonomy must remain OFF by default. Category rotation, deduplication, scoring, and checkpoint preparation are control-plane actions, not proof that research, monetization, publication, or financial execution occurred.

**Why:** The first autonomy control-plane implementation could safely select and score existing opportunities, but a review found that UI or state names could overstate execution and checkpoint resumption.

**How to apply:** Keep score separate from demand proof, keep PAPER/POTENTIAL separate from REAL, never call a checkpoint resumed until a durable runner continues it, and require explicit human authorization before any sensitive external action.