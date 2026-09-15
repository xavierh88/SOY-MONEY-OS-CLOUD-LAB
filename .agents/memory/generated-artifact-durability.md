---
name: Generated artifact durability
description: Persistence boundary for zero-capital project deliverables in autoscale deployments.
---

Generated project deliverables must be copied to private App Storage and referenced by durable object paths. Local workspace files may support immediate QA but are not the source of durability.

**Why:** Autoscale deployment filesystems can be replaced between instances or restarts, so a local manifest path alone can become unverifiable even when PostgreSQL still references it.

**How to apply:** Every generated file and manifest needs a content hash plus an App Storage object path. QA may read local bytes first, but must be able to fetch the private object and verify the same size and hash when local files are absent.