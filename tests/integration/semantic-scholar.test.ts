import { describe, it, expect, beforeEach } from "vitest";
import { semanticScholar } from "../../src/platforms/semantic-scholar";
import { mockEnv } from "./setup";

// Semantic Scholar's unauthenticated pool is shared and aggressively rate-limited.
// Add delays between tests and tolerate 429 errors gracefully.
const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("Semantic Scholar", () => {
  beforeEach(async () => {
    await delay(3000);
  });

  it("searches for papers", async () => {
    try {
      const result = await semanticScholar.search(
        { query: "information retrieval", max_results: 3 },
        mockEnv
      );
      expect(result.papers.length).toBeGreaterThan(0);
      expect(result.papers[0].title).toBeTruthy();
      expect(result.papers[0].source).toBe("semantic_scholar");
      expect(result.source).toBe("semantic_scholar");
    } catch (err: any) {
      if (err.message?.includes("429")) {
        console.warn("Skipped: rate limited (no API key). Set SEMANTIC_SCHOLAR_API_KEY for reliable tests.");
        return;
      }
      throw err;
    }
  });

  it("searches with year filter", async () => {
    try {
      const result = await semanticScholar.search(
        { query: "large language models", max_results: 3, year: "2024" },
        mockEnv
      );
      expect(result.papers.length).toBeGreaterThan(0);
    } catch (err: any) {
      if (err.message?.includes("429")) {
        console.warn("Skipped: rate limited (no API key).");
        return;
      }
      throw err;
    }
  });

  it("looks up paper by DOI", async () => {
    try {
      const paper = await semanticScholar.getById!(
        "ARXIV:1706.03762",
        mockEnv
      );
      expect(paper).not.toBeNull();
      expect(paper!.title.toLowerCase()).toContain("attention");
    } catch (err: any) {
      if (err.message?.includes("429")) {
        console.warn("Skipped: rate limited (no API key).");
        return;
      }
      throw err;
    }
  });

  it("returns null for nonexistent paper", async () => {
    try {
      const paper = await semanticScholar.getById!(
        "DOI:10.9999/nonexistent.paper.id",
        mockEnv
      );
      expect(paper).toBeNull();
    } catch (err: any) {
      if (err.message?.includes("429")) {
        console.warn("Skipped: rate limited (no API key).");
        return;
      }
      throw err;
    }
  });
});
