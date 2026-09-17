import { promises as fs } from "node:fs";
import path from "node:path";
import { Router, type IRouter } from "express";
import { HealthCheckResponse } from "@workspace/api-zod";
import { ReadinessCheckResponse } from "@workspace/api-zod";
import { db } from "@workspace/db";
import { sql } from "drizzle-orm";
import { readOperationalMetrics } from "../lib/operational-metrics";

const router: IRouter = Router();

const appStorageRoot = () =>
  path.resolve(
    process.env.APP_STORAGE_ROOT ??
      path.join(process.cwd(), "workspace", "app-storage"),
  );

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
  const storageRoot = appStorageRoot();
  const probePath = path.join(
    storageRoot,
    `.readiness-${process.pid}-${Date.now()}.probe`,
  );

  try {
    await fs.mkdir(storageRoot, { recursive: true });
    await fs.writeFile(probePath, "ready", { flag: "wx" });
    const probe = await fs.readFile(probePath, "utf8");
    if (probe !== "ready") {
      throw new Error("Storage probe content mismatch");
    }
    checks.storage = { status: "ready" };
  } catch {
    checks.storage = {
      status: "unavailable",
      diagnostic: "App Storage read/write probe failed",
    };
  } finally {
    await fs.rm(probePath, { force: true }).catch(() => undefined);
  }
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
