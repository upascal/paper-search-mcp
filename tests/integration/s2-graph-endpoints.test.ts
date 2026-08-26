import { describe, it, expect, beforeEach } from "vitest";
import {
  getRecommendations,
  getCitations,
} from "../../src/platforms/semantic-scholar";
import { mockEnv } from "./setup";

// Regression net for the S2 endpoints beyond plain search. The
// /recommendations endpoint accepts a NARROWER field set than /graph —
// requesting tldr or authors.* aggregates returns a 400 (shipped as the
// find_similar_papers bug in v0.3.0). A 400 here must FAIL the test;
// only 429 rate limiting is tolerated.
const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

const SEED = "ARXIV:2201.11903"; // Chain-of-Thought prompting paper

describe("Semantic Scholar graph endpoints", () => {
  beforeEach(async () => {
    await delay(3000);
  });

  it("recommendations: field set is accepted and papers are returned", async () => {
    try {
      const papers = await getRecommendations([SEED], [], mockEnv, {
        limit: 3,
      });
      expect(papers.length).toBeGreaterThan(0);
      expect(papers[0].title).toBeTruthy();
      expect(papers[0].source).toBe("semantic_scholar");
    } catch (err: any) {
      if (err.message?.includes("429")) {
        console.warn("Skipped: rate limited (no API key).");
        return;
      }
      throw err;
    }
  });

  it("citations: walks references of a paper", async () => {
    try {
      const papers = await getCitations(SEED, "references", mockEnv, {
        limit: 3,
      });
      expect(papers.length).toBeGreaterThan(0);
      expect(papers[0].title).toBeTruthy();
    } catch (err: any) {
      if (err.message?.includes("429")) {
        console.warn("Skipped: rate limited (no API key).");
        return;
      }
      throw err;
    }
  });

  it("citations: walks citing papers", async () => {
    try {
      const papers = await getCitations(SEED, "citations", mockEnv, {
        limit: 3,
      });
      expect(papers.length).toBeGreaterThan(0);
    } catch (err: any) {
      if (err.message?.includes("429")) {
        console.warn("Skipped: rate limited (no API key).");
        return;
      }
      throw err;
    }
  });
});
