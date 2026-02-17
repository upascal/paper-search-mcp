import { describe, it, expect } from "vitest";
import { pubmed } from "../../src/platforms/pubmed";
import { mockEnv } from "./setup";

describe("PubMed", () => {
  it("searches for papers", async () => {
    const result = await pubmed.search(
      { query: "CRISPR gene editing", max_results: 3 },
      mockEnv
    );
    expect(result.papers.length).toBeGreaterThan(0);
    expect(result.papers[0].paper_id).toBeTruthy();
    expect(result.papers[0].source).toBe("pubmed");
    expect(result.papers[0].url).toContain("pubmed.ncbi.nlm.nih.gov");
  });
});
