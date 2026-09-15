import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const execFileAsync = promisify(execFile);
const configuredDatabaseUrl = process.env.DEVELOPMENT_DATABASE_URL ?? process.env.DATABASE_URL;

if (!configuredDatabaseUrl) {
  throw new Error("DEVELOPMENT_DATABASE_URL or DATABASE_URL is required");
}
const databaseUrl: string = configuredDatabaseUrl;

async function query(sql: string): Promise<string> {
  try {
    const result = await execFileAsync("psql", [
      "--no-psqlrc",
      "--quiet",
      "--tuples-only",
      "--no-align",
      "--field-separator",
      "\t",
      "--dbname",
      databaseUrl,
      "--command",
      sql,
    ], { maxBuffer: 1024 * 1024 });
    return result.stdout.trim();
  } catch {
    throw new Error("Development database query failed; verify migrations and DATABASE_URL");
  }
}

async function count(sql: string): Promise<number> {
  const value = Number(await query(sql));
  if (!Number.isInteger(value) || value < 0) {
    throw new Error("Development database returned a non-integer regression count");
  }
  return value;
}

const checks: Array<{ name: string; sql: string }> = [
  {
    name: "autonomy status is OFF",
    sql: `
      SELECT count(*)
      FROM soy_autonomy_state
      WHERE upper(status) <> 'OFF'
    `,
  },
  {
    name: "duplicate project creation idempotency keys",
    sql: `
      SELECT count(*)
      FROM (
        SELECT creation_idempotency_key
        FROM soy_projects
        WHERE creation_idempotency_key IS NOT NULL
        GROUP BY creation_idempotency_key
        HAVING count(*) > 1
      ) duplicate_keys
    `,
  },
  {
    name: "duplicate external dispatch IDs",
    sql: `
      SELECT count(*)
      FROM (
        SELECT dispatch_id
        FROM soy_external_dispatches
        GROUP BY dispatch_id
        HAVING count(*) > 1
      ) duplicate_dispatches
    `,
  },
  {
    name: "duplicate Market Lab dispatch keys",
    sql: `
      SELECT count(*)
      FROM (
        SELECT dispatch_key
        FROM soy_market_cycles
        GROUP BY dispatch_key
        HAVING count(*) > 1
      ) duplicate_dispatches
    `,
  },
  {
    name: "duplicate lifecycle event keys",
    sql: `
      SELECT count(*)
      FROM (
        SELECT event_key
        FROM soy_lifecycle_events
        GROUP BY event_key
        HAVING count(*) > 1
      ) duplicate_events
    `,
  },
  {
    name: "duplicate finance ledger idempotency keys",
    sql: `
      SELECT count(*)
      FROM (
        SELECT idempotency_key
        FROM soy_finance_ledger
        GROUP BY idempotency_key
        HAVING count(*) > 1
      ) duplicate_keys
    `,
  },
  {
    name: "duplicate result finance idempotency keys",
    sql: `
      SELECT count(*)
      FROM (
        SELECT finance_idempotency_key
        FROM soy_results
        WHERE finance_idempotency_key IS NOT NULL
        GROUP BY finance_idempotency_key
        HAVING count(*) > 1
      ) duplicate_keys
    `,
  },
  {
    name: "invalid candidate decision domain links",
    sql: `
      SELECT count(*)
      FROM soy_candidate_decisions d
      LEFT JOIN soy_market_cycle_candidates c ON c.id = d.candidate_id
      LEFT JOIN soy_opportunities o ON o.id = d.opportunity_id
      WHERE
        d.candidate_type IS NULL
        OR d.candidate_type NOT IN ('MONEY_LAB_CANDIDATE', 'OPPORTUNITY_CANDIDATE')
        OR (
          d.candidate_type = 'MONEY_LAB_CANDIDATE'
          AND (d.candidate_id IS NULL OR d.opportunity_id IS NOT NULL OR c.id IS NULL)
        )
        OR (
          d.candidate_type = 'OPPORTUNITY_CANDIDATE'
          AND (d.candidate_id IS NOT NULL OR d.opportunity_id IS NULL OR o.id IS NULL)
        )
    `,
  },
  {
    name: "expired executable candidates",
    sql: `
      SELECT count(*)
      FROM soy_market_cycle_candidates
      WHERE (expires_at <= now() OR valid_until <= now())
        AND (
          upper(coalesce(status, '')) IN
            ('EXECUTABLE', 'READY', 'APPROVED', 'SELECTED', 'PAPER_APPROVED', 'PAPER_CANDIDATE')
          OR upper(coalesce(decision, '')) IN
            ('APPROVED', 'SELECTED', 'EXECUTABLE', 'PAPER_APPROVED')
        )
    `,
  },
  {
    name: "REAL ledger rows marked as test or repair data",
    sql: `
      SELECT count(*)
      FROM soy_finance_ledger
      WHERE upper(mode) = 'REAL'
        AND (
          idempotency_key ~* '(test|repair|fixture|golden)'
          OR description ~* '(test|repair|fixture|golden)'
          OR coalesce(source_type, '') ~* '(test|repair|fixture|golden)'
          OR coalesce(source_id, '') ~* '(test|repair|fixture|golden)'
        )
    `,
  },
  {
    name: "non-canonical finance modes",
    sql: `
      SELECT count(*)
      FROM (
        SELECT mode FROM soy_finance_ledger
        WHERE mode IS NOT NULL AND mode NOT IN ('REAL', 'PAPER', 'POTENTIAL')
        UNION ALL
        SELECT mode FROM soy_results
        WHERE mode IS NOT NULL AND mode NOT IN ('REAL', 'PAPER', 'POTENTIAL')
        UNION ALL
        SELECT mode FROM soy_market_cycles
        WHERE mode IS NOT NULL AND mode NOT IN ('REAL', 'PAPER', 'POTENTIAL')
        UNION ALL
        SELECT mode FROM soy_monetization_attempts
        WHERE mode IS NOT NULL AND mode NOT IN ('REAL', 'PAPER', 'POTENTIAL')
        UNION ALL
        SELECT mode FROM soy_platform_accounts
        WHERE mode IS NOT NULL AND mode NOT IN ('REAL', 'PAPER', 'POTENTIAL')
        UNION ALL
        SELECT mode FROM soy_market_cycle_candidates
        WHERE mode IS NOT NULL AND mode NOT IN ('REAL', 'PAPER', 'POTENTIAL')
      ) invalid_modes
    `,
  },
];

async function assertExternalLockExpectation() {
  const policyPath = fileURLToPath(new URL("../../artifacts/api-server/src/lib/autonomy-policy.ts", import.meta.url));
  const policy = await readFile(policyPath, "utf8");
  if (!/AUTONOMY_EXECUTION_LOCKED\s*=\s*true\b/.test(policy)) {
    throw new Error("external autonomy lock expectation is not true");
  }
}

async function main() {
  await assertExternalLockExpectation();
  const failures: string[] = [];
  for (const check of checks) {
    const violations = await count(check.sql);
    if (violations !== 0) failures.push(`${check.name}: ${violations}`);
  }
  if (failures.length > 0) {
    throw new Error(`Development DB regression failed:\n${failures.join("\n")}`);
  }
  console.info(`Development DB regression passed (${checks.length} checks).`);
}

await main();