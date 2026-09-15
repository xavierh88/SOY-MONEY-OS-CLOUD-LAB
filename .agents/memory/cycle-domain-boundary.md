---
name: Cycle domain boundary
description: Prevents legacy and autonomous cycle identifiers from being mixed across foreign keys.
---

Legacy cycles and autonomous cycles are separate identity domains. An autonomous cycle ID must use an autonomous-cycle reference; legacy `cycle_id` fields must remain null unless a real legacy cycle exists.

**Why:** Numeric IDs can overlap or look valid while pointing at different tables. Mixing them caused foreign-key failures in project and learning fixtures and can silently corrupt provenance when constraints are absent.

**How to apply:** When persisting provenance, identify the cycle type first and populate only its matching reference. Never copy a generic `cycleId` into both legacy and autonomous fields.