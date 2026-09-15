import { createHash } from "node:crypto";
import {
  and,
  desc,
  eq,
  sql,
} from "drizzle-orm";
import {
  autonomyLearningTable,
  db,
  discoveryFindingsTable,
  discoveryResearchRunsTable,
  evidenceTable,
  opportunityMetadataTable,
  opportunitiesTable,
} from "@workspace/db";

export const DISCOVERY_CATEGORIES = [
  "BUSINESS",
  "DIGITAL_PRODUCTS",
  "SERVICES",
  "SAAS",
  "AUTOMATION",
  "AFFILIATE",
  "OTHER_LEGAL_OPPORTUNITIES",
] as const;
export const RESEARCH_ONLY_CATEGORIES = ["SPORTS"] as const;
export const MONEY_LAB_CATEGORIES = ["MARKET", "CRYPTO"] as const;
export const ALL_RESEARCH_CATEGORIES = [
  ...DISCOVERY_CATEGORIES,
  ...RESEARCH_ONLY_CATEGORIES,
] as const;
export type DiscoveryCategory = typeof ALL_RESEARCH_CATEGORIES[number];

const queries: Record<DiscoveryCategory, string> = {
  BUSINESS: "small business workflow problem",
  DIGITAL_PRODUCTS: "digital product feature request",
  SERVICES: "freelance service problem request",
  SAAS: "software as a service feature request",
  AUTOMATION: "automation repetitive task request",
  AFFILIATE: "product recommendation request comparison",
  OTHER_LEGAL_OPPORTUNITIES: "business problem customer request",
  SPORTS: "sports workflow problem feature request",
};

type Finding = {
  source: string;
  sourceUrl: string;
  detectedAt: Date;
  titleClaim: string;
  excerpt: string;
  independenceKey: string;
  raw: Record<string, unknown>;
};

type SourceResult = { source: string; independenceKey: string; findings: Finding[] };

const stopWords = new Set([
  "a", "an", "and", "are", "for", "from", "how", "in", "is", "of", "on",
  "or", "that", "the", "to", "with", "you", "your", "i", "we", "it", "this",
  "need", "want", "question", "help",
]);

function tokens(value: string) {
  return [...new Set(value.toLowerCase().normalize("NFKC")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .split(/\s+/)
    .filter((token) => token.length > 2 && !stopWords.has(token)))];
}

function fingerprint(category: string, value: string) {
  return createHash("sha256")
    .update(`${category}|${tokens(value).sort().slice(0, 16).join("|")}`)
    .digest("hex");
}

function freshnessScore(detectedAt: Date, now = new Date()) {
  const ageDays = Math.max(0, (now.getTime() - detectedAt.getTime()) / 86_400_000);
  return Math.max(0, Math.min(1, 1 - ageDays / 90));
}

function urlFor(value: unknown, fallback: string) {
  return typeof value === "string" && /^https?:\/\//i.test(value) ? value : fallback;
}

async function getJson(url: string): Promise<unknown> {
  const response = await fetch(url, {
    headers: { accept: "application/json", "user-agent": "soy-money-os-discovery/1.0" },
    signal: AbortSignal.timeout(12_000),
  });
  if (!response.ok) throw new Error(`DISCOVERY_SOURCE_HTTP_${response.status}`);
  return response.json();
}

async function hackerNews(query: string): Promise<SourceResult> {
  const endpoint = `https://hn.algolia.com/api/v1/search_by_date?tags=story&hitsPerPage=20&query=${encodeURIComponent(query)}`;
  const payload = await getJson(endpoint) as { hits?: Array<Record<string, unknown>> };
  const findings = (payload.hits ?? []).flatMap((hit) => {
    const title = typeof hit.title === "string" ? hit.title.trim() : "";
    if (!title) return [];
    const objectId = String(hit.objectID ?? "");
    const detectedAt = typeof hit.created_at === "string" ? new Date(hit.created_at) : new Date();
    return [{
      source: "HACKER_NEWS",
      sourceUrl: urlFor(hit.url, `https://news.ycombinator.com/item?id=${objectId}`),
      detectedAt: Number.isNaN(detectedAt.getTime()) ? new Date() : detectedAt,
      titleClaim: title,
      excerpt: typeof hit.story_text === "string" ? hit.story_text.slice(0, 2_000) : "",
      independenceKey: "news.ycombinator.com",
      raw: hit,
    }];
  });
  return { source: "HACKER_NEWS", independenceKey: "news.ycombinator.com", findings };
}

async function stackExchange(query: string): Promise<SourceResult> {
  const endpoint = `https://api.stackexchange.com/2.3/search/advanced?order=desc&sort=activity&pagesize=20&site=stackoverflow&q=${encodeURIComponent(query)}`;
  const payload = await getJson(endpoint) as { items?: Array<Record<string, unknown>> };
  const findings = (payload.items ?? []).flatMap((item) => {
    const title = typeof item.title === "string" ? item.title.trim() : "";
    if (!title) return [];
    const epoch = Number(item.creation_date);
    return [{
      source: "STACK_EXCHANGE",
      sourceUrl: urlFor(item.link, endpoint),
      detectedAt: Number.isFinite(epoch) ? new Date(epoch * 1_000) : new Date(),
      titleClaim: title.replace(/<[^>]+>/g, ""),
      excerpt: typeof item.tags === "object" && Array.isArray(item.tags)
        ? item.tags.map(String).join(", ").slice(0, 2_000) : "",
      independenceKey: "stackexchange.com",
      raw: item,
    }];
  });
  return { source: "STACK_EXCHANGE", independenceKey: "stackexchange.com", findings };
}

async function github(query: string): Promise<SourceResult> {
  const endpoint = `https://api.github.com/search/issues?per_page=20&q=${encodeURIComponent(`${query} is:issue`)}`;
  const payload = await getJson(endpoint) as { items?: Array<Record<string, unknown>> };
  const findings = (payload.items ?? []).flatMap((item) => {
    const title = typeof item.title === "string" ? item.title.trim() : "";
    if (!title) return [];
    const created = typeof item.created_at === "string" ? new Date(item.created_at) : new Date();
    return [{
      source: "GITHUB_PUBLIC",
      sourceUrl: urlFor(item.html_url, endpoint),
      detectedAt: Number.isNaN(created.getTime()) ? new Date() : created,
      titleClaim: title,
      excerpt: typeof item.body === "string" ? item.body.slice(0, 2_000) : "",
      independenceKey: "github.com",
      raw: item,
    }];
  });
  return { source: "GITHUB_PUBLIC", independenceKey: "github.com", findings };
}

function overlap(left: string, right: string) {
  const a = new Set(tokens(left));
  const b = new Set(tokens(right));
  if (!a.size || !b.size) return 0;
  let shared = 0;
  for (const token of a) if (b.has(token)) shared += 1;
  return shared / Math.max(a.size, b.size);
}

function groupsFor(category: string, findings: Finding[]) {
  const groups: Finding[][] = [];
  for (const finding of findings) {
    const group = groups.find((candidate) => overlap(
      `${candidate[0].titleClaim} ${candidate[0].excerpt}`,
      `${finding.titleClaim} ${finding.excerpt}`,
    ) >= 0.5);
    if (group) group.push(finding);
    else groups.push([finding]);
  }
  return groups.map((group) => ({
    group,
    fingerprint: fingerprint(category, group[0].titleClaim),
  }));
}

function clamp(value: number, min: number, max: number) {
  return Math.max(min, Math.min(max, value));
}

/**
 * Auditable prioritisation only. No component below is a demand gate by
 * itself, and the historical adjustment is explicitly capped.
 */
export function scoreResearchGroup(
  group: Finding[],
  learningAdjustment = 0,
  now = new Date(),
) {
  const qualityBySource: Record<string, number> = {
    HACKER_NEWS: 0.65,
    STACK_EXCHANGE: 0.70,
    GITHUB_PUBLIC: 0.80,
  };
  const quality = group.reduce((sum, item) => sum + (qualityBySource[item.source] ?? 0.5), 0) / group.length;
  const independent = new Set(group.map((item) => item.independenceKey)).size;
  const independence = clamp(independent / 3, 0, 1);
  const freshness = group.reduce((sum, item) => sum + freshnessScore(item.detectedAt, now), 0) / group.length;
  const demand = clamp(group.filter((item) => item.excerpt || item.titleClaim).length / 3, 0, 1);
  const breakdown = {
    quality: Math.round(quality * 100),
    independence: Math.round(independence * 100),
    freshness: Math.round(freshness * 100),
    demand: Math.round(demand * 100),
    difficulty: 50,
    cost: 50,
    time: 50,
    risk: 50,
    confidence: Math.round(quality * independence * freshness * 100),
    learningAdjustment: clamp(Math.round(learningAdjustment), -5, 5),
  };
  const weighted = (
    breakdown.quality * 0.2
    + breakdown.independence * 0.2
    + breakdown.freshness * 0.15
    + breakdown.demand * 0.2
    + breakdown.difficulty * 0.1
    + breakdown.cost * 0.05
    + breakdown.time * 0.05
    + breakdown.risk * 0.05
  );
  return {
    breakdown,
    score: clamp(Math.round(weighted + breakdown.learningAdjustment), 0, 100),
    confidence: breakdown.confidence / 100,
  };
}

async function learningAdjustment(category: string) {
  const rows = await db.select({ delta: autonomyLearningTable.scoreDelta })
    .from(autonomyLearningTable)
    .where(eq(autonomyLearningTable.category, category))
    .orderBy(desc(autonomyLearningTable.createdAt))
    .limit(50);
  if (!rows.length) return 0;
  return clamp(rows.reduce((sum, row) => sum + row.delta, 0) / rows.length, -5, 5);
}

function validCategory(value: string): value is DiscoveryCategory {
  return (ALL_RESEARCH_CATEGORIES as readonly string[]).includes(value);
}

export type ResearchResult = {
  run: typeof discoveryResearchRunsTable.$inferSelect;
  opportunities: typeof opportunitiesTable.$inferSelect[];
  findings: typeof discoveryFindingsTable.$inferSelect[];
};

/**
 * Runs only public, unauthenticated source adapters. A network failure is
 * recorded as a rejected run; it never falls back to an existing category or
 * creates a synthetic opportunity.
 */
export async function researchCategory(input: {
  category: string;
  query?: string;
  idempotencyKey?: string;
}): Promise<ResearchResult> {
  const category = input.category.toUpperCase();
  if (!validCategory(category)) throw new Error("UNSUPPORTED_DISCOVERY_CATEGORY");
  const query = input.query?.trim() || queries[category];
  const idempotencyKey = input.idempotencyKey?.trim()
    || `discovery:${category}:${createHash("sha256").update(query).digest("hex").slice(0, 20)}`;

  const [createdRun] = await db.insert(discoveryResearchRunsTable).values({
    idempotencyKey, category, query, status: "RUNNING",
  }).onConflictDoNothing({ target: discoveryResearchRunsTable.idempotencyKey }).returning();
  const existingRun = createdRun
    ? null
    : (await db.select().from(discoveryResearchRunsTable)
      .where(eq(discoveryResearchRunsTable.idempotencyKey, idempotencyKey)).limit(1))[0];
  if (existingRun) {
    const [findings] = await Promise.all([
      db.select().from(discoveryFindingsTable).where(eq(discoveryFindingsTable.researchRunId, existingRun.id)),
    ]);
    const opportunities = existingRun.acceptedCount
      ? await db.select().from(opportunitiesTable)
        .where(sql`${opportunitiesTable.id} IN (
          SELECT opportunity_id FROM soy_discovery_findings WHERE research_run_id = ${existingRun.id}
            AND opportunity_id IS NOT NULL
        )`)
      : [];
    return { run: existingRun, findings, opportunities };
  }
  const run = createdRun;
  if (!run) throw new Error("DISCOVERY_RUN_PERSIST_FAILED");

  const adapters = [hackerNews, stackExchange, github];
  const settled = await Promise.allSettled(adapters.map((adapter) => adapter(query)));
  const successful = settled.flatMap((item) => item.status === "fulfilled" ? [item.value] : []);
  const findings = successful.flatMap((result) => result.findings);
  const independentSourceCount = new Set(successful.map((result) => result.independenceKey)).size;
  const now = new Date();
  const adjustment = await learningAdjustment(category);
  const groups = groupsFor(category, findings);
  const corroborated = groups.filter((group) =>
    new Set(group.group.map((finding) => finding.independenceKey)).size >= 2);
  const rejectionReason = category === "SPORTS"
    ? "SPORTS_RESEARCH_ONLY"
    : corroborated.length ? null
      : successful.length < 2 ? "INSUFFICIENT_INDEPENDENT_SOURCES" : "NO_CORROBORATED_EVIDENCE";

  const result = await db.transaction(async (tx) => {
    const savedFindings: typeof discoveryFindingsTable.$inferSelect[] = [];
    for (const finding of findings) {
      const group = groups.find((candidate) => candidate.group.includes(finding));
      if (!group) continue;
      const foundFingerprint = group.fingerprint;
      const [saved] = await tx.insert(discoveryFindingsTable).values({
        researchRunId: run.id,
        category,
        source: finding.source,
        sourceUrl: finding.sourceUrl,
        detectedAt: finding.detectedAt,
        titleClaim: finding.titleClaim,
        excerpt: finding.excerpt,
        evidenceType: "SEARCH_EVIDENCE",
        independenceKey: finding.independenceKey,
        freshnessScore: freshnessScore(finding.detectedAt, now),
        fingerprint: foundFingerprint,
        raw: finding.raw,
      }).onConflictDoNothing().returning();
      if (saved) savedFindings.push(saved);
      else {
        const [existing] = await tx.select().from(discoveryFindingsTable).where(and(
          eq(discoveryFindingsTable.researchRunId, run.id),
          eq(discoveryFindingsTable.sourceUrl, finding.sourceUrl),
          eq(discoveryFindingsTable.fingerprint, foundFingerprint),
        )).limit(1);
        if (existing) savedFindings.push(existing);
      }
    }

    const savedOpportunities: typeof opportunitiesTable.$inferSelect[] = [];
    if (!rejectionReason) {
      for (const group of corroborated) {
        const score = scoreResearchGroup(group.group, adjustment, now);
        const titleClaim = group.group[0].titleClaim;
        const sourceUrl = group.group[0].sourceUrl;
        const refs = group.group.map((item) => item.sourceUrl);
        let [opportunity] = await tx.select().from(opportunitiesTable)
          .where(eq(opportunitiesTable.fingerprint, group.fingerprint)).limit(1);
        if (!opportunity) {
          [opportunity] = await tx.insert(opportunitiesTable).values({
            name: titleClaim,
            titleClaim,
            description: `Observed public claim; corroborated by ${new Set(group.group.map((item) => item.independenceKey)).size} independent sources. This is not demand proof.`,
            sector: category,
            category,
            problem: titleClaim,
            targetCustomer: "Unassessed; source claim does not establish a customer segment.",
            proposedSolution: "Research-only validation of the observed claim; no build is inferred.",
            monetizationMethod: "UNASSESSED",
            score: score.score,
            estimatedCost: 0,
            difficulty: "UNASSESSED",
            risk: "UNASSESSED",
            timeToRevenue: "UNASSESSED",
            status: "DISCOVERED",
            proofStatus: "DEMAND_SIGNAL",
            source: group.group[0].source,
            sourceUrl,
            evidenceRefs: refs,
            fingerprint: group.fingerprint,
            researchStatus: "CORROBORATED",
            demandConfidence: score.confidence,
            detectedAt: new Date(Math.max(...group.group.map((item) => item.detectedAt.getTime()))),
          }).onConflictDoNothing().returning();
          opportunity ??= (await tx.select().from(opportunitiesTable)
            .where(eq(opportunitiesTable.fingerprint, group.fingerprint)).limit(1))[0];
        } else {
          [opportunity] = await tx.update(opportunitiesTable).set({
            score: score.score,
            proofStatus: opportunity.proofStatus === "REAL_VERIFIED" ? opportunity.proofStatus : "DEMAND_SIGNAL",
            evidenceRefs: [...new Set([...(opportunity.evidenceRefs ?? []), ...refs])],
            demandConfidence: Math.max(opportunity.demandConfidence, score.confidence),
            researchStatus: "CORROBORATED",
            updatedAt: now,
          }).where(eq(opportunitiesTable.id, opportunity.id)).returning();
        }
        if (!opportunity) continue;
        savedOpportunities.push(opportunity);
        for (const finding of group.group) {
          const [savedFinding] = await tx.update(discoveryFindingsTable).set({
            opportunityId: opportunity.id,
          }).where(and(
            eq(discoveryFindingsTable.researchRunId, run.id),
            eq(discoveryFindingsTable.sourceUrl, finding.sourceUrl),
            eq(discoveryFindingsTable.fingerprint, group.fingerprint),
          )).returning();
          const evidenceRef = `discovery:${group.fingerprint}:${createHash("sha256")
            .update(finding.sourceUrl).digest("hex").slice(0, 16)}`;
          await tx.insert(evidenceTable).values({
            opportunityId: opportunity.id,
            source: finding.source,
            url: finding.sourceUrl,
            collectedAt: finding.detectedAt,
            claim: finding.titleClaim,
            verificationStatus: "OBSERVED",
            contradictions: [],
            gaps: ["Independent demand proof and REAL_VERIFIED outcome are absent."],
            proofType: "SEARCH_EVIDENCE",
            evidenceRef,
            independenceKey: finding.independenceKey,
            freshnessScore: freshnessScore(finding.detectedAt, now),
          }).onConflictDoNothing();
          void savedFinding;
        }
        const [metadata] = await tx.select().from(opportunityMetadataTable)
          .where(eq(opportunityMetadataTable.opportunityId, opportunity.id)).limit(1);
        if (metadata) {
          await tx.update(opportunityMetadataTable).set({
            contentHash: group.fingerprint,
            similarityFingerprint: group.fingerprint,
            scoreBreakdown: score.breakdown,
            demandProofStatus: "DEMAND_SIGNAL",
            updatedAt: now,
          }).where(eq(opportunityMetadataTable.id, metadata.id));
        } else {
          await tx.insert(opportunityMetadataTable).values({
            opportunityId: opportunity.id,
            normalizedName: titleClaim.toLowerCase(),
            normalizedProblem: titleClaim.toLowerCase(),
            normalizedTarget: "unassessed",
            normalizedSolution: "research-only",
            contentHash: group.fingerprint,
            similarityFingerprint: group.fingerprint,
            scoreBreakdown: score.breakdown,
            demandProofStatus: "DEMAND_SIGNAL",
          }).onConflictDoNothing();
        }
      }
    }
    const [updatedRun] = await tx.update(discoveryResearchRunsTable).set({
      status: rejectionReason ? "REJECTED" : "COMPLETED",
      sourceCount: successful.length,
      independentSourceCount,
      acceptedCount: savedOpportunities.length,
      rejectionReason,
      scoreBreakdown: corroborated[0]
        ? scoreResearchGroup(corroborated[0].group, adjustment, now).breakdown : {},
      completedAt: now,
      updatedAt: now,
    }).where(eq(discoveryResearchRunsTable.id, run.id)).returning();
    return { run: updatedRun ?? run, opportunities: savedOpportunities, findings: savedFindings };
  });
  return result;
}