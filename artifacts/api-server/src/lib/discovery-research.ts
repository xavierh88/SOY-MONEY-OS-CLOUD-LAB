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

export const DISCOVERY_QUERY_VARIANTS: Record<DiscoveryCategory, readonly string[]> = {
  BUSINESS: [
    "small business workflow problem",
    "small business owner frustrated manual process",
    "customer complaint business process",
  ],
  DIGITAL_PRODUCTS: [
    "digital product feature request",
    "template toolkit ebook user problem",
    "downloadable product customer request",
  ],
  SERVICES: [
    "freelance service problem request",
    "looking for help with business task",
    "consultant service request repetitive problem",
  ],
  SAAS: [
    "software as a service feature request",
    "software users frustrated workflow",
    "missing integration product request",
  ],
  AUTOMATION: [
    "automation repetitive task request",
    "manual process should be automated",
    "spreadsheet copy paste workflow problem",
  ],
  AFFILIATE: [
    "product recommendation request comparison",
    "which tool should I use comparison",
    "best product for solving problem request",
  ],
  OTHER_LEGAL_OPPORTUNITIES: [
    "business problem customer request",
    "underserved customer need legal business",
    "workflow pain point people pay to solve",
  ],
  SPORTS: [
    "sports workflow problem feature request",
    "athlete coach team software request",
    "sports training repetitive task problem",
  ],
};

const queries: Record<DiscoveryCategory, string> = {
  BUSINESS: DISCOVERY_QUERY_VARIANTS.BUSINESS[0],
  DIGITAL_PRODUCTS: DISCOVERY_QUERY_VARIANTS.DIGITAL_PRODUCTS[0],
  SERVICES: DISCOVERY_QUERY_VARIANTS.SERVICES[0],
  SAAS: DISCOVERY_QUERY_VARIANTS.SAAS[0],
  AUTOMATION: DISCOVERY_QUERY_VARIANTS.AUTOMATION[0],
  AFFILIATE: DISCOVERY_QUERY_VARIANTS.AFFILIATE[0],
  OTHER_LEGAL_OPPORTUNITIES: DISCOVERY_QUERY_VARIANTS.OTHER_LEGAL_OPPORTUNITIES[0],
  SPORTS: DISCOVERY_QUERY_VARIANTS.SPORTS[0],
};

export type DiscoveryFindingInput = {
  source: string;
  sourceUrl: string;
  detectedAt: Date;
  titleClaim: string;
  excerpt: string;
  independenceKey: string;
  raw: Record<string, unknown>;
};

type Finding = DiscoveryFindingInput & {
  relevanceScore?: number;
  diagnostic?: CandidateDiagnostic;
};

type SourceResult = { source: string; independenceKey: string; findings: Finding[] };

export type CandidateDiagnostic = {
  candidateFingerprint: string;
  semanticKey: string;
  searchQueries: string[];
  providerAttempts?: ProviderAttemptDiagnostic[];
  relevanceScore: number;
  freshnessScore: number;
  candidateStatus: "PASS" | "FAIL";
  rejectionReasons: string[];
  independentSourceCount: number;
  duplicateClass: "UNIQUE" | "SAME_SOURCE_DUPLICATE" | "CROSS_SOURCE_MATCH" | "SYNDICATED_ORIGIN";
};

export type ProviderAttemptDiagnostic = {
  provider: string;
  query: string;
  status: "SUCCEEDED" | "FAILED";
  resultCount: number;
  error?: string;
};

const stopWords = new Set([
  "a", "an", "and", "are", "for", "from", "how", "in", "is", "of", "on",
  "or", "that", "the", "to", "with", "you", "your", "i", "we", "it", "this",
  "need", "want", "question", "help", "please", "looking", "best", "way",
  "tool", "tools", "software", "product", "request", "feature", "problem",
]);

const semanticAliases: Record<string, string> = {
  billing: "invoice", invoicing: "invoice", payment: "invoice", payments: "invoice",
  auth: "login", authentication: "login", signin: "login", "sign-in": "login",
  schedule: "calendar", scheduling: "calendar", appointment: "calendar",
  appointments: "calendar", booking: "calendar",
  reporting: "analytics", dashboard: "analytics", metrics: "analytics",
  notification: "email", notifications: "email", messaging: "email",
  integration: "integrate", integrations: "integrate", api: "integrate",
  repetitive: "manual", manually: "manual", copy: "manual", paste: "manual",
  customer: "client", customers: "client", users: "client", user: "client",
  ecommerce: "checkout", shop: "checkout", store: "checkout",
};

function normalizeSemanticToken(token: string) {
  const alias = semanticAliases[token] ?? token;
  if (alias.length > 5 && alias.endsWith("ies")) return `${alias.slice(0, -3)}y`;
  if (alias.length > 5 && alias.endsWith("ing")) return alias.slice(0, -3);
  if (alias.length > 4 && alias.endsWith("s")) return alias.slice(0, -1);
  return alias;
}

export function tokens(value: string) {
  return [...new Set(value.toLowerCase().normalize("NFKC")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .split(/\s+/)
    .filter((token) => token.length > 2 && !stopWords.has(token))
    .map(normalizeSemanticToken))];
}

function semanticKey(value: string) {
  return tokens(value).sort().join("|");
}

export function fingerprint(category: string, value: string) {
  return createHash("sha256")
    .update(`${category}|${semanticKey(value).split("|").slice(0, 24).join("|")}`)
    .digest("hex");
}

function groupFingerprint(category: string, group: readonly Finding[]) {
  return createHash("sha256")
    .update(`${category}|${group.map(canonicalClaim).sort().join("||")}`)
    .digest("hex");
}

export function freshnessScore(detectedAt: Date, now = new Date()) {
  const ageDays = Math.max(0, (now.getTime() - detectedAt.getTime()) / 86_400_000);
  return Math.max(0, Math.min(1, 1 - ageDays / 90));
}

// Keep discovery eligibility inside the stricter owner-checkpoint freshness
// window. A candidate that cannot enter review must not be counted as accepted.
const MAX_FINDING_AGE_DAYS = 49;
const MIN_RELEVANCE_SCORE = 0.12;

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

function exactErrorMessage(reason: unknown) {
  if (reason instanceof Error) return reason.message;
  if (typeof reason === "string") return reason;
  try {
    return JSON.stringify(reason);
  } catch {
    return String(reason);
  }
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

/**
 * Search APIs are useful recall mechanisms, not proof. This score is only
 * used to discard plainly unrelated hits and is persisted for auditability.
 */
export function relevanceScore(finding: DiscoveryFindingInput, query: string, category: DiscoveryCategory) {
  const body = `${finding.titleClaim} ${finding.excerpt}`;
  const queryTerms = new Set(tokens(`${query} ${DISCOVERY_QUERY_VARIANTS[category].join(" ")}`));
  const bodyTerms = new Set(tokens(body));
  let shared = 0;
  for (const token of bodyTerms) if (queryTerms.has(token)) shared += 1;
  const queryOverlap = shared / Math.max(3, Math.min(bodyTerms.size, queryTerms.size));
  const titleTerms = new Set(tokens(finding.titleClaim));
  let titleShared = 0;
  for (const token of titleTerms) if (queryTerms.has(token)) titleShared += 1;
  const titleOverlap = titleShared / Math.max(3, Math.min(titleTerms.size, queryTerms.size));
  return Math.min(1, queryOverlap * 0.65 + titleOverlap * 0.35);
}

function canonicalClaim(finding: DiscoveryFindingInput) {
  // Titles are the stable cross-provider claim identity; excerpts often have
  // provider-specific formatting (tags, markdown, or truncated bodies).
  return semanticKey(finding.titleClaim);
}

function canonicalSourceUrl(sourceUrl: string) {
  try {
    const url = new URL(sourceUrl);
    url.hostname = url.hostname.toLowerCase().replace(/^www\./, "");
    url.hash = "";
    for (const key of [...url.searchParams.keys()]) {
      if (/^(utm_|ref$|source$|fbclid$)/i.test(key)) url.searchParams.delete(key);
    }
    const githubIssue = url.pathname.match(/^\/repos\/([^/]+)\/([^/]+)\/issues\/(\d+)/i);
    if (url.hostname === "api.github.com" && githubIssue) {
      return `https://github.com/${githubIssue[1]}/${githubIssue[2]}/issues/${githubIssue[3]}`;
    }
    return url.toString().replace(/\/$/, "");
  } catch {
    return sourceUrl;
  }
}

const genericClaimTokens = new Set([
  "small", "large", "team", "business", "workflow", "work", "task", "process",
  "customer", "client", "owner", "people", "user", "manual", "need", "want",
  "request", "feature", "problem", "issue", "thing", "way",
]);
const actorTokens = new Set([
  "team", "business", "owner", "client", "customer", "developer", "engineer",
  "manager", "employee", "creator", "seller", "athlete", "coach", "patient",
]);
const workflowTokens = new Set([
  "invoice", "login", "calendar", "analytics", "email", "integrate", "checkout",
  "reminder", "schedule", "booking", "report", "deploy", "search", "payment",
  "content", "order", "inventory", "training",
]);
const problemTokens = new Set([
  "manual", "slow", "error", "missing", "broken", "hard", "difficult", "repetitive",
  "copy", "duplicate", "delay", "friction", "automate", "automation", "tracking",
  "export", "import", "overwhelming", "expensive", "unreliable",
]);

function claimDimensions(finding: DiscoveryFindingInput) {
  const claimTokens = new Set(tokens(`${finding.titleClaim} ${finding.excerpt}`));
  const actor = new Set([...claimTokens].filter((token) => actorTokens.has(token)));
  const workflow = new Set([...claimTokens].filter((token) => workflowTokens.has(token)));
  const problem = new Set([...claimTokens].filter((token) => problemTokens.has(token)));
  const entity = new Set([...claimTokens].filter((token) => !genericClaimTokens.has(token)));
  return { actor, workflow, problem, entity };
}

function sharedCount(left: Set<string>, right: Set<string>) {
  let count = 0;
  for (const token of left) if (right.has(token)) count += 1;
  return count;
}

function originUrls(finding: DiscoveryFindingInput) {
  const values = [finding.sourceUrl];
  for (const key of ["url", "html_url", "link", "story_url", "api_url", "repository_url"]) {
    const value = finding.raw[key];
    if (typeof value === "string" && /^https?:\/\//i.test(value)) values.push(value);
  }
  return new Set(values.map(canonicalSourceUrl));
}

function repositoryIdentifiers(finding: DiscoveryFindingInput) {
  const values: string[] = [];
  const raw = finding.raw;
  for (const key of ["repository_url", "repository", "repo_url"]) {
    const value = raw[key];
    if (typeof value === "string") values.push(value);
    else if (value && typeof value === "object") {
      const record = value as Record<string, unknown>;
      for (const nestedKey of ["html_url", "url", "full_name"]) {
        if (typeof record[nestedKey] === "string") values.push(record[nestedKey]);
      }
    }
  }
  return new Set(values.map((value) => {
    if (/^https?:\/\//i.test(value)) {
      const normalized = canonicalSourceUrl(value);
      const match = normalized.match(/^https:\/\/github\.com\/([^/]+\/[^/]+)/i);
      return match ? match[1].toLowerCase() : normalized;
    }
    return value.toLowerCase().replace(/^github:/, "");
  }));
}

function authorIdentifiers(finding: DiscoveryFindingInput) {
  const raw = finding.raw;
  const values: string[] = [];
  if (typeof raw.author === "string") values.push(raw.author);
  for (const key of ["user", "owner", "author"]) {
    const value = raw[key];
    if (value && typeof value === "object") {
      const record = value as Record<string, unknown>;
      for (const nestedKey of ["id", "user_id", "login", "display_name"]) {
        if (typeof record[nestedKey] === "string" || typeof record[nestedKey] === "number") {
          values.push(String(record[nestedKey]));
        }
      }
    }
  }
  return new Set(values.map((value) => value.trim().toLowerCase()).filter(Boolean));
}

function syndicatedOrigin(left: DiscoveryFindingInput, right: DiscoveryFindingInput) {
  const rightOrigins = originUrls(right);
  if ([...originUrls(left)].some((origin) => rightOrigins.has(origin))) return true;
  const leftRepositories = repositoryIdentifiers(left);
  const rightRepositories = repositoryIdentifiers(right);
  if ([...leftRepositories].some((repository) => rightRepositories.has(repository))) return true;
  const leftAuthors = authorIdentifiers(left);
  const rightAuthors = authorIdentifiers(right);
  return [...leftAuthors].some((author) => rightAuthors.has(author));
}

export function claimsMatch(left: DiscoveryFindingInput, right: DiscoveryFindingInput) {
  if (left.independenceKey === right.independenceKey || syndicatedOrigin(left, right)) return false;
  const leftDimensions = claimDimensions(left);
  const rightDimensions = claimDimensions(right);
  if (
    leftDimensions.actor.size > 0
    && rightDimensions.actor.size > 0
    && sharedCount(leftDimensions.actor, rightDimensions.actor) === 0
  ) return false;
  const sharedEntities = sharedCount(leftDimensions.entity, rightDimensions.entity);
  const sharedWorkflows = sharedCount(leftDimensions.workflow, rightDimensions.workflow);
  const sharedProblems = sharedCount(leftDimensions.problem, rightDimensions.problem);
  // A pair must share a concrete entity/workflow and a problem signal. This
  // deliberately rejects transitive "bag of words" bridges and generic-only
  // matches such as "small team workflow".
  return sharedEntities >= 1 && sharedWorkflows > 0 && sharedProblems > 0;
}

/**
 * Resolve a problem/entity across providers with deterministic pairwise
 * agreement cliques. Finding order never changes candidate membership.
 */
export function groupResearchFindings(category: DiscoveryCategory, findings: readonly Finding[]) {
  const ordered = deduplicateFindings(findings).sort((left, right) =>
    `${left.source}|${canonicalSourceUrl(left.sourceUrl)}|${canonicalClaim(left)}`
      .localeCompare(`${right.source}|${canonicalSourceUrl(right.sourceUrl)}|${canonicalClaim(right)}`));
  const groups = new Map<string, Finding[]>();
  // Do not union edges: A~B and B~C must not silently become A~B~C.
  // Each candidate is a deterministic direct-agreement clique grown only
  // when the new finding agrees with every member already in the clique.
  for (let anchor = 0; anchor < ordered.length; anchor += 1) {
    const group = [ordered[anchor]];
    for (let index = 0; index < ordered.length; index += 1) {
      if (index === anchor) continue;
      if (group.every((member) => claimsMatch(member, ordered[index]))) {
        group.push(ordered[index]);
      }
    }
    const candidateFingerprint = groupFingerprint(category, group);
    groups.set(candidateFingerprint, group);
  }
  const maximalGroups = [...groups.values()].filter((group) =>
    ![...groups.values()].some((other) =>
      other.length > group.length
      && group.every((member) => other.includes(member))));
  return maximalGroups
    .sort((left, right) => canonicalClaim(left[0]).localeCompare(canonicalClaim(right[0])))
    .map((group) => ({
      group,
      fingerprint: groupFingerprint(category, group),
    }));
}

function deduplicateFindings(findings: readonly Finding[]) {
  const seen = new Map<string, Finding>();
  for (const finding of findings) {
    const key = `${finding.independenceKey}|${canonicalClaim(finding)}`;
    const existing = seen.get(key);
    if (!existing || (finding.relevanceScore ?? 0) > (existing.relevanceScore ?? 0)) {
      seen.set(key, finding);
    }
  }
  return [...seen.values()];
}

function diagnosticRaw(finding: Finding, diagnostic: CandidateDiagnostic) {
  return {
    ...finding.raw,
    _discovery: diagnostic,
  };
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

function queryVariants(category: DiscoveryCategory, query: string) {
  return [...new Set([query, ...DISCOVERY_QUERY_VARIANTS[category]])];
}

function findingPassesFreshness(finding: DiscoveryFindingInput, now: Date) {
  const ageDays = (now.getTime() - finding.detectedAt.getTime()) / 86_400_000;
  return ageDays <= MAX_FINDING_AGE_DAYS && ageDays >= -2;
}

export function evaluateFinding(
  finding: DiscoveryFindingInput,
  query: string,
  category: DiscoveryCategory,
  now = new Date(),
) {
  const score = relevanceScore(finding, query, category);
  const rejectionReasons: string[] = [];
  if (!findingPassesFreshness(finding, now)) rejectionReasons.push("FRESHNESS_BELOW_THRESHOLD");
  if (score < MIN_RELEVANCE_SCORE) rejectionReasons.push("LOW_SEMANTIC_RELEVANCE");
  return {
    eligible: rejectionReasons.length === 0,
    relevanceScore: score,
    freshnessScore: freshnessScore(finding.detectedAt, now),
    rejectionReasons,
  };
}

function prepareFindings(
  category: DiscoveryCategory,
  findings: Finding[],
  query: string,
  now: Date,
) {
  const prepared = findings.map((finding) => ({
    ...finding,
    relevanceScore: evaluateFinding(finding, query, category, now).relevanceScore,
  }));
  const eligible = deduplicateFindings(prepared).filter((finding) =>
    evaluateFinding(finding, query, category, now).eligible);
  return { prepared, eligible };
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

  const now = new Date();
  const searchQueries = queryVariants(category, query);
  const adapters = [
    { provider: "HACKER_NEWS", independenceKey: "news.ycombinator.com", run: hackerNews },
    { provider: "STACK_EXCHANGE", independenceKey: "stackexchange.com", run: stackExchange },
    { provider: "GITHUB_PUBLIC", independenceKey: "github.com", run: github },
  ];
  const attempts = adapters.flatMap((adapter) =>
    searchQueries.map((searchQuery) => ({ adapter, searchQuery })));
  const settled = await Promise.allSettled(attempts.map(({ adapter, searchQuery }) => adapter.run(searchQuery)));
  const providerAttempts: ProviderAttemptDiagnostic[] = settled.map((item, index) => ({
    provider: attempts[index].adapter.provider,
    query: attempts[index].searchQuery,
    status: item.status === "fulfilled" ? "SUCCEEDED" : "FAILED",
    resultCount: item.status === "fulfilled" ? item.value.findings.length : 0,
    ...(item.status === "rejected" ? {
      error: exactErrorMessage(item.reason),
    } : {}),
  }));
  const successfulAttempts = settled.flatMap((item) => item.status === "fulfilled" ? [item.value] : []);
  const sourceResults = new Map<string, SourceResult>();
  for (const result of successfulAttempts) {
    const existing = sourceResults.get(result.source);
    sourceResults.set(result.source, {
      source: result.source,
      independenceKey: result.independenceKey,
      findings: [...(existing?.findings ?? []), ...result.findings],
    });
  }
  const successful = [...sourceResults.values()];
  const rawFindings = successful.flatMap((result) => result.findings);
  const { prepared: findings, eligible } = prepareFindings(category, rawFindings, query, now);
  const independentSourceCount = new Set(successful.map((result) => result.independenceKey)).size;
  const adjustment = await learningAdjustment(category);
  const groups = groupResearchFindings(category, eligible);
  const corroborated = groups.filter((group) =>
    new Set(group.group.map((finding) => finding.independenceKey)).size >= 2);
  const rejectionReason = category === "SPORTS"
    ? "SPORTS_RESEARCH_ONLY"
    : corroborated.length ? null
      : successful.length < 2 ? "INSUFFICIENT_INDEPENDENT_SOURCES" : "NO_CORROBORATED_EVIDENCE";
  const eligibleGroup = new Map<Finding, { group: Finding[]; fingerprint: string }>();
  for (const group of groups) {
    for (const finding of group.group) eligibleGroup.set(finding, group);
  }
  const sourceClaimCounts = new Map<string, number>();
  for (const finding of findings) {
    const key = `${finding.independenceKey}|${canonicalClaim(finding)}`;
    sourceClaimCounts.set(key, (sourceClaimCounts.get(key) ?? 0) + 1);
  }
  const crossSourceClaims = new Map<string, Set<string>>();
  for (const finding of findings) {
    const key = canonicalClaim(finding);
    const sources = crossSourceClaims.get(key) ?? new Set<string>();
    sources.add(finding.independenceKey);
    crossSourceClaims.set(key, sources);
  }
  for (const finding of findings) {
    const group = eligibleGroup.get(finding);
    const independent = group
      ? new Set(group.group.map((item) => item.independenceKey)).size : 0;
    const reasons: string[] = [];
    if (!findingPassesFreshness(finding, now)) reasons.push("FRESHNESS_BELOW_THRESHOLD");
    if ((finding.relevanceScore ?? 0) < MIN_RELEVANCE_SCORE) reasons.push("LOW_SEMANTIC_RELEVANCE");
    if (group && independent < 2) reasons.push("INSUFFICIENT_INDEPENDENT_SOURCES");
    if (category === "SPORTS") reasons.push("SPORTS_RESEARCH_ONLY");
    const duplicateKey = `${finding.independenceKey}|${canonicalClaim(finding)}`;
    const syndicated = findings.some((other) => other !== finding && syndicatedOrigin(finding, other));
    if (syndicated) reasons.push("SYNDICATED_ORIGIN_NOT_INDEPENDENT");
    const duplicateClass = syndicated
      ? "SYNDICATED_ORIGIN"
      : (sourceClaimCounts.get(duplicateKey) ?? 0) > 1
      ? "SAME_SOURCE_DUPLICATE"
      : (crossSourceClaims.get(canonicalClaim(finding))?.size ?? 0) > 1
        ? "CROSS_SOURCE_MATCH" : "UNIQUE";
    const candidateFingerprint = group?.fingerprint
      ?? fingerprint(category, `${finding.titleClaim} ${finding.excerpt}`);
    finding.diagnostic = {
      candidateFingerprint,
      semanticKey: semanticKey(`${finding.titleClaim} ${finding.excerpt}`),
      searchQueries,
      providerAttempts,
      relevanceScore: Number((finding.relevanceScore ?? 0).toFixed(4)),
      freshnessScore: Number(freshnessScore(finding.detectedAt, now).toFixed(4)),
      candidateStatus: !reasons.length && Boolean(group && corroborated.includes(group))
        ? "PASS" : "FAIL",
      rejectionReasons: reasons.length ? reasons : (group && corroborated.includes(group)
        ? [] : ["NO_CORROBORATED_EVIDENCE"]),
      independentSourceCount: independent,
      duplicateClass,
    };
  }

  const result = await db.transaction(async (tx) => {
    const savedFindings: typeof discoveryFindingsTable.$inferSelect[] = [];
    for (const finding of findings) {
      const group = groups.find((candidate) => candidate.group.includes(finding));
      const foundFingerprint = finding.diagnostic?.candidateFingerprint
        ?? group?.fingerprint
        ?? fingerprint(category, `${finding.titleClaim} ${finding.excerpt}`);
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
        raw: diagnosticRaw(finding, finding.diagnostic ?? {
          candidateFingerprint: foundFingerprint,
          semanticKey: semanticKey(`${finding.titleClaim} ${finding.excerpt}`),
          searchQueries,
          providerAttempts,
          relevanceScore: 0,
          freshnessScore: freshnessScore(finding.detectedAt, now),
          candidateStatus: "FAIL",
          rejectionReasons: ["NO_CORROBORATED_EVIDENCE"],
          independentSourceCount: 0,
          duplicateClass: "UNIQUE",
        }),
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
    const scoreBreakdown = corroborated[0]
      ? scoreResearchGroup(corroborated[0].group, adjustment, now).breakdown : {};
    const runMetadata = {
      ...scoreBreakdown,
      discoveryAttempts: providerAttempts,
    } as unknown as Record<string, number>;
    const [updatedRun] = await tx.update(discoveryResearchRunsTable).set({
      status: rejectionReason ? "REJECTED" : "COMPLETED",
      sourceCount: successful.length,
      independentSourceCount,
      acceptedCount: savedOpportunities.length,
      rejectionReason,
      scoreBreakdown: runMetadata,
      completedAt: now,
      updatedAt: now,
    }).where(eq(discoveryResearchRunsTable.id, run.id)).returning();
    return { run: updatedRun ?? run, opportunities: savedOpportunities, findings: savedFindings };
  });
  return result;
}