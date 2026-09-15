import { Router, type IRouter } from "express";
import { HealthCheckResponse } from "@workspace/api-zod";
import { ReadinessCheckResponse } from "@workspace/api-zod";
import { db } from "@workspace/db";
import { sql } from "drizzle-orm";
import { readOperationalMetrics } from "../lib/operational-metrics";

const router: IRouter = Router();

router.get("/healthz", (_req, res) => {
  const data = HealthCheckResponse.parse({ status: "ok" });
  res.json(data);
});

router.get("/readyz", async (_req, res): Promise<void> => {
  const checks: Record<string, { status: "ready" | "unavailable" | "degraded"; diagnostic?: string }> = {};
  try {
    await db.execute(sql`select 1`);
    checks.database = { status: "ready" };
  } catch {
    checks.database = { status: "unavailable", diagnostic: "Database probe failed" };
  }
  checks.storage = process.env.APP_STORAGE_ROOT || process.env.PROJECT_ARTIFACT_STORAGE_MODE === "local-test"
    ? { status: "ready" }
    : { status: "degraded", diagnostic: "Offline storage root is not configured" };
  checks.workers = process.env.WORKERS_DISABLED === "true"
    ? { status: "degraded", diagnostic: "Workers are disabled by configuration" }
    : { status: "ready" };
  const status = Object.values(checks).some((check) => check.status === "unavailable") ? "not_ready" : "ready";
  const body = ReadinessCheckResponse.parse({ status, checks });
  res.status(status === "ready" ? 200 : 503).json(body);
});

router.get("/metrics", (_req, res) => {
  res.json(readOperationalMetrics());
});

export default router;
