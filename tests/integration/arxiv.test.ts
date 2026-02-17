import { describe, it, expect } from "vitest";
import { arxiv } from "../../src/platforms/arxiv";
import { mockEnv } from "./setup";

describe("arXiv", () => {
  it("searches for papers", async () => {
    const result = await arxiv.search(
      { query: "all:transformer attention mechanism", max_results: 3 },
      mockEnv
    );
    expect(result.papers.length).toBeGreaterThan(0);
    expect(result.papers[0].paper_id).toBeTruthy();
    expect(result.papers[0].source).toBe("arxiv");
    expect(result.papers[0].pdf_url).toContain("arxiv.org/pdf/");
  });

  it("searches by category", async () => {
    const result = await arxiv.search(
      { query: "cat:cs.IR", max_results: 3, sort_by: "submittedDate" },
      mockEnv
    );
    expect(result.papers.length).toBeGreaterThan(0);
  });
});
