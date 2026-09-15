---
name: Local ephemeral PostgreSQL
description: Environment-specific constraints for isolated local migration verification on Replit.
---

For disposable local migration tests, put the Unix socket inside the temporary cluster directory and connect as the operating-system user that ran `initdb`.

**Why:** This Replit environment has PostgreSQL binaries but no `/run/postgresql` socket directory, and `initdb` creates the current OS user as the initial database role rather than a `postgres` role.

**How to apply:** Initialize under `/tmp`, start PostgreSQL with `-k` pointing to that directory, create a clearly test-named database with the current OS user, expose only `TEST_DATABASE_URL`, and always stop and delete the cluster with a cleanup trap.