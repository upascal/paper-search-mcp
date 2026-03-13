import type { Paper } from "./platforms/types.js";

/**
 * Reciprocal Rank Fusion (RRF) — merges multiple ranked lists into a single
 * unified ranking using rank-based scoring that is robust to incomparable
 * score scales across different APIs.
 *
 * score(paper) = Σ 1 / (k + rank_in_list)
 *
 * Reference: Cormack, Clarke & Buettcher (2009), SIGIR.
 *
 * k=60 is the standard constant from the original paper. Higher k values
 * give less weight to top-ranked results (more uniform weighting).
 */
export function reciprocalRankFusion(
  rankedLists: Paper[][],
  k = 60
): Paper[] {
  // Map: DOI or fallback key -> { paper, score, sourceCount }
  const scores = new Map<string, { paper: Paper; score: number; sourceCount: number }>();

  for (const list of rankedLists) {
    for (let rank = 0; rank < list.length; rank++) {
      const paper = list[rank];
      const key = paperKey(paper);
      const rrfScore = 1 / (k + rank + 1); // rank is 0-indexed, formula uses 1-indexed

      const existing = scores.get(key);
      if (existing) {
        existing.score += rrfScore;
        existing.sourceCount += 1;
        // Keep the version with more metadata (longer abstract, more fields)
        if (
          (paper.abstract?.length ?? 0) > (existing.paper.abstract?.length ?? 0)
        ) {
          existing.paper = mergePaperMetadata(existing.paper, paper);
        }
      } else {
        scores.set(key, { paper, score: rrfScore, sourceCount: 1 });
      }
    }
  }

  // Sort by RRF score descending
  const results = Array.from(scores.values());
  results.sort((a, b) => b.score - a.score);

  // Attach RRF score and source count in extra metadata
  return results.map(({ paper, score, sourceCount }) => ({
    ...paper,
    extra: {
      ...paper.extra,
      rrf_score: Math.round(score * 10000) / 10000,
      source_count: sourceCount,
    },
  }));
}

/** Generate a deduplication key for a paper. */
function paperKey(paper: Paper): string {
  if (paper.doi) return `doi:${paper.doi.toLowerCase()}`;
  return `${paper.source}:${paper.paper_id}`;
}

/** Merge metadata from two records of the same paper, preferring non-empty values. */
function mergePaperMetadata(existing: Paper, incoming: Paper): Paper {
  return {
    paper_id: existing.paper_id || incoming.paper_id,
    title: existing.title || incoming.title,
    authors: existing.authors.length > 0 ? existing.authors : incoming.authors,
    abstract:
      (existing.abstract?.length ?? 0) >= (incoming.abstract?.length ?? 0)
        ? existing.abstract
        : incoming.abstract,
    doi: existing.doi || incoming.doi,
    url: existing.url || incoming.url,
    pdf_url: existing.pdf_url || incoming.pdf_url,
    published_date: existing.published_date || incoming.published_date,
    source: existing.source, // keep original source
    citations: Math.max(existing.citations, incoming.citations),
    categories:
      existing.categories.length >= incoming.categories.length
        ? existing.categories
        : incoming.categories,
    keywords:
      existing.keywords.length >= incoming.keywords.length
        ? existing.keywords
        : incoming.keywords,
    extra: { ...incoming.extra, ...existing.extra },
  };
}
