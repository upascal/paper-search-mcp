import { describe, it, expect } from "vitest";
import { biorxiv, medrxiv } from "../../src/platforms/biorxiv";
import { mockEnv } from "./setup";

describe("bioRxiv", () => {
  it("fetches recent preprints", async () => {
    const result = await biorxiv.search(
      { query: "genomics", max_results: 3, days: 30 },
      mockEnv
    );
    // May return 0 if no matches in recent 30 days — that's OK
    expect(result.source).toBe("biorxiv");
    expect(Array.isArray(result.papers)).toBe(true);
  });
});

describe("medRxiv", () => {
  it("fetches recent preprints", async () => {
    const result = await medrxiv.search(
      { query: "epidemiology", max_results: 3, days: 30 },
      mockEnv
    );
    expect(result.source).toBe("medrxiv");
    expect(Array.isArray(result.papers)).toBe(true);
  });
});
