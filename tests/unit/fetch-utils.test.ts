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
