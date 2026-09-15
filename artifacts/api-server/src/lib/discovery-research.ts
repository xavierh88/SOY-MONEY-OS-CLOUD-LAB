import { createHash, randomUUID } from "node:crypto";
import {
  and,
  desc,
  eq,
  isNull,
  lt,
  or,
  sql,
} from "drizzle-orm";
import {
  autonomyLearningTable,
  db,
  discoveryFindingsTable,
  discoveryProviderAttemptsTable,
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

export const BRAVE_SEARCH_ENDPOINT = "https://api.search.brave.com/res/v1/web/search";
export const MAX_BRAVE_REQUESTS_PER_RUN = 30;
export const STOP_BRAVE_BUDGET_REACHED = "STOP_BRAVE_BUDGET_REACHED";
const UNKNOWN_PUBLICATION_DATE = new Date(0);

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
  gates?: CandidateGateDiagnostics;
};

export type ProviderAttemptDiagnostic = {
  provider: string;
  query: string;
  stage?: "BROAD" | "TARGETED";
  status: "SUCCEEDED" | "FAILED" | "UNKNOWN";
  resultCount: number;
  error?: string;
};

export type BraveRequestCounters = {
  brave_requests_attempted: number;
  brave_requests_successful: number;
  brave_requests_failed: number;
};

export type NormalizedBraveResult = {
  title: string;
  url: string;
  domain: string;
  description: string;
  retrievedAt: Date;
  publicationDate: Date | null;
  publicationDateStatus: "UNKNOWN" | "VERIFIED";
  stage?: "BROAD" | "TARGETED";
};

export type CandidateGateDiagnostics = {
  commercialIntent: "PASS" | "FAIL";
  demandSignal: "PASS" | "FAIL";
  legalNonProhibited: "PASS" | "FAIL";
  zeroCapitalFeasible: "PASS" | "FAIL";
  minimumQualityConfidence: "PASS" | "FAIL";
  passed: boolean;
  rejectionReasons: string[];
};

type BraveCheckpoint = {
  counters: BraveRequestCounters;
  attempts: ProviderAttemptDiagnostic[];
  normalizedResults: NormalizedBraveResult[];
};

type BraveSearchDependencies = {
  fetch?: typeof fetch;
  getApiKey?: () => string | undefined;
  now?: () => Date;
  timeoutMs?: number;
  category?: DiscoveryCategory;
  query?: string;
  completedQueries?: readonly string[];
  checkpoint?: Partial<BraveCheckpoint>;
  onAttempt?: (checkpoint: BraveCheckpoint) => void | Promise<void>;
  reserveAttempt?: (reservation: { provider: string; query: string; stage: "BROAD" | "TARGETED" }) => boolean | Promise<boolean>;
  completeAttempt?: (
    reservation: { provider: string; query: string; stage: "BROAD" | "TARGETED" },
    status: "SUCCEEDED" | "FAILED" | "UNKNOWN",
    resultCount: number,
    errorCode?: string,
    normalizedResults?: Record<string, unknown>[],
  ) => void | Promise<void>;
  maxRequests?: number;
};

/**
 * Public-source adapters intentionally accept only transport dependencies.
 * This keeps contract tests deterministic without changing the production
 * provider URLs, response handling, or discovery rules.
 */
export type PublicProviderDependencies = {
  fetch?: typeof fetch;
  timeoutMs?: number;
};

export type PublicProviderPage = {
  page?: number;
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
  if (!Number.isFinite(detectedAt.getTime())) return 0;
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

/**
 * The result URL, rather than Brave itself, is the provenance boundary. This
 * intentionally returns the underlying host and never api.search.brave.com.
 */
export function canonicalResultDomain(value: string) {
  try {
    const url = new URL(value);
    const hostname = url.hostname.toLowerCase().replace(/^www\./, "");
    const labels = hostname.split(".").filter(Boolean);
    if (labels.length <= 2) return labels.join(".");
    const compoundTlds = new Set([
      "co.uk", "org.uk", "gov.uk", "ac.uk", "com.au", "net.au", "org.au",
      "co.nz", "co.jp", "com.br", "com.cn", "co.in", "github.io",
      "vercel.app", "netlify.app", "herokuapp.com", "pages.dev", "blogspot.com",
    ]);
    const suffix = labels.slice(-2).join(".");
    return compoundTlds.has(suffix)
      ? labels.slice(-3).join(".")
      : labels.slice(-2).join(".");
  } catch {
    return "";
  }
}

function findingIndependenceKey(finding: DiscoveryFindingInput) {
  return canonicalResultDomain(finding.sourceUrl)
    || canonicalResultDomain(finding.independenceKey)
    || finding.independenceKey.trim().toLowerCase();
}

function parseVerifiablePublicationDate(value: unknown) {
  if (typeof value !== "string" || !value.trim()) return null;
  const parsed = new Date(value);
  return Number.isFinite(parsed.getTime()) ? parsed : null;
}

/**
 * Brave's search response contains crawl and presentation metadata as well
 * as the result itself. Only an explicit publication date is accepted here;
 * crawl age, retrievedAt, and an absent date are not publication evidence.
 */
export function normalizeBraveResult(
  value: unknown,
  retrievedAt = new Date(),
): NormalizedBraveResult | null {
  if (!value || typeof value !== "object") return null;
  const result = value as Record<string, unknown>;
  const title = typeof result.title === "string" ? result.title.trim() : "";
  const url = typeof result.url === "string" && /^https?:\/\//i.test(result.url)
    ? canonicalSourceUrl(result.url)
    : "";
  const domain = canonicalResultDomain(url);
  if (!title || !url || !domain) return null;
  const descriptionValue = result.description ?? result.long_desc;
  const description = typeof descriptionValue === "string"
    ? descriptionValue.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim().slice(0, 2_000)
    : "";
  const publicationDate = [
    result.published_date,
    result.publication_date,
    result.date_published,
    result.datePublished,
  ].map(parseVerifiablePublicationDate).find((date): date is Date => Boolean(date)) ?? null;
  return {
    title,
    url,
    domain,
    description,
    retrievedAt,
    publicationDate,
    publicationDateStatus: publicationDate ? "VERIFIED" : "UNKNOWN",
  };
}

async function getJson(
  url: string,
  dependencies: PublicProviderDependencies,
  provider: string,
): Promise<unknown> {
  const response = await (dependencies.fetch ?? fetch)(url, {
    headers: { accept: "application/json", "user-agent": "soy-money-os-discovery/1.0" },
    signal: AbortSignal.timeout(dependencies.timeoutMs ?? 12_000),
  });
  if (!response.ok) throw new Error(`DISCOVERY_SOURCE_HTTP_${response.status}`);
  try {
    return await response.json();
  } catch {
    throw new Error(`${provider}_MALFORMED_PAYLOAD`);
  }
}

function braveApiKey() {
  const value = process.env.BRAVE_SEARCH_API_KEY;
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

/**
 * Dependency injection is limited to the transport and environment lookup so
 * tests can inspect the official request without making a public call. The
 * production lookup is process.env.BRAVE_SEARCH_API_KEY only.
 */
export function createBraveSearchAdapter(dependencies: BraveSearchDependencies = {}) {
  const transport = dependencies.fetch ?? fetch;
  const getApiKey = dependencies.getApiKey ?? braveApiKey;
  const now = dependencies.now ?? (() => new Date());
  return async (query: string, options: PublicProviderPage = {}): Promise<SourceResult> => {
    const apiKey = getApiKey();
    if (!apiKey) throw new Error("BRAVE_SEARCH_API_KEY_MISSING");
    const endpoint = new URL(BRAVE_SEARCH_ENDPOINT);
    endpoint.searchParams.set("q", query);
    endpoint.searchParams.set("count", "20");
    if (Number.isInteger(options.page) && (options.page ?? 0) >= 1) {
      endpoint.searchParams.set("offset", String((options.page! - 1) * 20));
    }
    const response = await transport(endpoint.toString(), {
      method: "GET",
      headers: {
        accept: "application/json",
        "X-Subscription-Token": apiKey,
      },
      signal: AbortSignal.timeout(dependencies.timeoutMs ?? 12_000),
    });
    if (!response.ok) throw new Error(`BRAVE_SEARCH_HTTP_${response.status}`);
    let payload: unknown;
    try {
      payload = await response.json();
    } catch {
      throw new Error("BRAVE_SEARCH_MALFORMED_PAYLOAD");
    }
    if (
      !payload
      || typeof payload !== "object"
      || !("web" in payload)
      || !payload.web
      || typeof payload.web !== "object"
      || !Array.isArray((payload.web as { results?: unknown }).results)
    ) {
      throw new Error("BRAVE_SEARCH_MALFORMED_PAYLOAD");
    }
    const braveResults = (payload.web as { results: unknown[] }).results;
    const retrievedAt = now();
    const findings = braveResults.flatMap((item) => {
      const normalized = normalizeBraveResult(item, retrievedAt);
      if (!normalized) return [];
      return [findingFromBraveResult(normalized)];
    });
    return { source: "BRAVE_SEARCH", independenceKey: "brave-search", findings };
  };
}

function findingFromBraveResult(normalized: NormalizedBraveResult): Finding {
  return {
    source: "BRAVE_SEARCH",
    sourceUrl: normalized.url,
    // Brave is a discovery transport. Independence belongs to the
    // underlying result origin, never the aggregator.
    independenceKey: normalized.domain,
    detectedAt: normalized.publicationDate ?? UNKNOWN_PUBLICATION_DATE,
    titleClaim: normalized.title,
    excerpt: normalized.description,
    raw: {
      url: normalized.url,
      domain: normalized.domain,
      description: normalized.description,
      retrievedAt: normalized.retrievedAt.toISOString(),
      publicationDate: normalized.publicationDate?.toISOString() ?? "UNKNOWN",
      publication_date_status: normalized.publicationDateStatus,
    },
  };
}

const braveStageAIntent: Record<DiscoveryCategory, string> = {
  BUSINESS: "small business customer willing to pay workflow solution",
  DIGITAL_PRODUCTS: "digital product buyer request pain point",
  SERVICES: "client looking to hire service for recurring problem",
  SAAS: "business customer looking for software solution",
  AUTOMATION: "business willing to pay to automate manual work",
  AFFILIATE: "buyer comparing products to solve a problem",
  OTHER_LEGAL_OPPORTUNITIES: "customer demand for a legal business solution",
  SPORTS: "coach or athlete looking for a paid workflow solution",
};

export function generateBraveStageAQueries(category: DiscoveryCategory, query: string) {
  const intent = braveStageAIntent[category];
  return [...new Set([
    `${query} ${intent}`,
    `${intent} ${query} customer request`,
  ])].map((value) => value.trim().slice(0, 240)).slice(0, 2);
}

export function generateBraveTargetedQueries(
  findings: readonly Finding[],
  category: DiscoveryCategory,
) {
  const ranked = deduplicateFindings(findings)
    .sort((left, right) => (right.relevanceScore ?? 0) - (left.relevanceScore ?? 0))
    .slice(0, 4);
  return [...new Set(ranked.map((finding) =>
    `${finding.titleClaim} ${braveStageAIntent[category]} independent customer evidence`
      .slice(0, 240)))];
}

export async function runBraveSearchFunnel(
  searchQueries: readonly string[],
  dependencies: BraveSearchDependencies & { maxRequests?: number } = {},
) {
  const prior = dependencies.checkpoint;
  const counters: BraveRequestCounters = {
    brave_requests_attempted: prior?.counters?.brave_requests_attempted ?? 0,
    brave_requests_successful: prior?.counters?.brave_requests_successful ?? 0,
    brave_requests_failed: prior?.counters?.brave_requests_failed ?? 0,
  };
  const attempts: ProviderAttemptDiagnostic[] = [...(prior?.attempts ?? [])];
  const normalizedResults: NormalizedBraveResult[] = [...(prior?.normalizedResults ?? [])];
  const results: SourceResult[] = normalizedResults.map((item) => ({
    source: "BRAVE_SEARCH",
    independenceKey: "brave-search",
    findings: [findingFromBraveResult(item)],
  }));
  const adapter = createBraveSearchAdapter(dependencies);
  const configured = Boolean((dependencies.getApiKey ?? braveApiKey)());
  const maxRequests = Math.min(
    MAX_BRAVE_REQUESTS_PER_RUN,
    Math.max(0, dependencies.maxRequests ?? MAX_BRAVE_REQUESTS_PER_RUN),
  );
  const completed = new Set(dependencies.completedQueries ?? []);
  const stageAQueries = dependencies.category && dependencies.query
    ? generateBraveStageAQueries(dependencies.category, dependencies.query)
    : [...searchQueries];
  const stageAResults = normalizedResults.filter((item) => item.stage !== "TARGETED")
    .map(findingFromBraveResult).map((finding) => ({
    ...finding,
    relevanceScore: dependencies.category
      ? relevanceScore(finding, dependencies.query ?? "", dependencies.category)
      : 0,
  }));
  const plannedStageA = stageAQueries.filter((query) => !completed.has(query));
  for (const query of plannedStageA) {
    if (!configured) {
      attempts.push({
        provider: "BRAVE_SEARCH",
        query,
        status: "FAILED",
        resultCount: 0,
        error: "BRAVE_SEARCH_API_KEY_MISSING",
      });
      continue;
    }
    if (counters.brave_requests_attempted >= maxRequests) {
      attempts.push({
        provider: "BRAVE_SEARCH",
        query,
        status: "FAILED",
        resultCount: 0,
        error: STOP_BRAVE_BUDGET_REACHED,
      });
      continue;
    }
    const reservation = { provider: "BRAVE_SEARCH", query, stage: "BROAD" as const };
    if (dependencies.reserveAttempt && !(await dependencies.reserveAttempt(reservation))) {
      attempts.push({
        provider: "BRAVE_SEARCH",
        query,
        stage: "BROAD",
        status: "FAILED",
        resultCount: 0,
        error: "ATTEMPT_ALREADY_RESERVED",
      });
      completed.add(query);
      continue;
    }
    counters.brave_requests_attempted += 1;
    try {
      const result = await adapter(query);
      counters.brave_requests_successful += 1;
      results.push(result);
      const normalized = result.findings.map((finding) => normalizeBraveFinding(finding)).filter(
        (item): item is NormalizedBraveResult => Boolean(item),
      );
      normalizedResults.push(...normalized.map((item) => ({ ...item, stage: "BROAD" as const })));
      stageAResults.push(...result.findings.map((finding) => ({
        ...finding,
        relevanceScore: dependencies.category
          ? relevanceScore(finding, dependencies.query ?? "", dependencies.category)
          : 0,
      })));
      attempts.push({
        provider: "BRAVE_SEARCH",
        query,
        stage: "BROAD",
        status: "SUCCEEDED",
        resultCount: result.findings.length,
      });
      await dependencies.completeAttempt?.(
        reservation,
        "SUCCEEDED",
        result.findings.length,
        undefined,
        normalized.map((item) => ({
          title: item.title,
          url: item.url,
          domain: item.domain,
          description: item.description,
          retrievedAt: item.retrievedAt.toISOString(),
          publicationDate: item.publicationDate?.toISOString() ?? "UNKNOWN",
          publication_date_status: item.publicationDateStatus,
          stage: "BROAD",
        })),
      );
    } catch (error) {
      counters.brave_requests_failed += 1;
      attempts.push({
        provider: "BRAVE_SEARCH",
        query,
        stage: "BROAD",
        status: "FAILED",
        resultCount: 0,
        error: exactErrorMessage(error),
      });
      await dependencies.completeAttempt?.(reservation, "FAILED", 0, exactErrorMessage(error));
    }
    await dependencies.onAttempt?.({ counters, attempts: [...attempts], normalizedResults: [...normalizedResults] });
    completed.add(query);
  }
  const stageAClusters = dependencies.category
    ? groupResearchFindings(dependencies.category, deduplicateFindings(stageAResults))
    : [];
  const promisingClusters = dependencies.category
    ? stageAClusters.filter((cluster) => evaluateCandidateGates(
      cluster.group,
      dependencies.category!,
      scoreResearchGroup(cluster.group, 0, new Date()),
    ).passed)
    : [];
  const targetedQueries = dependencies.category
    ? generateBraveTargetedQueries(
      promisingClusters.flatMap((cluster) => cluster.group),
      dependencies.category,
    )
    : [];
  for (const query of targetedQueries) {
    if (completed.has(query)) continue;
    if (!configured) {
      attempts.push({
        provider: "BRAVE_SEARCH",
        query,
        status: "FAILED",
        resultCount: 0,
        error: "BRAVE_SEARCH_API_KEY_MISSING",
      });
      continue;
    }
    if (counters.brave_requests_attempted >= maxRequests) {
      attempts.push({
        provider: "BRAVE_SEARCH",
        query,
        status: "FAILED",
        resultCount: 0,
        error: STOP_BRAVE_BUDGET_REACHED,
      });
      continue;
    }
    const reservation = { provider: "BRAVE_SEARCH", query, stage: "TARGETED" as const };
    if (dependencies.reserveAttempt && !(await dependencies.reserveAttempt(reservation))) {
      attempts.push({
        provider: "BRAVE_SEARCH",
        query,
        stage: "TARGETED",
        status: "FAILED",
        resultCount: 0,
        error: "ATTEMPT_ALREADY_RESERVED",
      });
      completed.add(query);
      continue;
    }
    counters.brave_requests_attempted += 1;
    try {
      const result = await adapter(query);
      counters.brave_requests_successful += 1;
      results.push(result);
      const normalized = result.findings.map((finding) => normalizeBraveFinding(finding)).filter(
        (item): item is NormalizedBraveResult => Boolean(item),
      );
      normalizedResults.push(...normalized.map((item) => ({ ...item, stage: "TARGETED" as const })));
      attempts.push({
        provider: "BRAVE_SEARCH",
        query,
        stage: "TARGETED",
        status: "SUCCEEDED",
        resultCount: result.findings.length,
      });
      await dependencies.completeAttempt?.(
        reservation,
        "SUCCEEDED",
        result.findings.length,
        undefined,
        normalized.map((item) => ({
          title: item.title,
          url: item.url,
          domain: item.domain,
          description: item.description,
          retrievedAt: item.retrievedAt.toISOString(),
          publicationDate: item.publicationDate?.toISOString() ?? "UNKNOWN",
          publication_date_status: item.publicationDateStatus,
          stage: "TARGETED",
        })),
      );
    } catch (error) {
      counters.brave_requests_failed += 1;
      attempts.push({
        provider: "BRAVE_SEARCH",
        query,
        stage: "TARGETED",
        status: "FAILED",
        resultCount: 0,
        error: exactErrorMessage(error),
      });
      await dependencies.completeAttempt?.(reservation, "FAILED", 0, exactErrorMessage(error));
    }
    await dependencies.onAttempt?.({ counters, attempts: [...attempts], normalizedResults: [...normalizedResults] });
    completed.add(query);
  }
  return {
    counters,
    attempts,
    results,
    queries: [...stageAQueries, ...targetedQueries],
    normalizedResults,
  };
}

function normalizeBraveFinding(finding: Finding): NormalizedBraveResult | null {
  const raw = finding.raw;
  const publicationDate = typeof raw.publicationDate === "string" && raw.publicationDate !== "UNKNOWN"
    ? parseVerifiablePublicationDate(raw.publicationDate)
    : null;
  const retrievedAt = typeof raw.retrievedAt === "string" ? new Date(raw.retrievedAt) : new Date();
  return normalizeBraveResult({
    title: finding.titleClaim,
    url: finding.sourceUrl,
    description: finding.excerpt,
    ...(publicationDate ? { published_date: publicationDate.toISOString() } : {}),
  }, Number.isFinite(retrievedAt.getTime()) ? retrievedAt : new Date());
}

function findingFromPersistedAttempt(value: Record<string, unknown>): Finding | null {
  const source = typeof value.source === "string" ? value.source : "BRAVE_SEARCH";
  const sourceUrl = typeof value.url === "string"
    ? canonicalSourceUrl(value.url)
    : typeof value.sourceUrl === "string" ? canonicalSourceUrl(value.sourceUrl) : "";
  const title = typeof value.title === "string" ? value.title.trim() : "";
  if (!sourceUrl || !title) return null;
  const excerpt = typeof value.description === "string"
    ? value.description.slice(0, 2_000) : "";
  const publishedAt = value.publicationDate !== "UNKNOWN" && typeof value.publicationDate === "string"
    ? new Date(value.publicationDate) : UNKNOWN_PUBLICATION_DATE;
  const detectedAt = Number.isFinite(publishedAt.getTime()) && value.publication_date_status === "VERIFIED"
    ? publishedAt
    : typeof value.detectedAt === "string" ? new Date(value.detectedAt) : UNKNOWN_PUBLICATION_DATE;
  const validDetectedAt = Number.isFinite(detectedAt.getTime()) ? detectedAt : UNKNOWN_PUBLICATION_DATE;
  const independenceKey = typeof value.independenceKey === "string"
    ? value.independenceKey : canonicalResultDomain(sourceUrl);
  return {
    source,
    sourceUrl,
    detectedAt: validDetectedAt,
    titleClaim: title,
    excerpt,
    independenceKey,
    raw: {
      source,
      url: sourceUrl,
      title,
      description: excerpt,
      detectedAt: validDetectedAt.toISOString(),
      publication_date_status: value.publication_date_status === "VERIFIED" ? "VERIFIED" : "UNKNOWN",
    },
  };
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

type ProviderReservation = {
  provider: string;
  query: string;
  stage: "BROAD" | "TARGETED" | "LEGACY";
};

const RUN_LEASE_MS = 5 * 60_000;

async function renewRunLease(runId: number, ownerToken: string) {
  const [renewed] = await db.update(discoveryResearchRunsTable).set({
    claimedAt: new Date(),
    updatedAt: new Date(),
  }).where(and(
    eq(discoveryResearchRunsTable.id, runId),
    eq(discoveryResearchRunsTable.executionOwner, ownerToken),
    eq(discoveryResearchRunsTable.status, "RUNNING"),
  )).returning({ id: discoveryResearchRunsTable.id });
  return Boolean(renewed);
}

async function reserveProviderAttempt(
  runId: number,
  ownerToken: string,
  reservation: ProviderReservation,
) {
  return db.transaction(async (tx) => {
    const [renewed] = await tx.update(discoveryResearchRunsTable).set({
      claimedAt: new Date(),
      updatedAt: new Date(),
    }).where(and(
      eq(discoveryResearchRunsTable.id, runId),
      eq(discoveryResearchRunsTable.executionOwner, ownerToken),
      eq(discoveryResearchRunsTable.status, "RUNNING"),
    )).returning({ id: discoveryResearchRunsTable.id });
    if (!renewed) return false;
    const [reserved] = await tx.insert(discoveryProviderAttemptsTable).values({
      researchRunId: runId,
      provider: reservation.provider,
      query: reservation.query,
      stage: reservation.stage,
      status: "RESERVED",
    }).onConflictDoNothing().returning();
    return Boolean(reserved);
  });
}

async function completeProviderAttempt(
  runId: number,
  ownerToken: string,
  reservation: ProviderReservation,
  status: "SUCCEEDED" | "FAILED" | "UNKNOWN",
  resultCount: number,
  errorCode?: string,
  normalizedResults: Record<string, unknown>[] = [],
) {
  await db.transaction(async (tx) => {
    const [renewed] = await tx.update(discoveryResearchRunsTable).set({
      claimedAt: new Date(),
      updatedAt: new Date(),
    }).where(and(
      eq(discoveryResearchRunsTable.id, runId),
      eq(discoveryResearchRunsTable.executionOwner, ownerToken),
      eq(discoveryResearchRunsTable.status, "RUNNING"),
    )).returning({ id: discoveryResearchRunsTable.id });
    if (!renewed) return;
    await tx.update(discoveryProviderAttemptsTable).set({
      status,
      resultCount,
      errorCode,
      normalizedResults,
      completedAt: new Date(),
    }).where(and(
      eq(discoveryProviderAttemptsTable.researchRunId, runId),
      eq(discoveryProviderAttemptsTable.provider, reservation.provider),
      eq(discoveryProviderAttemptsTable.query, reservation.query),
    ));
  });
}

async function hackerNews(
  query: string,
  dependencies: PublicProviderDependencies = {},
  options: PublicProviderPage = {},
): Promise<SourceResult> {
  const endpoint = new URL("https://hn.algolia.com/api/v1/search_by_date");
  endpoint.searchParams.set("tags", "story");
  endpoint.searchParams.set("hitsPerPage", "20");
  endpoint.searchParams.set("query", query);
  if (Number.isInteger(options.page) && (options.page ?? 0) >= 0) {
    endpoint.searchParams.set("page", String(options.page));
  }
  const payload = await getJson(endpoint.toString(), dependencies, "HACKER_NEWS");
  if (!payload || typeof payload !== "object" || !Array.isArray((payload as { hits?: unknown }).hits)) {
    throw new Error("HACKER_NEWS_MALFORMED_PAYLOAD");
  }
  const hits = (payload as { hits: unknown[] }).hits;
  const findings = hits.flatMap((hit) => {
    if (!hit || typeof hit !== "object") return [];
    const record = hit as Record<string, unknown>;
    const title = typeof record.title === "string" ? record.title.trim() : "";
    if (!title) return [];
    const objectId = String(record.objectID ?? "");
    const detectedAt = typeof record.created_at === "string" ? new Date(record.created_at) : new Date();
    return [{
      source: "HACKER_NEWS",
      sourceUrl: urlFor(record.url, `https://news.ycombinator.com/item?id=${objectId}`),
      detectedAt: Number.isNaN(detectedAt.getTime()) ? new Date() : detectedAt,
      titleClaim: title,
      excerpt: typeof record.story_text === "string" ? record.story_text.slice(0, 2_000) : "",
      independenceKey: "news.ycombinator.com",
      raw: record,
    }];
  });
  return { source: "HACKER_NEWS", independenceKey: "news.ycombinator.com", findings };
}

async function stackExchange(
  query: string,
  dependencies: PublicProviderDependencies = {},
  options: PublicProviderPage = {},
): Promise<SourceResult> {
  const endpoint = new URL("https://api.stackexchange.com/2.3/search/advanced");
  endpoint.searchParams.set("order", "desc");
  endpoint.searchParams.set("sort", "activity");
  endpoint.searchParams.set("pagesize", "20");
  endpoint.searchParams.set("site", "stackoverflow");
  endpoint.searchParams.set("q", query);
  if (Number.isInteger(options.page) && (options.page ?? 0) >= 1) {
    endpoint.searchParams.set("page", String(options.page));
  }
  const payload = await getJson(endpoint.toString(), dependencies, "STACK_EXCHANGE");
  if (!payload || typeof payload !== "object" || !Array.isArray((payload as { items?: unknown }).items)) {
    throw new Error("STACK_EXCHANGE_MALFORMED_PAYLOAD");
  }
  const items = (payload as { items: unknown[] }).items;
  const findings = items.flatMap((item) => {
    if (!item || typeof item !== "object") return [];
    const record = item as Record<string, unknown>;
    const title = typeof record.title === "string" ? record.title.trim() : "";
    if (!title) return [];
    const epoch = Number(record.creation_date);
    return [{
      source: "STACK_EXCHANGE",
      sourceUrl: urlFor(record.link, endpoint.toString()),
      detectedAt: Number.isFinite(epoch) ? new Date(epoch * 1_000) : new Date(),
      titleClaim: title.replace(/<[^>]+>/g, ""),
      excerpt: typeof record.tags === "object" && Array.isArray(record.tags)
        ? record.tags.map(String).join(", ").slice(0, 2_000) : "",
      independenceKey: "stackexchange.com",
      raw: record,
    }];
  });
  return { source: "STACK_EXCHANGE", independenceKey: "stackexchange.com", findings };
}

async function github(
  query: string,
  dependencies: PublicProviderDependencies = {},
  options: PublicProviderPage = {},
): Promise<SourceResult> {
  const endpoint = new URL("https://api.github.com/search/issues");
  endpoint.searchParams.set("per_page", "20");
  endpoint.searchParams.set("q", `${query} is:issue`);
  if (Number.isInteger(options.page) && (options.page ?? 0) >= 1) {
    endpoint.searchParams.set("page", String(options.page));
  }
  const payload = await getJson(endpoint.toString(), dependencies, "GITHUB_PUBLIC");
  if (!payload || typeof payload !== "object" || !Array.isArray((payload as { items?: unknown }).items)) {
    throw new Error("GITHUB_PUBLIC_MALFORMED_PAYLOAD");
  }
  const items = (payload as { items: unknown[] }).items;
  const findings = items.flatMap((item) => {
    if (!item || typeof item !== "object") return [];
    const record = item as Record<string, unknown>;
    const title = typeof record.title === "string" ? record.title.trim() : "";
    if (!title) return [];
    const created = typeof record.created_at === "string" ? new Date(record.created_at) : new Date();
    return [{
      source: "GITHUB_PUBLIC",
      sourceUrl: urlFor(record.html_url, endpoint.toString()),
      detectedAt: Number.isNaN(created.getTime()) ? new Date() : created,
      titleClaim: title,
      excerpt: typeof record.body === "string" ? record.body.slice(0, 2_000) : "",
      independenceKey: "github.com",
      raw: record,
    }];
  });
  return { source: "GITHUB_PUBLIC", independenceKey: "github.com", findings };
}

export function createHackerNewsAdapter(dependencies: PublicProviderDependencies = {}) {
  return (query: string, options: PublicProviderPage = {}) =>
    hackerNews(query, dependencies, options);
}

export function createStackExchangeAdapter(dependencies: PublicProviderDependencies = {}) {
  return (query: string, options: PublicProviderPage = {}) =>
    stackExchange(query, dependencies, options);
}

export function createGithubPublicAdapter(dependencies: PublicProviderDependencies = {}) {
  return (query: string, options: PublicProviderPage = {}) =>
    github(query, dependencies, options);
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

export function semanticProblemIdentity(finding: DiscoveryFindingInput) {
  const dimensions = claimDimensions(finding);
  return semanticProblemDimensions(dimensions) || canonicalClaim(finding);
}

function semanticProblemDimensions(dimensions: ReturnType<typeof claimDimensions>) {
  return [
    [...dimensions.entity].sort().join(","),
    [...dimensions.workflow].sort().join(","),
    [...dimensions.problem].sort().join(","),
  ].join("|");
}

function semanticProblemIdentityText(value: string) {
  const dimensions = claimDimensions({
    source: "EXISTING",
    sourceUrl: "https://existing.invalid/problem",
    detectedAt: UNKNOWN_PUBLICATION_DATE,
    titleClaim: value,
    excerpt: "",
    independenceKey: "existing.invalid",
    raw: {},
  });
  return semanticProblemDimensions(dimensions);
}

export function canonicalSourceUrl(sourceUrl: string) {
  try {
    const url = new URL(sourceUrl);
    url.hostname = url.hostname.toLowerCase().replace(/^www\./, "");
    url.username = "";
    url.password = "";
    if ((url.protocol === "https:" && url.port === "443")
      || (url.protocol === "http:" && url.port === "80")) url.port = "";
    url.hash = "";
    for (const key of [...url.searchParams.keys()]) {
      if (/^(utm_|ref$|source$|fbclid$)/i.test(key)) url.searchParams.delete(key);
    }
    url.searchParams.sort();
    const githubIssue = url.pathname.match(/^\/repos\/([^/]+)\/([^/]+)\/issues\/(\d+)/i);
    if (url.hostname === "api.github.com" && githubIssue) {
      return `https://github.com/${githubIssue[1]}/${githubIssue[2]}/issues/${githubIssue[3]}`;
    }
    return url.toString().replace(/\/$/, "");
  } catch {
    return sourceUrl;
  }
}

function canonicalProvenanceKeys(sourceUrl: string) {
  const canonical = canonicalSourceUrl(sourceUrl);
  const keys = new Set([canonical]);
  try {
    const url = new URL(canonical);
    const githubRepository = url.hostname === "github.com"
      ? url.pathname.match(/^\/([^/]+\/[^/]+)(?:\/|$)/)?.[1]
      : null;
    if (githubRepository) keys.add(`github.com/${githubRepository.toLowerCase()}`);
  } catch {
    // The canonical URL remains the only provenance key for malformed URLs.
  }
  return keys;
}

export function matchesExistingOpportunityProvenance(
  existingUrls: readonly string[],
  incomingUrls: readonly string[],
  sameSemanticProblem: boolean,
) {
  const existingDocuments = new Set(existingUrls.map(canonicalSourceUrl));
  const incomingDocuments = new Set(incomingUrls.map(canonicalSourceUrl));
  if ([...existingDocuments].some((url) => incomingDocuments.has(url))) return true;
  if (!sameSemanticProblem) return false;
  const existingProvenance = new Set(existingUrls.flatMap((url) => [...canonicalProvenanceKeys(url)]));
  const incomingProvenance = new Set(incomingUrls.flatMap((url) => [...canonicalProvenanceKeys(url)]));
  return [...existingProvenance].some((key) => incomingProvenance.has(key));
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
  const leftIndependence = findingIndependenceKey(left);
  const rightIndependence = findingIndependenceKey(right);
  if (leftIndependence === rightIndependence || syndicatedOrigin(left, right)) return false;
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
    const key = `${findingIndependenceKey(finding)}|${semanticProblemIdentity(finding)}`;
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
    BRAVE_SEARCH: 0.55,
  };
  const quality = group.reduce((sum, item) => sum + (qualityBySource[item.source] ?? 0.5), 0) / group.length;
  const independent = new Set(group.map(findingIndependenceKey)).size;
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

const commercialIntentPattern = /\b(?:will(?:ing)?|ready|looking|want|need|trying|plan(?:ning)?)\b[\s\S]{0,80}\b(?:pay|buy|purchase|hire|subscribe|price|pricing|budget|cost)\b|\b(?:pay\s+for|buy|purchase|hire|subscribe|pricing|price|budget|willing\s+to\s+pay)\b/i;
const demandSignalPattern = /\b(?:need|needs|want|wants|request(?:ed)?|looking\s+for|frustrat(?:ed|ion)|pain\s+point|problem|missing|broken|manual|repetitive|copy[\s-]?paste|slow|error|hard|difficult)\b/i;
const positiveFeasibilityPattern = /\b(?:digital|online|software|saas|app|tool|service|automation|automate|template|ebook|api|workflow|website|no[-\s]?code)\b/i;
const prohibitedPattern = /\b(?:trading|day\s+trading|betting|gambling|casino|crypto(?:currency)?(?:\s+investment)?|investment\s+advice|payments?|payment\s+processing|transfers?|withdrawals?|paid\s+campaigns?|paid\s+ads?|phishing|fraud|scam|malware|ransomware|weapon|weapons|illegal|counterfeit|stolen|drugs?|adult|porn|exploit|hacking|hack|money\s+laundering)\b/i;
const capitalRequiredPattern = /\b(?:physical\s+inventory|inventory|warehouse|manufacturing|factory|real\s+estate|loan|funding|investment|investor|capital|stock|equipment|vehicle|lease|paid\s+campaigns?|paid\s+ads?)\b/i;
const MIN_CANDIDATE_CONFIDENCE = 0.20;

export function evaluateCandidateGates(
  group: readonly Finding[],
  category: DiscoveryCategory,
  score = scoreResearchGroup([...group]),
): CandidateGateDiagnostics {
  const corpus = group.map((finding) => `${finding.titleClaim} ${finding.excerpt}`).join(" ");
  const hasCommercialIntent = commercialIntentPattern.test(corpus);
  const hasDemandSignal = group.length >= 2
    && group.every((finding) =>
      Boolean(finding.titleClaim.trim() || finding.excerpt.trim()) &&
      demandSignalPattern.test(`${finding.titleClaim} ${finding.excerpt}`))
    && new Set(group.map(findingIndependenceKey)).size >= 2;
  const hasProhibitedContent = prohibitedPattern.test(corpus);
  const hasCapitalRequirement = capitalRequiredPattern.test(corpus);
  const hasPositiveFeasibility = positiveFeasibilityPattern.test(corpus);
  const minimumQualityConfidence = score.confidence >= MIN_CANDIDATE_CONFIDENCE
    && score.breakdown.quality >= 50;
  const rejectionReasons: string[] = [];
  if (!hasCommercialIntent) rejectionReasons.push("COMMERCIAL_INTENT_REQUIRED");
  if (!hasDemandSignal) rejectionReasons.push("DEMAND_SIGNAL_REQUIRED");
  if (hasProhibitedContent) rejectionReasons.push("LEGAL_OR_PROHIBITED_CONTENT");
  if (hasCapitalRequirement || !hasPositiveFeasibility) {
    rejectionReasons.push("ZERO_CAPITAL_FEASIBILITY_REQUIRED");
  }
  if (!minimumQualityConfidence) rejectionReasons.push("MINIMUM_QUALITY_CONFIDENCE_REQUIRED");
  return {
    commercialIntent: hasCommercialIntent ? "PASS" : "FAIL",
    demandSignal: hasDemandSignal ? "PASS" : "FAIL",
    legalNonProhibited: hasProhibitedContent ? "FAIL" : "PASS",
    zeroCapitalFeasible: hasCapitalRequirement || !hasPositiveFeasibility ? "FAIL" : "PASS",
    minimumQualityConfidence: minimumQualityConfidence ? "PASS" : "FAIL",
    passed: rejectionReasons.length === 0,
    rejectionReasons,
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
  if (!Number.isFinite(finding.detectedAt.getTime())) return false;
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
    sourceUrl: canonicalSourceUrl(finding.sourceUrl),
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
  const ownerToken = randomUUID();
  const startedAt = new Date();

  const [createdRun] = await db.insert(discoveryResearchRunsTable).values({
    idempotencyKey, category, query, status: "RUNNING",
    executionOwner: ownerToken,
    claimedAt: startedAt,
  }).onConflictDoNothing({ target: discoveryResearchRunsTable.idempotencyKey }).returning();
  const existingRun = createdRun
    ? null
    : (await db.select().from(discoveryResearchRunsTable)
      .where(eq(discoveryResearchRunsTable.idempotencyKey, idempotencyKey)).limit(1))[0];
  if (existingRun && existingRun.status !== "RUNNING") {
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
  let run = createdRun ?? existingRun;
  if (!run) throw new Error("DISCOVERY_RUN_PERSIST_FAILED");
  if (!createdRun) {
    const staleBefore = new Date(Date.now() - 5 * 60_000);
    const [claimedRun] = await db.update(discoveryResearchRunsTable).set({
      executionOwner: ownerToken,
      claimedAt: startedAt,
      updatedAt: startedAt,
    }).where(and(
      eq(discoveryResearchRunsTable.id, run.id),
      eq(discoveryResearchRunsTable.status, "RUNNING"),
      or(isNull(discoveryResearchRunsTable.executionOwner), lt(discoveryResearchRunsTable.claimedAt, staleBefore)),
    )).returning();
    if (!claimedRun) {
      const [findings] = await Promise.all([
        db.select().from(discoveryFindingsTable).where(eq(discoveryFindingsTable.researchRunId, run.id)),
      ]);
      const opportunities = run.acceptedCount
        ? await db.select().from(opportunitiesTable)
          .where(sql`${opportunitiesTable.id} IN (
            SELECT opportunity_id FROM soy_discovery_findings WHERE research_run_id = ${run.id}
              AND opportunity_id IS NOT NULL
          )`)
        : [];
      return { run, findings, opportunities };
    }
    run = claimedRun;
  }

  const now = new Date();
  const searchQueries = queryVariants(category, query);
  const priorScoreBreakdown = run.scoreBreakdown as Record<string, unknown>;
  // Provider-attempt rows are the durable authority for completed work.
  // scoreBreakdown is intentionally not used to reconstruct result payloads.
  const priorAttempts: ProviderAttemptDiagnostic[] = [];
  let priorNormalizedResults: NormalizedBraveResult[] = [];
  const persistedProviderAttempts = await db.select().from(discoveryProviderAttemptsTable)
    .where(eq(discoveryProviderAttemptsTable.researchRunId, run.id));
  const persistedSourceResults: SourceResult[] = persistedProviderAttempts
    .filter((attempt) => attempt.status === "SUCCEEDED")
    .map((attempt) => ({
      source: attempt.provider,
      independenceKey: attempt.normalizedResults
        .map((value) => typeof value.independenceKey === "string" ? value.independenceKey : "")
        .find(Boolean) || attempt.provider.toLowerCase(),
      findings: attempt.normalizedResults.flatMap((value) => {
        const finding = findingFromPersistedAttempt(value);
        return finding ? [finding] : [];
      }),
    }));
  const persistedBraveNormalized = persistedProviderAttempts
    .filter((attempt) => attempt.provider === "BRAVE_SEARCH" && attempt.status === "SUCCEEDED")
    .flatMap((attempt) => attempt.normalizedResults.flatMap((value) => {
      const normalized = normalizeBraveResult({
        title: value.title,
        url: value.url,
        description: value.description,
        published_date: value.publicationDate === "UNKNOWN" ? undefined : value.publicationDate,
      }, typeof value.retrievedAt === "string" ? new Date(value.retrievedAt) : now);
      if (!normalized) return [];
      return [{
        ...normalized,
        stage: value.stage === "TARGETED" ? "TARGETED" as const : "BROAD" as const,
      }];
    }));
  if (persistedBraveNormalized.length) priorNormalizedResults = persistedBraveNormalized;
  const braveRows = persistedProviderAttempts.filter((attempt) => attempt.provider === "BRAVE_SEARCH");
  const braveRowCounters = {
    brave_requests_attempted: braveRows.length,
    brave_requests_successful: braveRows.filter((attempt) => attempt.status === "SUCCEEDED").length,
    brave_requests_failed: braveRows.filter((attempt) => attempt.status !== "SUCCEEDED").length,
  };
  const authoritativeBraveCounters = braveRows.length > 0
    ? braveRowCounters
    : {
      brave_requests_attempted: Number(priorScoreBreakdown.brave_requests_attempted ?? 0),
      brave_requests_successful: Number(priorScoreBreakdown.brave_requests_successful ?? 0),
      brave_requests_failed: Number(priorScoreBreakdown.brave_requests_failed ?? 0),
    };
  const staleReservationBefore = new Date(now.getTime() - RUN_LEASE_MS);
  const staleAttemptIds = new Set<number>();
  for (const attempt of persistedProviderAttempts.filter((item) =>
    item.status === "RESERVED" && item.reservedAt < staleReservationBefore)) {
    staleAttemptIds.add(attempt.id);
    await db.transaction(async (tx) => {
      const [owned] = await tx.update(discoveryResearchRunsTable).set({
        claimedAt: new Date(),
        updatedAt: new Date(),
      }).where(and(
        eq(discoveryResearchRunsTable.id, run.id),
        eq(discoveryResearchRunsTable.executionOwner, ownerToken),
        eq(discoveryResearchRunsTable.status, "RUNNING"),
      )).returning({ id: discoveryResearchRunsTable.id });
      if (!owned) return;
      await tx.update(discoveryProviderAttemptsTable).set({
        status: "UNKNOWN",
        errorCode: "OUTCOME_UNKNOWN",
        completedAt: now,
      }).where(eq(discoveryProviderAttemptsTable.id, attempt.id));
    });
  }
  const priorAttemptKeys = new Set(priorAttempts.map((attempt) => `${attempt.provider}|${attempt.query}`));
  for (const attempt of persistedProviderAttempts) {
    const key = `${attempt.provider}|${attempt.query}`;
    if (attempt.provider !== "BRAVE_SEARCH" || priorAttemptKeys.has(key)) continue;
    priorAttempts.push({
      provider: attempt.provider,
      query: attempt.query,
      stage: attempt.stage === "TARGETED" ? "TARGETED" : "BROAD",
      status: attempt.status === "SUCCEEDED"
        ? "SUCCEEDED" : attempt.status === "UNKNOWN" || staleAttemptIds.has(attempt.id) ? "UNKNOWN" : "FAILED",
      resultCount: attempt.resultCount,
      ...(attempt.errorCode || staleAttemptIds.has(attempt.id)
        ? { error: attempt.errorCode ?? "OUTCOME_UNKNOWN" } : {}),
    });
  }
  const priorBraveQueries = [
    ...priorAttempts.map((attempt) => attempt.query),
    ...persistedProviderAttempts
      .filter((attempt) => attempt.provider === "BRAVE_SEARCH")
      .map((attempt) => attempt.query),
  ];
  const persistedAttemptKeys = new Set(
    persistedProviderAttempts.map((attempt) => `${attempt.provider}|${attempt.query}`),
  );
  if (!braveApiKey()) {
    const [rejectedRun] = await db.update(discoveryResearchRunsTable).set({
      status: "REJECTED",
      rejectionReason: "BRAVE_SEARCH_API_KEY_MISSING",
      scoreBreakdown: {
        ...priorScoreBreakdown,
        ...authoritativeBraveCounters,
        attemptMetadata: {
          ...authoritativeBraveCounters,
          stopReason: "BRAVE_SEARCH_API_KEY_MISSING",
        },
      } as unknown as Record<string, number>,
      completedAt: now,
      updatedAt: now,
    }).where(and(
      eq(discoveryResearchRunsTable.id, run.id),
      eq(discoveryResearchRunsTable.executionOwner, ownerToken),
      eq(discoveryResearchRunsTable.status, "RUNNING"),
    )).returning();
    return { run: rejectedRun ?? run, opportunities: [], findings: [] };
  }
  const adapters = [
    { provider: "HACKER_NEWS", independenceKey: "news.ycombinator.com", run: hackerNews },
    { provider: "STACK_EXCHANGE", independenceKey: "stackexchange.com", run: stackExchange },
    { provider: "GITHUB_PUBLIC", independenceKey: "github.com", run: github },
  ];
  const attempts = adapters.flatMap((adapter) =>
    searchQueries
      .map((searchQuery) => ({ adapter, searchQuery }))
      .filter(({ adapter, searchQuery }) =>
        !persistedAttemptKeys.has(`${adapter.provider}|${searchQuery}`)));
  const settled = await Promise.allSettled(attempts.map(async ({ adapter, searchQuery }) => {
    const reservation = { provider: adapter.provider, query: searchQuery, stage: "LEGACY" as const };
    const attemptKey = `${reservation.provider}|${reservation.query}`;
    if (persistedAttemptKeys.has(attemptKey)
      || !(await reserveProviderAttempt(run.id, ownerToken, reservation))) {
      throw new Error("ATTEMPT_ALREADY_RESERVED");
    }
    try {
      const result = await adapter.run(searchQuery);
      await completeProviderAttempt(
        run.id,
        ownerToken,
        reservation,
        "SUCCEEDED",
        result.findings.length,
        undefined,
        result.findings.map((finding) => ({
          source: finding.source,
          url: finding.sourceUrl,
          title: finding.titleClaim,
          description: finding.excerpt,
          independenceKey: finding.independenceKey,
          detectedAt: finding.detectedAt.toISOString(),
          publication_date_status: "VERIFIED",
        })),
      );
      return result;
    } catch (error) {
      const message = exactErrorMessage(error);
      await completeProviderAttempt(run.id, ownerToken, reservation, "FAILED", 0, message);
      throw error;
    }
  }));
  const restoredProviderAttempts: ProviderAttemptDiagnostic[] = persistedProviderAttempts.map((attempt) => ({
    provider: attempt.provider,
    query: attempt.query,
    ...(attempt.stage === "BROAD" || attempt.stage === "TARGETED" ? { stage: attempt.stage } : {}),
    status: attempt.status === "SUCCEEDED"
      ? "SUCCEEDED" : attempt.status === "UNKNOWN" || staleAttemptIds.has(attempt.id) ? "UNKNOWN" : "FAILED",
    resultCount: attempt.resultCount,
    ...(attempt.errorCode || staleAttemptIds.has(attempt.id)
      ? { error: attempt.errorCode ?? "OUTCOME_UNKNOWN" } : {}),
  }));
  const providerAttempts: ProviderAttemptDiagnostic[] = [
    ...restoredProviderAttempts,
    ...settled.map((item, index) => ({
      provider: attempts[index].adapter.provider,
      query: attempts[index].searchQuery,
      status: (item.status === "fulfilled" ? "SUCCEEDED" : "FAILED") as "SUCCEEDED" | "FAILED",
      resultCount: item.status === "fulfilled" ? item.value.findings.length : 0,
      ...(item.status === "rejected" ? {
        error: exactErrorMessage(item.reason),
      } : {}),
    })),
  ];
  // Brave is deliberately a small, sequential funnel. The budget applies to
  // actual Brave network attempts only; missing credentials never trigger a
  // request and are recorded as a provider failure instead.
  const braveRun = await runBraveSearchFunnel([], {
    category,
    query,
    completedQueries: priorBraveQueries,
    checkpoint: {
      counters: {
        ...authoritativeBraveCounters,
      },
      attempts: priorAttempts,
      normalizedResults: priorNormalizedResults,
    },
    reserveAttempt: (reservation) => reserveProviderAttempt(run.id, ownerToken, reservation),
    completeAttempt: (reservation, status, resultCount, errorCode, normalizedResults) =>
      completeProviderAttempt(run.id, ownerToken, reservation, status, resultCount, errorCode, normalizedResults),
    onAttempt: async (checkpoint) => {
      await db.update(discoveryResearchRunsTable).set({
        scoreBreakdown: {
          ...priorScoreBreakdown,
          discoveryAttempts: [...providerAttempts, ...checkpoint.attempts],
          ...checkpoint.counters,
          normalizedResults: checkpoint.normalizedResults,
          attemptMetadata: {
            ...checkpoint.counters,
            state: "RUNNING",
          },
        } as unknown as Record<string, number>,
        updatedAt: new Date(),
        claimedAt: new Date(),
      }).where(and(
        eq(discoveryResearchRunsTable.id, run.id),
        eq(discoveryResearchRunsTable.executionOwner, ownerToken),
        eq(discoveryResearchRunsTable.status, "RUNNING"),
      ));
    },
  });
  providerAttempts.push(...braveRun.attempts.slice(priorAttempts.length));
  const finalBraveRows = await db.select().from(discoveryProviderAttemptsTable)
    .where(and(
      eq(discoveryProviderAttemptsTable.researchRunId, run.id),
      eq(discoveryProviderAttemptsTable.provider, "BRAVE_SEARCH"),
    ));
  const finalBraveCounters = {
    brave_requests_attempted: finalBraveRows.length,
    brave_requests_successful: finalBraveRows.filter((attempt) => attempt.status === "SUCCEEDED").length,
    brave_requests_failed: finalBraveRows.filter((attempt) => attempt.status !== "SUCCEEDED").length,
  };
  const restoredFindingUrls = new Set(
    persistedSourceResults.flatMap((result) => result.findings.map((finding) => finding.sourceUrl)),
  );
  const currentBraveResults = braveRun.results.filter((result) =>
    result.findings.some((finding) => !restoredFindingUrls.has(finding.sourceUrl)));
  const successfulAttempts = [
    ...settled.flatMap((item) => item.status === "fulfilled" ? [item.value] : []),
    ...persistedSourceResults,
    ...currentBraveResults,
  ];
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
  const independentSourceCount = new Set(successful.flatMap((result) =>
    result.findings.map(findingIndependenceKey))).size;
  const adjustment = await learningAdjustment(category);
  const groups = groupResearchFindings(category, eligible);
  const corroborated = groups.filter((group) =>
    new Set(group.group.map(findingIndependenceKey)).size >= 2);
  const groupGateDiagnostics = new Map<string, CandidateGateDiagnostics>();
  for (const group of corroborated) {
    const score = scoreResearchGroup(group.group, adjustment, now);
    groupGateDiagnostics.set(group.fingerprint, evaluateCandidateGates(group.group, category, score));
  }
  const acceptedGroups = corroborated.filter((group) => groupGateDiagnostics.get(group.fingerprint)?.passed);
  const rejectionReason = category === "SPORTS"
    ? "SPORTS_RESEARCH_ONLY"
    : acceptedGroups.length ? null
      : corroborated.length ? "CANDIDATE_GATES_FAILED"
      : successful.length < 2 ? "INSUFFICIENT_INDEPENDENT_SOURCES" : "NO_CORROBORATED_EVIDENCE";
  const eligibleGroup = new Map<Finding, { group: Finding[]; fingerprint: string }>();
  for (const group of groups) {
    for (const finding of group.group) eligibleGroup.set(finding, group);
  }
  const sourceClaimCounts = new Map<string, number>();
  for (const finding of findings) {
    const key = `${findingIndependenceKey(finding)}|${canonicalClaim(finding)}`;
    sourceClaimCounts.set(key, (sourceClaimCounts.get(key) ?? 0) + 1);
  }
  const crossSourceClaims = new Map<string, Set<string>>();
  for (const finding of findings) {
    const key = canonicalClaim(finding);
    const sources = crossSourceClaims.get(key) ?? new Set<string>();
    sources.add(findingIndependenceKey(finding));
    crossSourceClaims.set(key, sources);
  }
  for (const finding of findings) {
    const group = eligibleGroup.get(finding);
    const independent = group
      ? new Set(group.group.map(findingIndependenceKey)).size : 0;
    const reasons: string[] = [];
    if (!findingPassesFreshness(finding, now)) reasons.push("FRESHNESS_BELOW_THRESHOLD");
    if ((finding.relevanceScore ?? 0) < MIN_RELEVANCE_SCORE) reasons.push("LOW_SEMANTIC_RELEVANCE");
    if (group && independent < 2) reasons.push("INSUFFICIENT_INDEPENDENT_SOURCES");
    if (category === "SPORTS") reasons.push("SPORTS_RESEARCH_ONLY");
    const duplicateKey = `${findingIndependenceKey(finding)}|${canonicalClaim(finding)}`;
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
    const candidateGates = group ? groupGateDiagnostics.get(group.fingerprint) : undefined;
    if (candidateGates && !candidateGates.passed) reasons.push(...candidateGates.rejectionReasons);
    finding.diagnostic = {
      candidateFingerprint,
      semanticKey: semanticKey(`${finding.titleClaim} ${finding.excerpt}`),
      searchQueries,
      providerAttempts,
      relevanceScore: Number((finding.relevanceScore ?? 0).toFixed(4)),
      freshnessScore: Number(freshnessScore(finding.detectedAt, now).toFixed(4)),
      candidateStatus: !reasons.length && Boolean(group && acceptedGroups.includes(group))
        ? "PASS" : "FAIL",
      rejectionReasons: reasons.length ? reasons : (group && acceptedGroups.includes(group)
        ? [] : ["NO_CORROBORATED_EVIDENCE"]),
      independentSourceCount: independent,
      duplicateClass,
    };
    if (candidateGates && finding.diagnostic) finding.diagnostic.gates = candidateGates;
  }

  const result = await db.transaction(async (tx) => {
    const [owned] = await tx.update(discoveryResearchRunsTable).set({
      claimedAt: new Date(),
      updatedAt: new Date(),
    }).where(and(
      eq(discoveryResearchRunsTable.id, run.id),
      eq(discoveryResearchRunsTable.executionOwner, ownerToken),
      eq(discoveryResearchRunsTable.status, "RUNNING"),
    )).returning({ id: discoveryResearchRunsTable.id });
    if (!owned) throw new Error("DISCOVERY_RUN_OWNERSHIP_LOST");
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
    const existingOpportunities = await tx.select().from(opportunitiesTable);
    const existingMetadata = await tx.select().from(opportunityMetadataTable);
    const existingEvidence = await tx.select().from(evidenceTable);
    const existingProblemKeys = new Map<number, string>();
    const existingEvidenceUrls = new Map<number, Set<string>>();
    for (const opportunity of existingOpportunities) {
      const metadata = existingMetadata.find((item) => item.opportunityId === opportunity.id);
      existingProblemKeys.set(
        opportunity.id,
        semanticProblemIdentityText(
          metadata?.normalizedProblem || opportunity.problem || opportunity.titleClaim || opportunity.name,
        ) || semanticKey(metadata?.normalizedProblem || opportunity.problem || opportunity.titleClaim || opportunity.name),
      );
      const provenance = new Set<string>();
      for (const value of [
        opportunity.sourceUrl ?? "",
        ...(opportunity.evidenceRefs ?? []).filter((url): url is string => typeof url === "string"),
      ]) {
        provenance.add(canonicalSourceUrl(String(value)));
      }
      existingEvidenceUrls.set(opportunity.id, provenance);
    }
    for (const evidence of existingEvidence) {
      const urls = existingEvidenceUrls.get(evidence.opportunityId) ?? new Set<string>();
      urls.add(canonicalSourceUrl(evidence.url));
      existingEvidenceUrls.set(evidence.opportunityId, urls);
    }
    if (!rejectionReason) {
      for (const group of acceptedGroups) {
        const score = scoreResearchGroup(group.group, adjustment, now);
        const titleClaim = group.group[0].titleClaim;
        const sourceUrl = group.group[0].sourceUrl;
        const refs = group.group.map((item) => item.sourceUrl);
        const groupUrls = group.group.map((item) => item.sourceUrl);
        const groupProblemKey = semanticProblemIdentity(group.group[0]);
        let opportunity = existingOpportunities.find((candidate) =>
          candidate.fingerprint === group.fingerprint
          || (candidate.category === category
            && matchesExistingOpportunityProvenance(
              [...(existingEvidenceUrls.get(candidate.id) ?? [])],
              groupUrls,
              existingProblemKeys.get(candidate.id) === groupProblemKey,
            )));
        if (!opportunity) {
          [opportunity] = await tx.insert(opportunitiesTable).values({
            name: titleClaim,
            titleClaim,
            description: `Observed public claim; corroborated by ${new Set(group.group.map(findingIndependenceKey)).size} independent sources. This is not demand proof.`,
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
           if (opportunity) {
             existingOpportunities.push(opportunity);
             existingProblemKeys.set(
               opportunity.id,
               semanticProblemIdentityText(opportunity.problem || opportunity.titleClaim || opportunity.name)
                 || semanticKey(opportunity.problem || opportunity.titleClaim || opportunity.name),
             );
             const insertedProvenance = new Set<string>();
             for (const ref of [opportunity.sourceUrl ?? "", ...(opportunity.evidenceRefs ?? [])]) {
               insertedProvenance.add(canonicalSourceUrl(String(ref)));
             }
             existingEvidenceUrls.set(opportunity.id, insertedProvenance);
           }
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
    const scoreBreakdown = acceptedGroups[0]
      ? scoreResearchGroup(acceptedGroups[0].group, adjustment, now).breakdown : {};
    const runMetadata = {
      ...scoreBreakdown,
      discoveryAttempts: providerAttempts,
      ...finalBraveCounters,
      normalizedResults: braveRun.normalizedResults,
      candidateGateDiagnostics: [...groupGateDiagnostics].map(([fingerprint, gates]) => ({
        fingerprint,
        ...gates,
      })),
      attemptMetadata: {
        ...finalBraveCounters,
        stopReason: braveRun.attempts.some((attempt) => attempt.error === STOP_BRAVE_BUDGET_REACHED)
          ? STOP_BRAVE_BUDGET_REACHED
          : null,
      },
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
    }).where(and(
      eq(discoveryResearchRunsTable.id, run.id),
      eq(discoveryResearchRunsTable.executionOwner, ownerToken),
      eq(discoveryResearchRunsTable.status, "RUNNING"),
    )).returning();
    if (!updatedRun) throw new Error("DISCOVERY_RUN_OWNERSHIP_LOST");
    return { run: updatedRun, opportunities: savedOpportunities, findings: savedFindings };
  });
  return result;
}