import assert from "node:assert/strict";

// This is deliberately a fixture-only regression check. Importing the module
// does not call an adapter; the research runner is never invoked here.
process.env.DATABASE_URL ??= "postgres://fixture:fixture@127.0.0.1:5432/fixture";
const {
  claimsMatch,
  evaluateFinding,
  fingerprint,
  groupResearchFindings,
  relevanceScore,
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

console.log("discovery research fixture checks passed");