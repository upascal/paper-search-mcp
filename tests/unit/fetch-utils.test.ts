import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// The throttle must serialize CONCURRENT callers, not just sequential ones —
// the pre-fix implementation read the shared timestamp, slept, then wrote, so
// a burst of N requests all slept identically and fired at once (the exact
// pattern that 429s unauthenticated Semantic Scholar).
//
// Module state (slot map, cooldown map) is isolate-level, so each test
// re-imports a fresh module via resetModules.

const S2_URL = "https://api.semanticscholar.org/graph/v1/paper/search?query=x";

async function freshFetchWithRetry() {
  const mod = await import("../../src/platforms/fetch-utils");
  return mod.fetchWithRetry;
}

describe("fetchWithRetry throttling", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.resetModules();
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("spaces concurrent unauthenticated S2 requests >= 3.5s apart", async () => {
    const times: number[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        times.push(Date.now());
        return new Response("{}", { status: 200 });
      })
    );
    const fetchWithRetry = await freshFetchWithRetry();

    const all = Promise.all([
      fetchWithRetry(S2_URL),
      fetchWithRetry(S2_URL),
      fetchWithRetry(S2_URL),
    ]);
    await vi.runAllTimersAsync();
    await all;

    expect(times).toHaveLength(3);
    const sorted = [...times].sort((a, b) => a - b);
    expect(sorted[1] - sorted[0]).toBeGreaterThanOrEqual(3500);
    expect(sorted[2] - sorted[1]).toBeGreaterThanOrEqual(3500);
  });

  it("uses the faster 1s interval when an x-api-key header is present", async () => {
    const times: number[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        times.push(Date.now());
        return new Response("{}", { status: 200 });
      })
    );
    const fetchWithRetry = await freshFetchWithRetry();
    const opts = { headers: { "x-api-key": "test-key" } };

    const all = Promise.all([
      fetchWithRetry(S2_URL, opts),
      fetchWithRetry(S2_URL, opts),
      fetchWithRetry(S2_URL, opts),
    ]);
    await vi.runAllTimersAsync();
    await all;

    const sorted = [...times].sort((a, b) => a - b);
    expect(sorted[1] - sorted[0]).toBeGreaterThanOrEqual(1000);
    expect(sorted[2] - sorted[0]).toBeLessThan(3500);
  });

  it("enters cooldown after an unretried 429 and fails fast while cooling", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("rate limited", { status: 429 }))
    );
    const fetchWithRetry = await freshFetchWithRetry();

    // maxRetries=1: the 429 is returned immediately and sets the cooldown
    const resp = await fetchWithRetry(S2_URL, {}, 1);
    expect(resp.status).toBe(429);

    // While cooling, calls fail fast with the "429" marker message
    await expect(fetchWithRetry(S2_URL, {}, 1)).rejects.toThrow(/cooldown.*429|429.*cooldown/);
    expect(vi.mocked(fetch).mock.calls).toHaveLength(1);
  });
});

// The response cache: repeat lookups must not spend rate-limit budget, and
// cached data must keep flowing while a domain is in 429 cooldown.
describe("fetchWithRetry response cache", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.resetModules();
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  const DETAIL_URL = "https://api.semanticscholar.org/graph/v1/paper/DOI:10.1/x?fields=title";

  it("serves a repeat GET from cache without a second fetch", async () => {
    const mock = vi.fn(async () => new Response('{"n":1}', { status: 200 }));
    vi.stubGlobal("fetch", mock);
    const fetchWithRetry = await freshFetchWithRetry();

    const p1 = fetchWithRetry(DETAIL_URL);
    await vi.runAllTimersAsync();
    expect(await (await p1).json()).toEqual({ n: 1 });

    const r2 = await fetchWithRetry(DETAIL_URL); // cache hit — no throttle, no fetch
    expect(await r2.json()).toEqual({ n: 1 });
    expect(mock).toHaveBeenCalledTimes(1);
  });

  it("expires search results after their short TTL", async () => {
    const mock = vi.fn(async () => new Response("{}", { status: 200 }));
    vi.stubGlobal("fetch", mock);
    const fetchWithRetry = await freshFetchWithRetry();
    const searchUrl = "https://api.semanticscholar.org/graph/v1/paper/search?query=q";

    const p1 = fetchWithRetry(searchUrl, { headers: { "x-api-key": "k" } });
    await vi.runAllTimersAsync();
    await p1;
    await vi.advanceTimersByTimeAsync(3_600_001); // past the 1h search TTL

    const p2 = fetchWithRetry(searchUrl, { headers: { "x-api-key": "k" } });
    await vi.runAllTimersAsync();
    await p2;
    expect(mock).toHaveBeenCalledTimes(2);
  });

  it("keys POST requests by body", async () => {
    const mock = vi.fn(async () => new Response("[]", { status: 200 }));
    vi.stubGlobal("fetch", mock);
    const fetchWithRetry = await freshFetchWithRetry();
    const batchUrl = "https://api.semanticscholar.org/graph/v1/paper/batch?fields=title";
    const opts = (ids: string) => ({
      method: "POST",
      headers: { "x-api-key": "k" },
      body: `{"ids":["${ids}"]}`,
    });

    for (const ids of ["a", "b", "a"]) {
      const p = fetchWithRetry(batchUrl, opts(ids));
      await vi.runAllTimersAsync();
      await p;
    }
    expect(mock).toHaveBeenCalledTimes(2); // "a" cached, "b" distinct
  });

  it("serves cache hits while the domain is cooling down after a 429", async () => {
    const mock = vi.fn(async (url: string | URL) =>
      String(url).includes("search")
        ? new Response("rate limited", { status: 429 })
        : new Response('"cached-data"', { status: 200 })
    );
    vi.stubGlobal("fetch", mock);
    const fetchWithRetry = await freshFetchWithRetry();

    const p1 = fetchWithRetry(DETAIL_URL); // prime the cache
    await vi.runAllTimersAsync();
    await p1;

    const p2 = fetchWithRetry(
      "https://api.semanticscholar.org/graph/v1/paper/search?query=x",
      {},
      1
    ); // trips the cooldown
    await vi.runAllTimersAsync();
    expect((await p2).status).toBe(429);

    // Cached URL still answers during cooldown; uncached URLs fail fast
    const r3 = await fetchWithRetry(DETAIL_URL);
    expect(await r3.json()).toBe("cached-data");
    await expect(
      fetchWithRetry("https://api.semanticscholar.org/graph/v1/paper/DOI:10.1/uncached?fields=title")
    ).rejects.toThrow(/429/);
    expect(mock).toHaveBeenCalledTimes(2);
  });
});
