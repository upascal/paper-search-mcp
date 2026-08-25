import { describe, it, expect } from "vitest";
import {
  RANKING_PRESETS,
  resolveWeights,
  normalizeWeights,
  freshness,
  citationNorm,
  computeBlendedScore,
} from "../../src/scoring";
import type { Paper } from "../../src/platforms/types";

function makePaper(overrides: Partial<Paper>): Paper {
  return {
    paper_id: "p1",
    title: "Test",
    authors: [],
    abstract: "",
    doi: "",
    url: "",
    pdf_url: "",
    published_date: "",
    source: "crossref",
    citations: 0,
    categories: [],
    keywords: [],
    extra: {},
    ...overrides,
  };
}

describe("resolveWeights", () => {
  it("defaults to the relevance preset", () => {
    const { weights, preset } = resolveWeights(undefined);
    expect(preset).toBe("relevance");
    expect(weights).toEqual(RANKING_PRESETS.relevance);
  });

  it("individual overrides win over the preset", () => {
    const { weights } = resolveWeights("impact", { citations: 0, recency: 2 });
    expect(weights.citations).toBe(0); // overridden from 5
    expect(weights.recency).toBe(2); // overridden from 0
    expect(weights.relevance).toBe(RANKING_PRESETS.impact.relevance);
    expect(weights.quality).toBe(RANKING_PRESETS.impact.quality);
  });

  it("zero is a valid override (not treated as unset)", () => {
    const { weights } = resolveWeights("relevance", { quality: 0 });
    expect(weights.quality).toBe(0);
  });
});

describe("normalizeWeights", () => {
  it("normalizes to sum 1", () => {
    const n = normalizeWeights({ relevance: 7, quality: 3, recency: 0, citations: 0 });
    expect(n.relevance).toBeCloseTo(0.7);
    expect(n.quality).toBeCloseTo(0.3);
    expect(n.relevance + n.quality + n.recency + n.citations).toBeCloseTo(1);
  });

  it("all zeros fall back to equal weights", () => {
    const n = normalizeWeights({ relevance: 0, quality: 0, recency: 0, citations: 0 });
    expect(n).toEqual({ relevance: 0.25, quality: 0.25, recency: 0.25, citations: 0.25 });
  });
});

describe("freshness", () => {
  it("is ~1 for today and 0 beyond the window", () => {
    const today = new Date().toISOString().slice(0, 10);
    expect(freshness(today)).toBeGreaterThan(0.99);
    expect(freshness("2015-01-01")).toBe(0);
  });

  it("is 0 for missing or invalid dates", () => {
    expect(freshness(undefined)).toBe(0);
    expect(freshness("not-a-date")).toBe(0);
  });
});

describe("citationNorm", () => {
  it("is 0 at zero citations and caps at 1.0 for 1000+", () => {
    expect(citationNorm(0)).toBe(0);
    expect(citationNorm(1000)).toBeCloseTo(1.0, 2);
    expect(citationNorm(50000)).toBe(1.0);
  });

  it("is monotonic", () => {
    expect(citationNorm(100)).toBeGreaterThan(citationNorm(10));
    expect(citationNorm(10)).toBeGreaterThan(citationNorm(1));
  });
});

describe("computeBlendedScore", () => {
  it("pure relevance weighting ranks by normalized RRF", () => {
    const w = normalizeWeights({ relevance: 10, quality: 0, recency: 0, citations: 0 });
    const top = makePaper({ extra: { rrf_score: 0.032 } });
    const mid = makePaper({ extra: { rrf_score: 0.016 } });
    const sTop = computeBlendedScore(top, 0.032, w);
    const sMid = computeBlendedScore(mid, 0.032, w);
    expect(sTop.final).toBeCloseTo(1.0);
    expect(sMid.final).toBeCloseTo(0.5);
  });

  it("citation weighting can outrank relevance", () => {
    const w = normalizeWeights({ relevance: 2, quality: 0, recency: 0, citations: 8 });
    const relevant = makePaper({ extra: { rrf_score: 0.032 }, citations: 0 });
    const cited = makePaper({ extra: { rrf_score: 0.016 }, citations: 1000 });
    const sRel = computeBlendedScore(relevant, 0.032, w);
    const sCited = computeBlendedScore(cited, 0.032, w);
    expect(sCited.final).toBeGreaterThan(sRel.final);
  });

  it("handles empty extras without NaN", () => {
    const w = normalizeWeights(RANKING_PRESETS.balanced);
    const s = computeBlendedScore(makePaper({}), 0, w);
    expect(Number.isFinite(s.final)).toBe(true);
    expect(s.final).toBe(0);
  });
});
