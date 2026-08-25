import { describe, it, expect } from "vitest";
import { arxiv } from "../../src/platforms/arxiv";
import { mockEnv } from "./setup";

// arXiv rate-limits aggressively under load (e.g. after bench runs from the
// same IP). Tolerate 429s the same way the Semantic Scholar tests do —
// the cooldown error message also contains "429".
describe("arXiv", () => {
  it("searches for papers", async () => {
    try {
      const result = await arxiv.search(
        { query: "all:transformer attention mechanism", max_results: 3 },
        mockEnv
      );
      expect(result.papers.length).toBeGreaterThan(0);
      expect(result.papers[0].paper_id).toBeTruthy();
      expect(result.papers[0].source).toBe("arxiv");
      expect(result.papers[0].pdf_url).toContain("arxiv.org/pdf/");
    } catch (err: any) {
      if (/429|timed out|timeout/i.test(err.message ?? "")) {
        console.warn("Skipped: arXiv rate limited or unreachable.");
        return;
      }
      throw err;
    }
  }, 60_000);

  it("searches by category", async () => {
    try {
      const result = await arxiv.search(
        { query: "cat:cs.IR", max_results: 3, sort_by: "submittedDate" },
        mockEnv
      );
      expect(result.papers.length).toBeGreaterThan(0);
    } catch (err: any) {
      if (/429|timed out|timeout/i.test(err.message ?? "")) {
        console.warn("Skipped: arXiv rate limited or unreachable.");
        return;
      }
      throw err;
    }
  }, 60_000);
});
