---
name: GitHub run correlation
description: Exact identity contract between durable Money Lab dispatches, GitHub runs, and result artifacts.
---

Every manual Money Lab dispatch must send a required `dispatch_id`. The GitHub run title and uploaded artifact must both contain that exact identifier, and the artifact must also contain the exact GitHub run ID.

**Why:** GitHub's run-list API does not expose workflow inputs directly. Time-proximity matching can attach the wrong run under concurrency and is not durable evidence.

**How to apply:** Match manual runs by the deterministic `run-name`, never by timestamp. Before candidate ingestion, compare artifact `dispatch_id` and `github_run_id` to the persisted dispatch and attached run. Reject missing or mismatched correlation.

For a fine-grained GitHub token, `Workflows: Read and write` permits editing the workflow file but does not permit creating a `workflow_dispatch`; the token also needs `Actions: Read and write`.

**Why:** A controlled dispatch was rejected with GitHub `403 Resource not accessible by personal access token` while workflow-file writes succeeded with the same token.

**How to apply:** Verify both permissions before a controlled run. On `403`, fail the existing durable dispatch closed, create no replacement test, and resume that same identity only after the token permission is corrected.