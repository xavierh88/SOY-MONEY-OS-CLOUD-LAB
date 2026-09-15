import assert from "node:assert/strict";

// This is deliberately a fixture-only regression check. Importing the module
// does not call an adapter; the research runner is never invoked here.
process.env.DATABASE_URL ??= "postgres://fixture:fixture@127.0.0.1:5432/fixture";
const {
  claimsMatch,
  canonicalResultDomain,
  canonicalSourceUrl,
  createBraveSearchAdapter,
  evaluateCandidateGates,
  evaluateFinding,
  fingerprint,
  generateBraveStageAQueries,
  generateBraveTargetedQueries,
  groupResearchFindings,
  matchesExistingOpportunityProvenance,
  normalizeBraveResult,
  relevanceScore,
  runBraveSearchFunnel,
  scoreResearchGroup,
  STOP_BRAVE_BUDGET_REACHED,
  tokens,
} = await import("../../artifacts/api-server/src/lib/discovery-research");

const now = new Date("2026-01-15T00:00:00.000Z");
const fixture = [
  {
    source: "HACKER_NEWS",
    sourceUrl: "https://news.ycombinator.com/item?id=1",
    detectedAt: now,
    titleClaim: "Manual invoice reminders for small teams",
    excerpt: "Billing notifications are copied by hand every month.",
    independenceKey: "news.ycombinator.com",
    raw: { fixture: "hn-invoice" },
  },
  {
    source: "GITHUB_PUBLIC",
    sourceUrl: "https://github.com/example/project/issues/2",
    detectedAt: now,
    titleClaim: "Automate billing reminders for small teams",
    excerpt: "Payment email notifications need scheduling instead of manual work.",
    independenceKey: "github.com",
    raw: { fixture: "github-invoice" },
  },
  {
    source: "HACKER_NEWS",
    sourceUrl: "https://news.ycombinator.com/item?id=3",
    detectedAt: now,
    titleClaim: "Recipe website color palette",
    excerpt: "A cooking site needs a nicer card layout.",
    independenceKey: "news.ycombinator.com",
    raw: { fixture: "hn-unrelated" },
  },
  {
    source: "HACKER_NEWS",
    sourceUrl: "https://news.ycombinator.com/item?id=4",
    detectedAt: now,
    titleClaim: "Manual invoice reminders for small teams",
    excerpt: "Billing notifications are copied by hand every month.",
    independenceKey: "news.ycombinator.com",
    raw: { fixture: "hn-duplicate" },
  },
] as const;

assert.deepEqual(tokens("Billing, payments, and scheduling"), ["invoice", "calendar"]);
assert.ok(relevanceScore(fixture[0], "automation repetitive task request", "AUTOMATION") > 0);
assert.equal(claimsMatch(fixture[0], fixture[1]), true, "valid paraphrase should corroborate");

const sameWorkflowDifferentProblem = [
  {
    ...fixture[0],
    titleClaim: "Invoice reminders for small teams",
    excerpt: "Manual invoice reminders are copied by hand.",
    sourceUrl: "https://a.example/invoice-manual",
  },
  {
    ...fixture[1],
    titleClaim: "Billing reminders for small teams",
    excerpt: "Expensive invoice reminders are hard to justify.",
    sourceUrl: "https://b.example/invoice-expensive",
  },
] as const;
assert.equal(
  claimsMatch(sameWorkflowDifferentProblem[0], sameWorkflowDifferentProblem[1]),
  false,
  "same workflow/entity with different pains must not corroborate",
);

const forward = groupResearchFindings("BUSINESS", [...fixture]);
const reverse = groupResearchFindings("BUSINESS", [...fixture].reverse());
assert.deepEqual(
  forward.map((group) => group.fingerprint),
  reverse.map((group) => group.fingerprint),
);
const corroborated = forward.find((group) => group.group.some((item) => item.source === "GITHUB_PUBLIC"));
assert.ok(corroborated);
assert.equal(corroborated?.group.length, 2, "same-provider duplicate must not become another finding");
assert.equal(new Set(corroborated?.group.map((item) => item.independenceKey)).size, 2);
assert.equal(forward.filter((group) => group.group.length === 1).length, 1);
assert.equal(
  fingerprint("BUSINESS", "Manual invoice reminders for small teams"),
  fingerprint("BUSINESS", "small teams manual reminders invoice"),
);

const transitive = [
  {
    source: "HACKER_NEWS",
    sourceUrl: "https://news.ycombinator.com/item?id=transitive-a",
    detectedAt: now,
    titleClaim: "Invoice reminders for teams",
    excerpt: "Manual invoice work is tedious.",
    independenceKey: "news.ycombinator.com",
    raw: {},
  },
  {
    source: "GITHUB_PUBLIC",
    sourceUrl: "https://github.com/example/issues/bridge",
    detectedAt: now,
    titleClaim: "Invoice calendar reminders",
    excerpt: "Manual invoice calendar email scheduling is tedious.",
    independenceKey: "github.com",
    raw: {},
  },
  {
    source: "STACK_EXCHANGE",
    sourceUrl: "https://stackoverflow.com/q/bridge",
    detectedAt: now,
    titleClaim: "Calendar scheduling for teams",
    excerpt: "Manual calendar email work is tedious.",
    independenceKey: "stackexchange.com",
    raw: {},
  },
] as const;
const transitiveGroups = groupResearchFindings("BUSINESS", transitive);
assert.equal(
  transitiveGroups.some((group) => group.group.length === 3),
  false,
  "A-B and B-C agreement must not create an A-B-C opportunity",
);
assert.equal(
  transitiveGroups.filter((group) => group.group.length === 2).length,
  2,
);

const syndicated = [
  {
    ...fixture[0],
    sourceUrl: "https://news.ycombinator.com/item?id=syndicated",
    raw: { url: "https://github.com/example/project/issues/99" },
  },
  {
    ...fixture[1],
    sourceUrl: "https://github.com/example/project/issues/99",
    raw: { html_url: "https://github.com/example/project/issues/99" },
  },
] as const;
assert.equal(
  groupResearchFindings("BUSINESS", syndicated).some((group) => group.group.length > 1),
  false,
  "a provider linking the underlying issue is not independent evidence",
);

const sameRepositoryDifferentUrls = [
  {
    ...fixture[0],
    sourceUrl: "https://news.ycombinator.com/item?id=repository-origin",
    raw: { repository_url: "https://github.com/example/project" },
  },
  {
    ...fixture[1],
    sourceUrl: "https://stackoverflow.com/questions/99",
    raw: { repository: { full_name: "example/project" } },
  },
] as const;
assert.equal(
  groupResearchFindings("BUSINESS", sameRepositoryDifferentUrls).some((group) => group.group.length > 1),
  false,
  "matching repository provenance must not be treated as independent",
);

const sameAuthorDifferentProviders = [
  {
    ...fixture[0],
    sourceUrl: "https://news.ycombinator.com/item?id=author-origin",
    raw: { author: "same-author" },
  },
  {
    ...fixture[1],
    sourceUrl: "https://stackoverflow.com/questions/author-origin",
    raw: { owner: { login: "same-author" } },
  },
] as const;
assert.equal(
  groupResearchFindings("BUSINESS", sameAuthorDifferentProviders).some((group) => group.group.length > 1),
  false,
  "matching author provenance must not be treated as independent",
);

const genericOnly = [
  { ...fixture[0], titleClaim: "Small team workflow", excerpt: "A small team needs a better process.", sourceUrl: "https://a.example/generic" },
  { ...fixture[1], titleClaim: "Small team process", excerpt: "A small team has a workflow problem.", sourceUrl: "https://b.example/generic" },
] as const;
assert.equal(groupResearchFindings("BUSINESS", genericOnly).some((group) => group.group.length > 1), false);

const stale = {
  ...fixture[0],
  detectedAt: new Date("2025-01-01T00:00:00.000Z"),
};
const staleEvaluation = evaluateFinding(stale, "small business workflow problem", "BUSINESS", now);
assert.equal(staleEvaluation.eligible, false);
assert.ok(staleEvaluation.rejectionReasons.includes("FRESHNESS_BELOW_THRESHOLD"));

assert.equal(canonicalResultDomain("https://WWW.Example.com:443/path"), "example.com");
assert.equal(
  canonicalSourceUrl("https://WWW.Example.com:443/path?utm_source=x&b=2&a=1#fragment"),
  "https://example.com/path?a=1&b=2",
);
const normalizedUnknown = normalizeBraveResult({
  title: "  Manual invoice reminders  ",
  url: "https://www.example.com/reminders?utm_source=test",
  description: "<b>Copied by hand</b> every month.",
  page_age: "2026-01-01",
}, now);
assert.equal(normalizedUnknown?.domain, "example.com");
assert.equal(normalizedUnknown?.description, "Copied by hand every month.");
assert.equal(normalizedUnknown?.publicationDate, null, "crawl age is not publication evidence");
assert.equal(
  evaluateFinding({
    source: "BRAVE_SEARCH",
    sourceUrl: normalizedUnknown?.url ?? "",
    detectedAt: new Date(0),
    titleClaim: normalizedUnknown?.title ?? "",
    excerpt: normalizedUnknown?.description ?? "",
    independenceKey: normalizedUnknown?.domain ?? "",
    raw: {},
  }, "small business workflow problem", "BUSINESS", now).eligible,
  false,
  "unknown Brave publication dates must fail freshness conservatively",
);

const commercialGroup = [
  {
    ...fixture[0],
    titleClaim: "Customers will pay for manual invoice reminders",
    excerpt: "Small businesses need a paid service for customer billing follow-up.",
    sourceUrl: "https://sub.one.example.com/invoice",
  },
  {
    ...fixture[1],
    titleClaim: "Businesses want to hire invoice reminder help",
    excerpt: "Clients request a service to automate overdue billing emails.",
    sourceUrl: "https://another.example.net/invoice",
  },
] as const;
const commercialScore = scoreResearchGroup([...commercialGroup], 0, now);
assert.equal(evaluateCandidateGates([...commercialGroup], "BUSINESS", commercialScore).passed, true);
const prohibited = evaluateCandidateGates([
  { ...commercialGroup[0], titleClaim: "Customers pay for phishing automation" },
  commercialGroup[1],
], "BUSINESS", commercialScore);
assert.equal(prohibited.legalNonProhibited, "FAIL");
assert.ok(prohibited.rejectionReasons.includes("LEGAL_OR_PROHIBITED_CONTENT"));
const capitalRequired = evaluateCandidateGates([
  { ...commercialGroup[0], excerpt: "Customers pay for warehouse inventory equipment." },
  { ...commercialGroup[1], excerpt: "Businesses need manufacturing equipment and inventory." },
], "BUSINESS", commercialScore);
assert.equal(capitalRequired.zeroCapitalFeasible, "FAIL");
assert.ok(capitalRequired.rejectionReasons.includes("ZERO_CAPITAL_FEASIBILITY_REQUIRED"));
const unknownFeasibility = evaluateCandidateGates([
  { ...commercialGroup[0], titleClaim: "Customers will pay for invoice reminders", excerpt: "Customers need this." },
  { ...commercialGroup[1], titleClaim: "Businesses want invoice reminders", excerpt: "Businesses request it." },
], "BUSINESS", commercialScore);
assert.equal(unknownFeasibility.zeroCapitalFeasible, "FAIL");
for (const forbidden of ["trading signals", "betting app", "crypto investment", "payment transfers", "paid campaigns"]) {
  const forbiddenGate = evaluateCandidateGates([
    { ...commercialGroup[0], titleClaim: `Customers will pay for ${forbidden} software` },
    commercialGroup[1],
  ], "BUSINESS", commercialScore);
  assert.equal(forbiddenGate.legalNonProhibited, "FAIL", forbidden);
}

const stageA = generateBraveStageAQueries("AUTOMATION", "invoice follow-up");
assert.equal(stageA.length, 2);
assert.notEqual(stageA[0], stageA[1]);
const targeted = generateBraveTargetedQueries([...commercialGroup], "AUTOMATION");
assert.ok(targeted.length > 0);
assert.ok(targeted[0]?.includes("invoice"));

const rootDomainA = { ...commercialGroup[0], sourceUrl: "https://a.example.com/invoice" };
const rootDomainB = { ...commercialGroup[1], sourceUrl: "https://b.example.com/invoice" };
assert.equal(
  groupResearchFindings("BUSINESS", [rootDomainA, rootDomainB]).some((group) => group.group.length > 1),
  false,
  "sibling subdomains share one registrable independence root",
);
assert.equal(
  groupResearchFindings("BUSINESS", [
    { ...commercialGroup[0], source: "GITHUB_PUBLIC", sourceUrl: "https://github.com/acme/one/issues/1" },
    { ...commercialGroup[1], source: "GITHUB_PUBLIC", sourceUrl: "https://github.com/acme/two/issues/2" },
  ]).some((group) => group.group.length > 1),
  false,
  "github.com domain-only overlap cannot corroborate unrelated opportunities",
);
assert.equal(
  matchesExistingOpportunityProvenance(
    ["https://github.com/acme/product/issues/1"],
    ["https://github.com/acme/product/issues/2"],
    false,
  ),
  false,
  "different issues in one repository require semantic problem agreement",
);
assert.equal(
  matchesExistingOpportunityProvenance(
    ["https://github.com/acme/product/issues/1"],
    ["https://github.com/acme/product/issues/1?utm_source=test"],
    false,
  ),
  true,
  "the same canonical document can deduplicate independently",
);

let requestUrl = "";
let requestHeaders: unknown;
const braveAdapter = createBraveSearchAdapter({
  getApiKey: () => "fixture-brave-key",
  now: () => now,
  fetch: async (url, init) => {
    requestUrl = String(url);
    requestHeaders = init?.headers;
    return new Response(JSON.stringify({ web: { results: [] } }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  },
});
const braveResponse = await braveAdapter("invoice reminders");
assert.match(requestUrl, /^https:\/\/api\.search\.brave\.com\/res\/v1\/web\/search\?/);
assert.match(requestUrl, /(?:\?|&)q=invoice(?:%20|\+)reminders(?:&|$)/);
assert.equal(new Headers(requestHeaders as Record<string, string>).get("X-Subscription-Token"), "fixture-brave-key");
assert.equal(JSON.stringify(braveResponse).includes("fixture-brave-key"), false);

const missingKey = await runBraveSearchFunnel(["one"], { getApiKey: () => undefined });
assert.deepEqual(missingKey.counters, {
  brave_requests_attempted: 0,
  brave_requests_successful: 0,
  brave_requests_failed: 0,
});
assert.equal(missingKey.attempts[0]?.error, "BRAVE_SEARCH_API_KEY_MISSING");

const claimedQueries = new Set<string>();
let concurrentCalls = 0;
const reserve = async (attempt: { provider: string; query: string; stage: "BROAD" | "TARGETED" }) => {
  const key = `${attempt.provider}|${attempt.query}`;
  if (claimedQueries.has(key)) return false;
  claimedQueries.add(key);
  return true;
};
const concurrentTransport = async () => {
  concurrentCalls += 1;
  return new Response(JSON.stringify({ web: { results: [] } }), { status: 200 });
};
const [concurrentOne, concurrentTwo] = await Promise.all([
  runBraveSearchFunnel(["same-query"], {
    getApiKey: () => "fixture-brave-key",
    reserveAttempt: reserve,
    fetch: concurrentTransport,
  }),
  runBraveSearchFunnel(["same-query"], {
    getApiKey: () => "fixture-brave-key",
    reserveAttempt: reserve,
    fetch: concurrentTransport,
  }),
]);
assert.equal(concurrentCalls, 1, "atomic reservation prevents concurrent duplicate provider calls");
assert.equal(
  [concurrentOne, concurrentTwo].filter((run) =>
    run.attempts.some((attempt) => attempt.error === "ATTEMPT_ALREADY_RESERVED")).length,
  1,
);

const funnelCalls: string[] = [];
const funnelRun = await runBraveSearchFunnel([], {
  category: "AUTOMATION",
  query: "invoice follow-up",
  getApiKey: () => "fixture-brave-key",
  now: () => now,
  fetch: async (url) => {
    const query = new URL(String(url)).searchParams.get("q") ?? "";
    funnelCalls.push(query);
    return new Response(JSON.stringify({
      web: {
        results: [{
          title: "Customers will pay for invoice billing automation",
          url: `https://result-${funnelCalls.length}.example${funnelCalls.length}.org/problem`,
          description: "Businesses hire help to automate manual invoice follow-up.",
          published_date: "2099-01-10T00:00:00.000Z",
        }],
      },
    }), { status: 200 });
  },
});
assert.equal(funnelRun.counters.brave_requests_attempted, funnelCalls.length);
assert.ok(funnelCalls.length <= 12);
assert.equal(funnelCalls[0], stageA[0]!.replace("invoice follow-up", "invoice follow-up"));
assert.ok(funnelCalls.slice(2).every((query) => query.includes("Customers will pay for")));
assert.equal(funnelRun.attempts[0]?.stage, "BROAD");
assert.ok(funnelRun.attempts.some((attempt) => attempt.stage === "TARGETED"));

const resumeCalls: string[] = [];
const resumed = await runBraveSearchFunnel([], {
  category: "AUTOMATION",
  query: "invoice follow-up",
  getApiKey: () => "fixture-brave-key",
  checkpoint: {
    counters: { brave_requests_attempted: 1, brave_requests_successful: 1, brave_requests_failed: 0 },
    attempts: [{ provider: "BRAVE_SEARCH", query: stageA[0]!, status: "SUCCEEDED", resultCount: 1 }],
    normalizedResults: [{
      title: "Customers pay for invoice follow-up",
      url: "https://prior.example.org/problem",
      domain: "prior.example.org",
      description: "Businesses hire help to automate manual invoice follow-up.",
      retrievedAt: now,
      publicationDate: new Date("2026-01-10T00:00:00.000Z"),
      publicationDateStatus: "VERIFIED",
    }],
  },
  completedQueries: [stageA[0]!],
  fetch: async (url) => {
    resumeCalls.push(String(url));
    return new Response(JSON.stringify({ web: { results: [] } }), { status: 200 });
  },
});
assert.equal(
  resumeCalls.some((url) => new URL(url).searchParams.get("q") === stageA[0]),
  false,
);
assert.ok(resumed.counters.brave_requests_attempted >= 1);

const budgetRun = await runBraveSearchFunnel(
  Array.from({ length: 31 }, (_, index) => `query-${index}`),
  {
    getApiKey: () => "fixture-brave-key",
    fetch: async () => new Response(JSON.stringify({ web: { results: [] } }), { status: 200 }),
  },
);
assert.equal(budgetRun.counters.brave_requests_attempted, 30);
assert.equal(budgetRun.counters.brave_requests_successful, 30);
assert.equal(budgetRun.counters.brave_requests_failed, 0);
assert.equal(budgetRun.attempts.at(-1)?.error, STOP_BRAVE_BUDGET_REACHED);

console.log("discovery research fixture checks passed");