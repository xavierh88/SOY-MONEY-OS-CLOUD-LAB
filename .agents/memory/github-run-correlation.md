---
name: GitHub run correlation
description: Exact identity contract between durable Money Lab dispatches, GitHub runs, and result artifacts.
---

Every manual Money Lab dispatch must send a required `dispatch_id`. The GitHub run title and uploaded artifact must both contain that exact identifier, and the artifact must also contain the exact GitHub run ID.

**Why:** GitHub's run-list API does not expose workflow inputs directly. Time-proximity matching can attach the wrong run under concurrency and is not durable evidence.

**How to apply:** Match manual runs by the deterministic `run-name`, never by timestamp. Before candidate ingestion, compare artifact `dispatch_id` and `github_run_id` to the persisted dispatch and attached run. Reject missing or mismatched correlation.