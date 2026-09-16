import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import pg from "pg";

const { Pool } = pg;
const here = dirname(fileURLToPath(import.meta.url));
const migrationsDirectory = join(here, "..", "migrations");

const migrationNames = [
  "20260914_control_tower.sql",
  "20260915_lifecycle_candidates.sql",
  "20260915_owner_binding.sql",
  "20260916_master_repair.sql",
  "20260917_discovery_research.sql",
  "20260918_discovery_provider_attempts.sql",
  "20260919_p1_operations.sql",
];

const expectedIndexes = [
  "soy_opportunities_expires_at_idx",
  "soy_human_actions_project_id_idx",
  "soy_lifecycle_events_event_key_unique",
  "soy_lifecycle_events_source_idx",
  "soy_market_cycle_candidates_record_key_unique",
  "soy_market_cycle_candidates_cycle_index_unique",
  "soy_owner_binding_singleton_unique",
  "soy_owner_binding_clerk_user_unique",
  "soy_results_finance_idempotency_unique",
  "soy_projects_creation_idempotency_unique",
  "soy_external_dispatches_dispatch_id_unique",
  "soy_external_dispatches_status_idx",
  "soy_external_dispatches_entity_idx",
  "soy_outbox_event_key_unique",
  "soy_outbox_pending_idx",
  "soy_service_receipts_receipt_key_unique",
  "soy_service_receipts_dispatch_transition_unique",
  "soy_service_receipts_service_status_idx",
  "soy_candidate_decisions_candidate_unique",
  "soy_candidate_decisions_decision_idx",
  "soy_candidate_decisions_decision_key_unique",
  "soy_market_cycle_candidates_expiration_scan_idx",
  "soy_learning_origin_classification_idx",
  "soy_opportunities_fingerprint_unique",
  "soy_discovery_research_runs_idempotency_unique",
  "soy_discovery_findings_source_fingerprint_unique",
  "soy_discovery_findings_fingerprint_idx",
  "soy_discovery_findings_category_idx",
  "soy_discovery_provider_attempt_unique",
];

const expectedForeignKeys = [
  ["soy_human_actions", "opportunity_id", "soy_opportunities"],
  ["soy_human_actions", "project_id", "soy_projects"],
  ["soy_market_cycle_candidates", "market_cycle_id", "soy_market_cycles"],
  ["soy_projects", "origin_opportunity_id", "soy_opportunities"],
  ["soy_projects", "origin_cycle_id", "soy_cycles"],
  ["soy_projects", "origin_candidate_id", "soy_market_cycle_candidates"],
  ["soy_external_dispatches", "cycle_id", "soy_cycles"],
  ["soy_external_dispatches", "market_cycle_id", "soy_market_cycles"],
  ["soy_external_dispatches", "opportunity_id", "soy_opportunities"],
  ["soy_external_dispatches", "project_id", "soy_projects"],
  ["soy_outbox", "dispatch_id", "soy_external_dispatches"],
  ["soy_service_receipts", "dispatch_id", "soy_external_dispatches"],
  ["soy_candidate_decisions", "candidate_id", "soy_market_cycle_candidates"],
  ["soy_candidate_decisions", "opportunity_id", "soy_opportunities"],
  ["soy_candidate_decisions", "autonomous_cycle_id", "soy_autonomous_cycles"],
  ["soy_learning", "opportunity_id", "soy_opportunities"],
  ["soy_learning", "cycle_id", "soy_cycles"],
  ["soy_learning", "autonomous_cycle_id", "soy_autonomous_cycles"],
  ["soy_learning", "result_id", "soy_results"],
  ["soy_learning", "candidate_id", "soy_market_cycle_candidates"],
  ["soy_discovery_findings", "research_run_id", "soy_discovery_research_runs"],
  ["soy_discovery_findings", "opportunity_id", "soy_opportunities"],
  ["soy_discovery_provider_attempts", "research_run_id", "soy_discovery_research_runs"],
];

function fail(message) {
  throw new Error(`[migration-test safety] ${message}`);
}

function assertSafeTestDatabaseUrl() {
  const raw = process.env.TEST_DATABASE_URL?.trim();
  if (!raw) {
    fail("TEST_DATABASE_URL is required; DATABASE_URL is never used by this runner");
  }

  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    fail("TEST_DATABASE_URL must be a valid PostgreSQL URL");
  }

  if (!["postgres:", "postgresql:"].includes(parsed.protocol)) {
    fail("TEST_DATABASE_URL must use postgres:// or postgresql://");
  }

  const databaseName = decodeURIComponent(parsed.pathname.replace(/^\/+/, ""));
  if (!databaseName) {
    fail("TEST_DATABASE_URL must include a database name");
  }

  // CI databases must be explicitly recognizable as disposable. This rejects
  // common development and production names as well as a generic "postgres".
  if (!/(^|[-_])(test|tests|ci|ephemeral|temporary)([-_]|$)/i.test(databaseName)) {
    fail(
      `refusing non-test database name "${databaseName}"; use a database name containing test, ci, or ephemeral`,
    );
  }

  // Do not run if an application URL is also present. This prevents a future
  // refactor from accidentally falling back to a development/production URL.
  for (const variable of [
    "DATABASE_URL",
    "DEVELOPMENT_DATABASE_URL",
    "PRODUCTION_DATABASE_URL",
  ]) {
    if (process.env[variable]) {
      fail(`${variable} must be unset; migration tests accept TEST_DATABASE_URL only`);
    }
  }

  return raw;
}

const testDatabaseUrl = assertSafeTestDatabaseUrl();

const baselineSql = `
CREATE TABLE soy_opportunities (
  id serial PRIMARY KEY,
  name text NOT NULL,
  description text NOT NULL,
  sector text NOT NULL,
  problem text NOT NULL,
  target_customer text NOT NULL,
  proposed_solution text NOT NULL,
  monetization_method text NOT NULL,
  score integer NOT NULL DEFAULT 0,
  estimated_cost real NOT NULL DEFAULT 0,
  difficulty text NOT NULL DEFAULT 'UNASSESSED',
  risk text NOT NULL DEFAULT 'UNASSESSED',
  time_to_revenue text NOT NULL DEFAULT 'UNASSESSED',
  status text NOT NULL DEFAULT 'DISCOVERED',
  proof_status text NOT NULL DEFAULT 'SEARCH_EVIDENCE',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE soy_cycles (
  id serial PRIMARY KEY,
  idempotency_key text NOT NULL,
  opportunity_id integer REFERENCES soy_opportunities(id),
  state text NOT NULL DEFAULT 'STARTING',
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE soy_projects (
  id serial PRIMARY KEY,
  opportunity_id integer NOT NULL REFERENCES soy_opportunities(id),
  name text NOT NULL,
  status text NOT NULL DEFAULT 'PLANNED',
  updated_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE soy_autonomous_cycles (
  id serial PRIMARY KEY,
  idempotency_key text NOT NULL,
  opportunity_id integer REFERENCES soy_opportunities(id),
  project_id integer REFERENCES soy_projects(id),
  state text NOT NULL DEFAULT 'STARTING',
  checkpoint text NOT NULL DEFAULT 'SELECT',
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE soy_market_cycles (
  id serial PRIMARY KEY,
  github_run_id text,
  github_workflow text NOT NULL,
  dispatch_key text NOT NULL,
  status text NOT NULL DEFAULT 'QUEUED',
  result jsonb,
  real_money_used boolean NOT NULL DEFAULT false,
  financial_execution boolean NOT NULL DEFAULT false,
  real_verified boolean NOT NULL DEFAULT false,
  started_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE soy_evidence (
  id serial PRIMARY KEY,
  opportunity_id integer NOT NULL REFERENCES soy_opportunities(id),
  source text NOT NULL,
  url text NOT NULL,
  claim text NOT NULL,
  verification_status text NOT NULL,
  proof_type text NOT NULL
);

CREATE TABLE soy_human_actions (
  id serial PRIMARY KEY,
  idempotency_key text NOT NULL,
  cycle_id integer REFERENCES soy_autonomous_cycles(id),
  action_type text NOT NULL,
  checkpoint text NOT NULL,
  status text NOT NULL DEFAULT 'PENDING',
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  completed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE soy_results (
  id serial PRIMARY KEY,
  project_id integer NOT NULL REFERENCES soy_projects(id),
  result_type text NOT NULL DEFAULT 'PREPARATION',
  outcome text NOT NULL,
  status text NOT NULL,
  revenue real NOT NULL DEFAULT 0,
  real_revenue boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE soy_learning (
  id serial PRIMARY KEY,
  project_id integer REFERENCES soy_projects(id),
  title text NOT NULL,
  summary text NOT NULL,
  status text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE soy_monetization_attempts (
  id serial PRIMARY KEY,
  idempotency_key text NOT NULL,
  opportunity_id integer REFERENCES soy_opportunities(id),
  project_id integer REFERENCES soy_projects(id),
  mode text NOT NULL DEFAULT 'POTENTIAL',
  kind text NOT NULL,
  status text NOT NULL DEFAULT 'PREPARED',
  amount real NOT NULL DEFAULT 0,
  evidence jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE soy_finance_ledger (
  id serial PRIMARY KEY,
  idempotency_key text NOT NULL,
  mode text NOT NULL DEFAULT 'POTENTIAL',
  entry_type text NOT NULL,
  amount real NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
`;

async function loadMigrations() {
  const files = (await readdir(migrationsDirectory))
    .filter((name) => name.endsWith(".sql"))
    .sort();
  assert.deepEqual(files, [...migrationNames].sort(), "migration inventory changed");
  return Promise.all(
    files.map(async (name) => ({
      name,
      sql: await readFile(join(migrationsDirectory, name), "utf8"),
    })),
  );
}

function quoteIdentifier(identifier) {
  return `"${identifier.replaceAll('"', '""')}"`;
}

async function createFreshSchema(client, schemaName) {
  await client.query(`CREATE SCHEMA ${quoteIdentifier(schemaName)}`);
  await client.query(`SET search_path TO ${quoteIdentifier(schemaName)}`);
  await client.query(baselineSql);
  await client.query(`
    INSERT INTO soy_opportunities
      (name, description, sector, problem, target_customer, proposed_solution, monetization_method)
    VALUES
      ('Migration fixture', 'fixture', 'software', 'fixture problem', 'builders', 'fixture solution', 'subscription')
  `);
  await client.query(`
    INSERT INTO soy_cycles (idempotency_key, opportunity_id, state)
    VALUES ('cycle-fixture', 1, 'COMPLETE')
  `);
  await client.query(`
    INSERT INTO soy_projects (opportunity_id, name, status)
    VALUES (1, 'Fixture project', 'READY')
  `);
  await client.query(`
    INSERT INTO soy_autonomous_cycles
      (idempotency_key, opportunity_id, project_id, state, checkpoint)
    VALUES ('autonomous-fixture', 1, 1, 'COMPLETE', 'DONE')
  `);
  await client.query(`
    INSERT INTO soy_market_cycles
      (github_workflow, dispatch_key, status, result)
    VALUES (
      'fixture-workflow',
      'fixture-dispatch',
      'COMPLETE',
      '{"results":[{"symbol":"BTC/USD","v2_gate":"PAPER_CANDIDATE","classification":"PROMISING","best_params":{"kind":"swing"},"in_sample":{"score":1}}]}'
    )
  `);
  await client.query(`
    INSERT INTO soy_human_actions
      (idempotency_key, cycle_id, action_type, checkpoint, status)
    VALUES ('action-fixture', 1, 'APPROVE', 'HUMAN_CHECKPOINT', 'COMPLETE')
  `);
  await client.query(`
    INSERT INTO soy_results (project_id, outcome, status)
    VALUES (1, 'fixture outcome', 'COMPLETE')
  `);
  await client.query(`
    INSERT INTO soy_learning (project_id, title, summary, status)
    VALUES (1, 'fixture learning', 'fixture summary', 'RECORDED')
  `);
}

async function runMigration(client, migration, append = "") {
  await client.query("BEGIN");
  try {
    await client.query(`${migration.sql}\n${append}`);
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  }
}

async function applyMigrations(client, migrations) {
  for (const migration of migrations) {
    await runMigration(client, migration);
  }
}

async function assertIndexes(client) {
  const result = await client.query(
    `SELECT indexname FROM pg_indexes WHERE schemaname = current_schema()`,
  );
  const actual = new Set(result.rows.map((row) => row.indexname));
  assert.deepEqual(
    expectedIndexes.filter((name) => !actual.has(name)),
    [],
    "one or more migration indexes are missing",
  );
}

async function assertForeignKeys(client) {
  for (const [table, column, target] of expectedForeignKeys) {
    const result = await client.query(
      `
        SELECT 1
        FROM pg_constraint constraint_row
        JOIN pg_class child_table ON child_table.oid = constraint_row.conrelid
        JOIN pg_class parent_table ON parent_table.oid = constraint_row.confrelid
        JOIN pg_attribute child_column
          ON child_column.attrelid = constraint_row.conrelid
         AND child_column.attnum = ANY(constraint_row.conkey)
        WHERE constraint_row.contype = 'f'
          AND child_table.relname = $1
          AND child_column.attname = $2
          AND parent_table.relname = $3
          AND constraint_row.convalidated
      `,
      [table, column, target],
    );
    assert.ok(
      result.rowCount > 0,
      `missing validated foreign key ${table}.${column} -> ${target}`,
    );
  }
}

async function assertMigrationResults(client) {
  await assertIndexes(client);
  await assertForeignKeys(client);

  const candidate = await client.query(
    `SELECT record_key, symbol, status, mode, paper_mode FROM soy_market_cycle_candidates`,
  );
  assert.equal(candidate.rowCount, 1);
  assert.deepEqual(candidate.rows[0], {
    record_key: "market-cycle:1:candidate:0",
    symbol: "BTC/USD",
    status: "PAPER_TESTING",
    mode: "PAPER",
    paper_mode: true,
  });

  const snapshots = await client.query(
    `SELECT count(*)::integer AS count FROM soy_lifecycle_events WHERE event_type = 'IMPORTED_SNAPSHOT'`,
  );
  assert.equal(snapshots.rows[0].count, 6);

  const project = await client.query(
    `SELECT origin_opportunity_id FROM soy_projects WHERE id = 1`,
  );
  assert.equal(project.rows[0].origin_opportunity_id, 1);

  const columns = await client.query(`
    SELECT table_name, column_name
    FROM information_schema.columns
    WHERE table_schema = current_schema()
      AND (table_name, column_name) IN (
        ('soy_opportunities', 'source'),
        ('soy_results', 'finance_idempotency_key'),
        ('soy_discovery_research_runs', 'execution_owner'),
        ('soy_discovery_provider_attempts', 'research_run_id')
      )
  `);
  assert.equal(columns.rowCount, 4);

  const checks = await client.query(`
    SELECT conname
    FROM pg_constraint
    WHERE connamespace = current_schema()::regnamespace
      AND conname IN (
        'soy_candidate_decisions_candidate_type_check',
        'soy_candidate_decisions_candidate_type_link_check'
      )
  `);
  assert.deepEqual(
    checks.rows.map((row) => row.conname).sort(),
    [
      "soy_candidate_decisions_candidate_type_check",
      "soy_candidate_decisions_candidate_type_link_check",
    ],
  );
}

async function assertConstraintEnforcement(client) {
  await assert.rejects(
    client.query(`
      INSERT INTO soy_external_dispatches
        (dispatch_id, provider, operation, entity_type, payload_hash, cycle_id)
      VALUES ('bad-fk', 'fixture', 'fixture', 'fixture', 'fixture', 999999)
    `),
    /foreign key/i,
  );
  await client.query(`
    INSERT INTO soy_owner_binding (singleton_key, clerk_user_id)
    VALUES ('default', 'fixture-owner')
  `);
  await assert.rejects(
    client.query(`
      INSERT INTO soy_owner_binding (singleton_key, clerk_user_id)
      VALUES ('default', 'second-owner')
    `),
    /unique/i,
  );
  await assert.rejects(
    client.query(`
      UPDATE soy_lifecycle_events SET status = 'MUTATED'
      WHERE event_key = 'snapshot:opportunity:1'
    `),
    /append-only/i,
  );
}

async function assertFailedMigrationRolledBack(client, migration) {
  await assert.rejects(
    runMigration(
      client,
      migration,
      "SELECT migration_test_intentionally_fails",
    ),
    /does not exist|undefined function|column/i,
  );
  const result = await client.query(`
    SELECT
      to_regclass('soy_discovery_provider_attempts') IS NULL AS table_absent,
      EXISTS (
        SELECT 1
        FROM information_schema.columns
        WHERE table_schema = current_schema()
          AND table_name = 'soy_discovery_research_runs'
          AND column_name = 'execution_owner'
      ) AS column_present
  `);
  assert.equal(result.rows[0].table_absent, true);
  assert.equal(result.rows[0].column_present, false);
}

async function runFreshScenario(client, migrations, schemaName) {
  await createFreshSchema(client, schemaName);
  await runMigration(client, migrations[0]);
  await runMigration(client, migrations[1]);
  await runMigration(client, migrations[2]);
  await runMigration(client, migrations[3]);
  await runMigration(client, migrations[4]);
  await assertFailedMigrationRolledBack(client, migrations[5]);
  await runMigration(client, migrations[5]);

  // Every migration must be safe to run again without changing the result.
  await applyMigrations(client, migrations);
  await assertMigrationResults(client);
  await assertConstraintEnforcement(client);
}

async function runUpgradeScenario(client, migrations, schemaName) {
  await createFreshSchema(client, schemaName);
  await runMigration(client, migrations[0]);
  await runMigration(client, migrations[1]);
  await client.query(`
    CREATE TABLE soy_candidate_decisions (
      id serial PRIMARY KEY,
      candidate_id integer NOT NULL REFERENCES soy_market_cycle_candidates(id),
      decision text NOT NULL,
      decision_reason text,
      score real,
      confidence real,
      risk text,
      decided_at timestamptz,
      decided_by text,
      next_action text,
      metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now()
    )
  `);
  await client.query(`
    INSERT INTO soy_candidate_decisions
      (candidate_id, decision)
    VALUES (1, 'CANDIDATE')
  `);
  await runMigration(client, migrations[3]);
  const upgraded = await client.query(`
    SELECT decision_key, candidate_type, candidate_ref, candidate_id
    FROM soy_candidate_decisions
  `);
  assert.deepEqual(upgraded.rows[0], {
    decision_key: "MONEY_LAB_CANDIDATE:1",
    candidate_type: "MONEY_LAB_CANDIDATE",
    candidate_ref: "1",
    candidate_id: 1,
  });
  await runMigration(client, migrations[4]);
  await runMigration(client, migrations[5]);
}

test("P0 PostgreSQL migrations pass fresh, upgrade, integrity, rerun, and rollback checks", async () => {
  const migrations = await loadMigrations();
  const pool = new Pool({
    connectionString: testDatabaseUrl,
    max: 1,
    connectionTimeoutMillis: 10_000,
  });
  const client = await pool.connect();
  const suffix = `${process.pid}_${Date.now().toString(36)}`;
  const freshSchema = `migration_test_fresh_${suffix}`;
  const upgradeSchema = `migration_test_upgrade_${suffix}`;

  try {
    await runFreshScenario(client, migrations, freshSchema);
    await client.query(`DROP SCHEMA ${quoteIdentifier(freshSchema)} CASCADE`);
    await runUpgradeScenario(client, migrations, upgradeSchema);
  } finally {
    await client.query(`DROP SCHEMA IF EXISTS ${quoteIdentifier(freshSchema)} CASCADE`);
    await client.query(`DROP SCHEMA IF EXISTS ${quoteIdentifier(upgradeSchema)} CASCADE`);
    client.release();
    await pool.end();
  }
});