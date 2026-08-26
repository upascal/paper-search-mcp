import { describe, it, expect } from "vitest";
import { semanticScholar } from "../../src/platforms/semantic-scholar";
import { openalex } from "../../src/platforms/openalex";
import { mockEnv } from "./setup";

// Regression net for the batched lookup paths used by rerank_papers.
// Alignment is the contract: out[i] corresponds to ids[i], null where a
// platform cannot resolve that ID. As with the other S2 tests, only 429
// rate limiting is tolerated — a 400 (bad field list) must FAIL.
describe("batch getById", () => {
  it("S2: resolves DOIs, nulls foreign IDs, preserves alignment", async () => {
    try {
      const out = await semanticScholar.getByIdBatch!(
        ["DOI:10.18653/v1/N18-3011", "W2741809807", "DOI:10.9999/nonexistent"],
        mockEnv
      );
      expect(out).toHaveLength(3);
      expect(out[0]?.title).toMatch(/Literature Graph/i);
      // DETAIL_FIELDS (incl. tldr, authors.hIndex) accepted on /paper/batch
      expect(out[0]?.extra?.tldr).toBeTruthy();
      expect(out[1]).toBeNull();
      expect(out[2]).toBeNull();
    } catch (err: any) {
      if (err.message?.includes("429")) {
        console.warn("Skipped: rate limited (no API key).");
        return;
      }
      throw err;
    }
  });

  it("OpenAlex: resolves DOIs and W-ids, nulls unresolvable IDs, preserves alignment", async () => {
    const out = await openalex.getByIdBatch!(
      ["10.18653/v1/N18-3011", "W2741809807", "not-a-resolvable-id"],
      mockEnv
    );
    expect(out).toHaveLength(3);
    expect(out[0]?.title).toBeTruthy();
    expect(out[0]?.doi?.toLowerCase()).toBe("10.18653/v1/n18-3011");
    expect(out[1]?.title).toBeTruthy();
    expect(out[2]).toBeNull();
  });
});
