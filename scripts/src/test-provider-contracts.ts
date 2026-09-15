import assert from "node:assert/strict";
import {
  createBraveSearchAdapter,
  createGithubPublicAdapter,
  createHackerNewsAdapter,
  createStackExchangeAdapter,
} from "../../artifacts/api-server/src/lib/discovery-research";

const fixedNow = new Date("2026-01-15T12:00:00.000Z");
const requests: string[] = [];

function fixtureResponse(payload: unknown, status = 200) {
  return new Response(
    typeof payload === "string" ? payload : JSON.stringify(payload),
    { status, headers: { "content-type": "application/json" } },
  );
}

function fixtureFetch(payload: unknown, status = 200) {
  return async (url: string | URL, _init?: RequestInit) => {
    requests.push(String(url));
    return fixtureResponse(payload, status);
  };
}

async function rejectsWith(operation: () => Promise<unknown>, message: string) {
  await assert.rejects(operation, (error: unknown) => {
    assert.equal(error instanceof Error ? error.message : String(error), message);
    return true;
  });
}

const braveSuccess = createBraveSearchAdapter({
  getApiKey: () => "offline-fixture-token",
  now: () => fixedNow,
  fetch: fixtureFetch({
    web: {
      results: [{
        title: "Customers need invoice follow-up automation",
        url: "https://example.test/invoice?utm_source=fixture",
        description: "<b>Businesses</b> need a manual reminder workflow.",
        published_date: "2026-01-10T00:00:00.000Z",
      }],
    },
  }),
});
const braveResult = await braveSuccess("invoice reminders");
assert.equal(braveResult.source, "BRAVE_SEARCH");
assert.equal(braveResult.findings.length, 1);
assert.equal(braveResult.findings[0]?.sourceUrl, "https://example.test/invoice");
assert.equal(braveResult.findings[0]?.detectedAt.toISOString(), "2026-01-10T00:00:00.000Z");

const braveEmpty = createBraveSearchAdapter({
  getApiKey: () => "offline-fixture-token",
  fetch: fixtureFetch({ web: { results: [] } }),
});
assert.equal((await braveEmpty("no results")).findings.length, 0);

const bravePagedUrl: string[] = [];
const bravePaged = createBraveSearchAdapter({
  getApiKey: () => "offline-fixture-token",
  fetch: async (url) => {
    bravePagedUrl.push(String(url));
    return fixtureResponse({ web: { results: [] } });
  },
});
await bravePaged("page fixture", { page: 2 });
assert.equal(new URL(bravePagedUrl[0]!).searchParams.get("offset"), "20");

for (const status of [429, 503]) {
  const adapter = createBraveSearchAdapter({
    getApiKey: () => "offline-fixture-token",
    fetch: fixtureFetch({ error: "fixture" }, status),
  });
  await rejectsWith(() => adapter("status fixture"), `BRAVE_SEARCH_HTTP_${status}`);
}
await rejectsWith(
  () => createBraveSearchAdapter({
    getApiKey: () => "offline-fixture-token",
    fetch: fixtureFetch("{"),
  })("malformed json"),
  "BRAVE_SEARCH_MALFORMED_PAYLOAD",
);
await rejectsWith(
  () => createBraveSearchAdapter({
    getApiKey: () => "offline-fixture-token",
    fetch: fixtureFetch({ web: { items: [] } }),
  })("schema drift"),
  "BRAVE_SEARCH_MALFORMED_PAYLOAD",
);
await rejectsWith(
  () => createBraveSearchAdapter({
    getApiKey: () => "offline-fixture-token",
    fetch: async (_url, init) => {
      assert.ok(init?.signal, "the adapter must provide an abort signal");
      throw new Error("FIXTURE_TIMEOUT");
    },
  })("timeout"),
  "FIXTURE_TIMEOUT",
);

const providerFixtures = [
  {
    name: "HACKER_NEWS",
    make: (payload: unknown, status?: number) =>
      createHackerNewsAdapter({ fetch: fixtureFetch(payload, status) }),
    success: {
      hits: [{
        title: "Customers need invoice follow-up automation",
        objectID: "123",
        url: "https://news.example/story/123",
        story_text: "Manual reminders are slow.",
        created_at: "2026-01-10T00:00:00.000Z",
      }],
    },
    empty: { hits: [] },
    drift: { items: [] },
    collection: "hits",
  },
  {
    name: "STACK_EXCHANGE",
    make: (payload: unknown, status?: number) =>
      createStackExchangeAdapter({ fetch: fixtureFetch(payload, status) }),
    success: {
      items: [{
        title: "<b>How do I automate invoice reminders?</b>",
        link: "https://stackoverflow.com/questions/123",
        creation_date: 1_768_000_000,
        tags: ["invoicing", "automation"],
      }],
    },
    empty: { items: [] },
    drift: { questions: [] },
    collection: "items",
  },
  {
    name: "GITHUB_PUBLIC",
    make: (payload: unknown, status?: number) =>
      createGithubPublicAdapter({ fetch: fixtureFetch(payload, status) }),
    success: {
      items: [{
        title: "Add invoice reminder automation",
        html_url: "https://github.com/example/project/issues/123",
        body: "Manual follow-up is slow.",
        created_at: "2026-01-10T00:00:00.000Z",
      }],
    },
    empty: { items: [] },
    drift: { issues: [] },
    collection: "items",
  },
] as const;

for (const fixture of providerFixtures) {
  const success = await fixture.make(fixture.success)("invoice reminders");
  assert.equal(success.source, fixture.name);
  assert.equal(success.findings.length, 1, `${fixture.name} success fixture`);
  assert.ok(success.findings[0]?.titleClaim, `${fixture.name} normalized title`);

  const empty = await fixture.make(fixture.empty)("empty");
  assert.equal(empty.findings.length, 0, `${fixture.name} empty fixture`);

  const pageUrls: string[] = [];
  const pagedMake = fixture.name === "HACKER_NEWS"
    ? createHackerNewsAdapter({
      fetch: async (url) => {
        pageUrls.push(String(url));
        return fixtureResponse(fixture.empty);
      },
    })
    : fixture.name === "STACK_EXCHANGE"
      ? createStackExchangeAdapter({
        fetch: async (url) => {
          pageUrls.push(String(url));
          return fixtureResponse(fixture.empty);
        },
      })
      : createGithubPublicAdapter({
        fetch: async (url) => {
          pageUrls.push(String(url));
          return fixtureResponse(fixture.empty);
        },
      });
  await pagedMake("page fixture", { page: 2 });
  assert.equal(
    new URL(pageUrls[0]!).searchParams.get("page"),
    "2",
    `${fixture.name} pagination query`,
  );

  for (const status of [429, 503]) {
    await rejectsWith(
      () => fixture.make({ [fixture.collection]: [] }, status)("status fixture"),
      "DISCOVERY_SOURCE_HTTP_" + status,
    );
  }
  await rejectsWith(
    () => fixture.make("{")("malformed json"),
    `${fixture.name}_MALFORMED_PAYLOAD`,
  );
  await rejectsWith(
    () => fixture.make(fixture.drift)("schema drift"),
    `${fixture.name}_MALFORMED_PAYLOAD`,
  );
}

for (const make of [
  createHackerNewsAdapter,
  createStackExchangeAdapter,
  createGithubPublicAdapter,
] as const) {
  await rejectsWith(
    () => make({
      fetch: async (_url, init) => {
        assert.ok(init?.signal, "the adapter must provide an abort signal");
        throw new Error("FIXTURE_TIMEOUT");
      },
    })("timeout"),
    "FIXTURE_TIMEOUT",
  );
}

assert.ok(requests.every((url) => !url.includes("offline-fixture-token")));
console.log("Offline provider contract fixtures passed: Brave, Hacker News, Stack Exchange, GitHub Public");