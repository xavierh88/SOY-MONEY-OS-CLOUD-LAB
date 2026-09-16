import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import { createServer, type Server } from "node:http";
import { test, before, after } from "node:test";
import pg from "pg";

const { Pool } = pg;

function fail(message: string): never {
  throw new Error(`[p1-operations-integration safety] ${message}`);
}

function safeTestDatabaseUrl(): string {
  const raw = process.env.TEST_DATABASE_URL?.trim();
  if (!raw) fail("TEST_DATABASE_URL is required; DATABASE_URL is never used");

  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    fail("TEST_DATABASE_URL must be a valid PostgreSQL URL");
  }

  if (!["postgres:", "postgresql:"].includes(parsed.protocol)) {
    fail("TEST_DATABASE_URL must use postgres:// or postgresql://");
  }

  const databaseName = decodeURIComponent(parsed.pathname.replace(/^\/+/, ""));
  if (!/(^|[-_])(test|tests|ci|ephemeral|temporary)([-_]|$)/i.test(databaseName)) {
    fail(`refusing non-test database "${databaseName}"`);
  }

  for (const variable of [
    "DATABASE_URL",
    "DEVELOPMENT_DATABASE_URL",
    "PRODUCTION_DATABASE_URL",
  ]) {
    if (process.env[variable]) fail(`${variable} must be unset`);
  }

  return raw;
}

function quoteIdentifier(identifier: string): string {
  return `"${identifier.replaceAll('"', '""')}"`;
}

const baselineSql = String.raw`CREATE TABLE soy_opportunities (
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

const originalTestDatabaseUrl = safeTestDatabaseUrl();
const suffix = `${process.pid}_${Date.now().toString(36)}_${randomUUID().slice(0, 8)}`;
const schemaName = `p1_operations_test_${suffix}`;

const adminPool = new Pool({
  connectionString: originalTestDatabaseUrl,
  max: 1,
  connectionTimeoutMillis: 10_000,
});

const adminClient = await adminPool.connect();
await adminClient.query(`CREATE SCHEMA ${quoteIdentifier(schemaName)}`);
await adminClient.query(`SET search_path TO ${quoteIdentifier(schemaName)}`);

await adminClient.query(baselineSql);

const migrationFiles = [
  "20260914_control_tower.sql",
  "20260915_lifecycle_candidates.sql",
  "20260915_owner_binding.sql",
  "20260916_master_repair.sql",
  "20260917_discovery_research.sql",
  "20260918_discovery_provider_attempts.sql",
  "20260919_p1_operations.sql",
];

for (const migrationFile of migrationFiles) {
  const migrationSql = await fs.readFile(
    new URL(`../../../lib/db/migrations/${migrationFile}`, import.meta.url),
    "utf8",
  );
  await adminClient.query(migrationSql);
}

const isolatedUrl = new URL(originalTestDatabaseUrl);
const existingOptions = isolatedUrl.searchParams.get("options");
const searchPathOption = `-c search_path=${schemaName}`;
isolatedUrl.searchParams.set(
  "options",
  existingOptions ? `${existingOptions} ${searchPathOption}` : searchPathOption,
);

process.env.NODE_ENV = "test";
process.env.TEST_DATABASE_URL = isolatedUrl.toString();
process.env.SOY_OWNER_CLERK_USER_ID = "p1-owner";
delete process.env.DATABASE_URL;

const [{ default: app }, dbModule] = await Promise.all([
  import("../src/app.ts"),
  import("@workspace/db"),
]);

let server: Server;
let baseUrl: string;

before(async () => {
  server = createServer(app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert(address && typeof address !== "string");
  baseUrl = `http://127.0.0.1:${address.port}`;
});

after(async () => {
  if (server) {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }

  await dbModule.pool.end();
  await adminClient.query(`DROP SCHEMA IF EXISTS ${quoteIdentifier(schemaName)} CASCADE`);
  adminClient.release();
  await adminPool.end();
});

function ownerHeaders(userId = "p1-owner") {
  return { "x-test-clerk-user-id": userId };
}

async function jsonRequest(
  route: string,
  options: {
    method?: string;
    headers?: Record<string, string>;
    body?: unknown;
  } = {},
) {
  const response = await fetch(`${baseUrl}${route}`, {
    method: options.method ?? "GET",
    headers: {
      ...(options.body === undefined ? {} : { "content-type": "application/json" }),
      ...options.headers,
    },
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });

  const text = await response.text();
  let body: unknown = null;
  if (text) {
    try {
      body = JSON.parse(text);
    } catch {
      body = text;
    }
  }

  return { response, body };
}

function assertErrorEnvelope(
  body: unknown,
  expectedCode: string,
) {
  const error = body as {
    error?: string;
    code?: string;
    correlationId?: string;
  };

  assert.equal(error.code, expectedCode);
  assert.equal(typeof error.correlationId, "string");
  assert.ok(error.correlationId && error.correlationId.length > 0);
}

test("Notifications persist, isolate owners, filter unread, and mark read", async () => {
  const owner = "p1-owner";
  const foreignOwner = "foreign-owner";

  const unreadInsert = await adminClient.query(
    `INSERT INTO soy_notifications
      (owner_clerk_user_id, title, body, target_path)
     VALUES ($1, $2, $3, $4)
     RETURNING id`,
    [owner, "P1 unread notification", "Unread body", "/projects/101"],
  );
  const unreadId = unreadInsert.rows[0].id as number;

  const readInsert = await adminClient.query(
    `INSERT INTO soy_notifications
      (owner_clerk_user_id, title, body, target_path, read_at)
     VALUES ($1, $2, $3, $4, now())
     RETURNING id`,
    [owner, "P1 read notification", "Read body", "/projects/102"],
  );
  const readId = readInsert.rows[0].id as number;

  const foreignInsert = await adminClient.query(
    `INSERT INTO soy_notifications
      (owner_clerk_user_id, title, body, target_path)
     VALUES ($1, $2, $3, $4)
     RETURNING id`,
    [foreignOwner, "Foreign notification", "Must stay isolated", "/projects/999"],
  );
  const foreignId = foreignInsert.rows[0].id as number;

  const listed = await jsonRequest("/api/notifications", {
    headers: ownerHeaders(),
  });
  assert.equal(listed.response.status, 200);
  assert.ok(Array.isArray(listed.body));

  const rows = listed.body as Array<{
    id: number;
    ownerClerkUserId: string;
    readAt: string | null;
  }>;

  assert.ok(rows.some((row) => row.id === unreadId));
  assert.ok(rows.some((row) => row.id === readId));
  assert.ok(!rows.some((row) => row.id === foreignId));
  assert.ok(rows.every((row) => row.ownerClerkUserId === owner));

  const unreadOnly = await jsonRequest("/api/notifications?unreadOnly=true", {
    headers: ownerHeaders(),
  });
  assert.equal(unreadOnly.response.status, 200);
  assert.ok(Array.isArray(unreadOnly.body));

  const unreadRows = unreadOnly.body as Array<{
    id: number;
    readAt: string | null;
  }>;

  assert.ok(unreadRows.some((row) => row.id === unreadId));
  assert.ok(!unreadRows.some((row) => row.id === readId));
  assert.ok(unreadRows.every((row) => row.readAt === null));

  const marked = await jsonRequest(`/api/notifications/${unreadId}/read`, {
    method: "POST",
    headers: ownerHeaders(),
  });
  assert.equal(marked.response.status, 200);

  const markedBody = marked.body as {
    id: number;
    ownerClerkUserId: string;
    readAt: string | null;
  };
  assert.equal(markedBody.id, unreadId);
  assert.equal(markedBody.ownerClerkUserId, owner);
  assert.ok(markedBody.readAt);

  const persisted = await adminClient.query(
    `SELECT owner_clerk_user_id, read_at
       FROM soy_notifications
      WHERE id = $1`,
    [unreadId],
  );
  assert.equal(persisted.rows[0].owner_clerk_user_id, owner);
  assert.ok(persisted.rows[0].read_at);

  const foreignAttempt = await jsonRequest(`/api/notifications/${foreignId}/read`, {
    method: "POST",
    headers: ownerHeaders(),
  });
  assert.equal(foreignAttempt.response.status, 404);

  const foreignPersisted = await adminClient.query(
    `SELECT read_at
       FROM soy_notifications
      WHERE id = $1`,
    [foreignId],
  );
  assert.equal(foreignPersisted.rows[0].read_at, null);
});

test("Incidents persist, isolate owners, and acknowledge durably", async () => {
  const owner = "p1-owner";
  const foreignOwner = "foreign-owner";

  const ownedInsert = await adminClient.query(
    `INSERT INTO soy_incidents
      (owner_clerk_user_id, severity, status, title, summary, correlation_id)
     VALUES ($1, $2, $3, $4, $5, $6)
     RETURNING id`,
    [owner, "HIGH", "OPEN", "P1 incident", "Operational incident fixture", "corr-p1-incident"],
  );
  const ownedId = ownedInsert.rows[0].id as number;

  const foreignInsert = await adminClient.query(
    `INSERT INTO soy_incidents
      (owner_clerk_user_id, severity, status, title, summary, correlation_id)
     VALUES ($1, $2, $3, $4, $5, $6)
     RETURNING id`,
    [foreignOwner, "CRITICAL", "OPEN", "Foreign incident", "Must stay isolated", "corr-foreign"],
  );
  const foreignId = foreignInsert.rows[0].id as number;

  const listed = await jsonRequest("/api/incidents", {
    headers: ownerHeaders(),
  });
  assert.equal(listed.response.status, 200);
  assert.ok(Array.isArray(listed.body));

  const rows = listed.body as Array<{
    id: number;
    ownerClerkUserId: string;
    status: string;
  }>;

  assert.ok(rows.some((row) => row.id === ownedId));
  assert.ok(!rows.some((row) => row.id === foreignId));
  assert.ok(rows.every((row) => row.ownerClerkUserId === owner));

  const acknowledged = await jsonRequest(`/api/incidents/${ownedId}/acknowledge`, {
    method: "POST",
    headers: ownerHeaders(),
  });
  assert.equal(acknowledged.response.status, 200);

  const acknowledgedBody = acknowledged.body as {
    id: number;
    ownerClerkUserId: string;
    status: string;
    acknowledgedAt: string | null;
    acknowledgedBy: string | null;
  };

  assert.equal(acknowledgedBody.id, ownedId);
  assert.equal(acknowledgedBody.ownerClerkUserId, owner);
  assert.equal(acknowledgedBody.status, "ACKNOWLEDGED");
  assert.equal(acknowledgedBody.acknowledgedBy, owner);
  assert.ok(acknowledgedBody.acknowledgedAt);

  const persisted = await adminClient.query(
    `SELECT status, acknowledged_at, acknowledged_by
       FROM soy_incidents
      WHERE id = $1`,
    [ownedId],
  );

  assert.equal(persisted.rows[0].status, "ACKNOWLEDGED");
  assert.equal(persisted.rows[0].acknowledged_by, owner);
  assert.ok(persisted.rows[0].acknowledged_at);

  const foreignAttempt = await jsonRequest(`/api/incidents/${foreignId}/acknowledge`, {
    method: "POST",
    headers: ownerHeaders(),
  });
  assert.equal(foreignAttempt.response.status, 404);

  const foreignPersisted = await adminClient.query(
    `SELECT status, acknowledged_at, acknowledged_by
       FROM soy_incidents
      WHERE id = $1`,
    [foreignId],
  );

  assert.equal(foreignPersisted.rows[0].status, "OPEN");
  assert.equal(foreignPersisted.rows[0].acknowledged_at, null);
  assert.equal(foreignPersisted.rows[0].acknowledged_by, null);
});

test("DLQ exposes failed events and requires human, idempotent durable retry", async () => {
  const insertEvent = async (eventKey: string, status: string, attemptCount = 0) => {
    const result = await adminClient.query(
      `INSERT INTO soy_outbox
        (event_key, event_type, aggregate_type, aggregate_id, payload, status, attempt_count, last_error)
       VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7, $8)
       RETURNING id`,
      [
        eventKey,
        "P1_TEST_EVENT",
        "project",
        eventKey,
        JSON.stringify({ fixture: true }),
        status,
        attemptCount,
        status === "FAILED" || status === "AMBIGUOUS" ? "fixture failure" : null,
      ],
    );
    return result.rows[0].id as number;
  };

  const failedId = await insertEvent(`p1-failed-${randomUUID()}`, "FAILED", 2);
  const ambiguousId = await insertEvent(`p1-ambiguous-${randomUUID()}`, "AMBIGUOUS", 1);
  const pendingId = await insertEvent(`p1-pending-${randomUUID()}`, "PENDING", 0);

  const listed = await jsonRequest("/api/operations/dlq", {
    headers: ownerHeaders(),
  });
  assert.equal(listed.response.status, 200);
  assert.ok(Array.isArray(listed.body));

  const rows = listed.body as Array<{
    id: number;
    status: string;
    attemptCount: number;
  }>;

  assert.ok(rows.some((row) => row.id === failedId && row.status === "FAILED"));
  assert.ok(rows.some((row) => row.id === ambiguousId && row.status === "AMBIGUOUS"));
  assert.ok(!rows.some((row) => row.id === pendingId));
  assert.ok(rows.every((row) => ["FAILED", "AMBIGUOUS"].includes(row.status)));

  const denied = await jsonRequest(`/api/operations/dlq/${failedId}/retry`, {
    method: "POST",
    headers: ownerHeaders(),
    body: {
      idempotencyKey: "p1-denied-retry",
      humanCheckpoint: false,
    },
  });
  // The public contract requires humanCheckpoint === true, so false is
  // rejected by request validation before the route-level checkpoint guard.
  assert.equal(denied.response.status, 400);

  const unchanged = await adminClient.query(
    `SELECT status, attempt_count, last_error
       FROM soy_outbox
      WHERE id = $1`,
    [failedId],
  );
  assert.equal(unchanged.rows[0].status, "FAILED");
  assert.equal(unchanged.rows[0].attempt_count, 2);
  assert.equal(unchanged.rows[0].last_error, "fixture failure");

  const idempotencyKey = `p1-retry-${randomUUID()}`;

  const retried = await jsonRequest(`/api/operations/dlq/${failedId}/retry`, {
    method: "POST",
    headers: ownerHeaders(),
    body: {
      idempotencyKey,
      humanCheckpoint: true,
    },
  });
  assert.equal(retried.response.status, 200);

  const retriedBody = retried.body as {
    id: number;
    status: string;
    attemptCount: number;
    lastError: string | null;
  };

  assert.equal(retriedBody.id, failedId);
  assert.equal(retriedBody.status, "RETRY");
  assert.equal(retriedBody.attemptCount, 3);
  assert.equal(retriedBody.lastError, `DLQ_RETRY:p1-owner:${idempotencyKey}`);

  const persisted = await adminClient.query(
    `SELECT status, attempt_count, locked_at, last_error
       FROM soy_outbox
      WHERE id = $1`,
    [failedId],
  );
  assert.equal(persisted.rows[0].status, "RETRY");
  assert.equal(persisted.rows[0].attempt_count, 3);
  assert.equal(persisted.rows[0].locked_at, null);
  assert.equal(persisted.rows[0].last_error, `DLQ_RETRY:p1-owner:${idempotencyKey}`);

  const replay = await jsonRequest(`/api/operations/dlq/${failedId}/retry`, {
    method: "POST",
    headers: ownerHeaders(),
    body: {
      idempotencyKey,
      humanCheckpoint: true,
    },
  });
  assert.equal(replay.response.status, 200);

  const replayBody = replay.body as {
    status: string;
    attemptCount: number;
    lastError: string | null;
  };
  assert.equal(replayBody.status, "RETRY");
  assert.equal(replayBody.attemptCount, 3);
  assert.equal(replayBody.lastError, `DLQ_RETRY:p1-owner:${idempotencyKey}`);

  const afterReplay = await adminClient.query(
    `SELECT status, attempt_count, last_error
       FROM soy_outbox
      WHERE id = $1`,
    [failedId],
  );
  assert.equal(afterReplay.rows[0].status, "RETRY");
  assert.equal(afterReplay.rows[0].attempt_count, 3);
  assert.equal(afterReplay.rows[0].last_error, `DLQ_RETRY:p1-owner:${idempotencyKey}`);

  const ineligible = await jsonRequest(`/api/operations/dlq/${pendingId}/retry`, {
    method: "POST",
    headers: ownerHeaders(),
    body: {
      idempotencyKey: `p1-pending-${randomUUID()}`,
      humanCheckpoint: true,
    },
  });
  assert.equal(ineligible.response.status, 409);

  const missing = await jsonRequest("/api/operations/dlq/2147483647/retry", {
    method: "POST",
    headers: ownerHeaders(),
    body: {
      idempotencyKey: `p1-missing-${randomUUID()}`,
      humanCheckpoint: true,
    },
  });
  assert.equal(missing.response.status, 404);
});
