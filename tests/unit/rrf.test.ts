import { describe, it, expect } from "vitest";
import { reciprocalRankFusion } from "../../src/rrf";
import type { Paper } from "../../src/platforms/types";

function makePaper(overrides: Partial<Paper>): Paper {
  return {
    paper_id: "",
    title: "Test Paper",
    authors: [],
    abstract: "",
    doi: "",
    url: "",
    pdf_url: "",
    published_date: "",
    source: "semantic_scholar",
    citations: 0,
    categories: [],
    keywords: [],
    extra: {},
    ...overrides,
  };
}

describe("reciprocalRankFusion dedup", () => {
  it("merges an arXiv API record with an S2 record carrying the arXiv DOI", () => {
    const fromArxiv = makePaper({
      source: "arxiv",
      paper_id: "2309.02144",
      abstract: "short",
    });
    const fromS2 = makePaper({
      source: "semantic_scholar",
      paper_id: "abc123",
      doi: "10.48550/arXiv.2309.02144",
      abstract: "a longer abstract with more detail",
    });
    const fused = reciprocalRankFusion([[fromArxiv], [fromS2]]);
    expect(fused).toHaveLength(1);
    expect(fused[0].extra?.source_count).toBe(2);
    expect(fused[0].abstract).toBe("a longer abstract with more detail");
  });

  it("merges via S2 externalIds.ArXiv even without a DOI", () => {
    const fromArxiv = makePaper({ source: "arxiv", paper_id: "2201.11903" });
    const fromS2 = makePaper({
      source: "semantic_scholar",
      paper_id: "def456",
      extra: { externalIds: { ArXiv: "2201.11903v1" } },
    });
    const fused = reciprocalRankFusion([[fromArxiv], [fromS2]]);
    expect(fused).toHaveLength(1);
    expect(fused[0].extra?.source_count).toBe(2);
  });

  it("merges published-DOI records case-insensitively and across URL prefixes", () => {
    const fromCrossref = makePaper({
      source: "crossref",
      paper_id: "x",
      doi: "10.1038/S41586-024-07487-W",
    });
    const fromOpenalex = makePaper({
      source: "openalex",
      paper_id: "W123",
      doi: "https://doi.org/10.1038/s41586-024-07487-w",
    });
    const fused = reciprocalRankFusion([[fromCrossref], [fromOpenalex]]);
    expect(fused).toHaveLength(1);
    expect(fused[0].extra?.source_count).toBe(2);
  });

  it("merges an arXiv record that links its published DOI with the CrossRef record", () => {
    const fromArxiv = makePaper({
      source: "arxiv",
      paper_id: "2309.99999",
      doi: "10.1038/s41586-024-00001-1",
    });
    const fromCrossref = makePaper({
      source: "crossref",
      paper_id: "y",
      doi: "10.1038/s41586-024-00001-1",
    });
    const fused = reciprocalRankFusion([[fromArxiv], [fromCrossref]]);
    expect(fused).toHaveLength(1);
    expect(fused[0].extra?.source_count).toBe(2);
  });

  it("keeps distinct papers distinct", () => {
    const a = makePaper({ source: "arxiv", paper_id: "2309.02144" });
    const b = makePaper({ source: "arxiv", paper_id: "2201.11903" });
    const c = makePaper({ source: "crossref", paper_id: "z", doi: "10.1000/x" });
    const fused = reciprocalRankFusion([[a, b], [c]]);
    expect(fused).toHaveLength(3);
  });

  it("ranks papers found by multiple sources above single-source papers at the same rank", () => {
    const shared1 = makePaper({ source: "arxiv", paper_id: "2309.02144" });
    const shared2 = makePaper({
      source: "semantic_scholar",
      paper_id: "s2id",
      doi: "10.48550/arXiv.2309.02144",
    });
    const single = makePaper({ source: "crossref", paper_id: "q", doi: "10.1000/y" });
    const fused = reciprocalRankFusion([[shared1], [shared2, single]]);
    expect(fused[0].extra?.source_count).toBe(2);
    expect(fused[0].extra?.rrf_score).toBeGreaterThan(
      fused[1].extra?.rrf_score as number
    );
  });
});
