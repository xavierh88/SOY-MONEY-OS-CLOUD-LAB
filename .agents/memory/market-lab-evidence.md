---
name: Market Lab evidence boundary
description: Safety and ingestion rules for GitHub Actions quantitative research cycles.
---

GitHub Market Lab output is research simulation. `PAPER_APPROVED` means a simulated strategy passed quantitative gates; it never means verified real demand, realized revenue, or permission for financial execution.

**Why:** The external workflow analyzes historical public market data and explicitly produces a paper-research artifact with no real money or financial execution. Mixing that output into real evidence would violate SOY MONEY OS evidence gates.

**How to apply:** Preserve the external result for traceability, but force `real_money_used`, `financial_execution`, and `real_verified` to false at ingestion. Deduplicate remote runs by GitHub run ID and keep this subsystem separate from Windmill approvals and projects.