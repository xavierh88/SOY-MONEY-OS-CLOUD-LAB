import { Router, type IRouter } from "express";
import { desc, eq } from "drizzle-orm";
import {
  db,
  discoveryFindingsTable,
  discoveryResearchRunsTable,
} from "@workspace/db";
import {
  ALL_RESEARCH_CATEGORIES,
  DISCOVERY_CATEGORIES,
  MONEY_LAB_CATEGORIES,
  researchCategory,
  RESEARCH_ONLY_CATEGORIES,
} from "../lib/discovery-research";

const router: IRouter = Router();
const categorySet = new Set<string>(ALL_RESEARCH_CATEGORIES);

router.post("/discovery/research", async (req, res): Promise<void> => {
  const raw = req.body ?? {};
  if (typeof raw !== "object" || Array.isArray(raw)) {
    res.status(400).json({ error: "body must be an object" });
    return;
  }
  const category = typeof raw.category === "string" ? raw.category.trim().toUpperCase() : "";
  if ((MONEY_LAB_CATEGORIES as readonly string[]).includes(category)) {
    res.status(409).json({
      error: "MONEY_LAB_ONLY",
      message: "MARKET and CRYPTO discovery remain in Money Lab.",
    });
    return;
  }
  if (!categorySet.has(category)) {
    res.status(400).json({
      error: "category must be a supported research category",
      supported: [...DISCOVERY_CATEGORIES, ...RESEARCH_ONLY_CATEGORIES],
      moneyLab: MONEY_LAB_CATEGORIES,
    });
    return;
  }
  const query = raw.query;
  if (query !== undefined && (typeof query !== "string" || query.trim().length > 240)) {
    res.status(400).json({ error: "query must be a string of at most 240 characters" });
    return;
  }
  const idempotencyKey = raw.idempotencyKey;
  if (idempotencyKey !== undefined
    && (typeof idempotencyKey !== "string" || idempotencyKey.trim().length > 240)) {
    res.status(400).json({ error: "idempotencyKey must be a string of at most 240 characters" });
    return;
  }
  try {
    const result = await researchCategory({ category, query, idempotencyKey });
    res.status(result.run.status === "RUNNING" ? 202 : result.run.status === "REJECTED" ? 422 : 201).json({
      run: result.run,
      opportunities: result.opportunities,
      findings: result.findings,
      accepted: result.opportunities.length > 0,
      error: result.run.rejectionReason
        ? { code: result.run.rejectionReason, message: "NO_VALID_OPPORTUNITY" }
        : null,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Discovery research failed";
    res.status(message === "UNSUPPORTED_DISCOVERY_CATEGORY" ? 400 : 502).json({
      error: message,
      code: "DISCOVERY_RESEARCH_FAILED",
    });
  }
});

router.get("/discovery/research", async (_req, res): Promise<void> => {
  const runs = await db.select().from(discoveryResearchRunsTable)
    .orderBy(desc(discoveryResearchRunsTable.createdAt)).limit(100);
  res.json(runs);
});

router.get("/discovery/research/:id", async (req, res): Promise<void> => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) {
    res.status(400).json({ error: "id must be a positive integer" });
    return;
  }
  const [run] = await db.select().from(discoveryResearchRunsTable)
    .where(eq(discoveryResearchRunsTable.id, id));
  if (!run) {
    res.status(404).json({ error: "Discovery research run not found" });
    return;
  }
  const findings = await db.select().from(discoveryFindingsTable)
    .where(eq(discoveryFindingsTable.researchRunId, id))
    .orderBy(desc(discoveryFindingsTable.detectedAt));
  res.json({ run, findings });
});

export default router;