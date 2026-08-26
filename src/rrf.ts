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

/** Normalize a DOI: lowercase, strip URL prefixes and "doi:" label. */
function normalizeDoi(doi: string | undefined | null): string {
  if (!doi) return "";
  return doi
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\/(dx\.)?doi\.org\//, "")
    .replace(/^doi:/, "");
}

/** Extract a canonical arXiv id (version-stripped, lowercase) from any platform's record. */
function getArxivId(paper: Paper): string {
  if (paper.source === "arxiv" && paper.paper_id) {
    return paper.paper_id.toLowerCase().replace(/v\d+$/, "");
  }
  // Semantic Scholar carries externalIds.ArXiv
  const ext = (paper.extra as Record<string, any> | undefined)?.externalIds?.ArXiv;
  if (typeof ext === "string" && ext) {
    return ext.toLowerCase().replace(/v\d+$/, "");
  }
  // arXiv's own DOI namespace: 10.48550/arXiv.<id>
  const m = normalizeDoi(paper.doi).match(/^10\.48550\/arxiv\.(.+)$/);
  if (m) return m[1].replace(/v\d+$/, "");
  return "";
}

/**
 * Generate a deduplication key for a paper.
 *
 * A published DOI is the strongest identity — arXiv records that link their
 * published version (arxiv:doi) merge with CrossRef/S2 records through it.
 * arXiv's own DOI namespace (10.48550/…) identifies only the preprint, so
 * those key by canonical arXiv id instead, merging the arXiv API record with
 * S2/OpenAlex records of the same preprint.
 *
 * Known limitation: a preprint-only record and a published-DOI-only record of
 * the same paper cannot be merged without an external linkage lookup.
 */
function paperKey(paper: Paper): string {
  const doi = normalizeDoi(paper.doi);
  if (doi && !doi.startsWith("10.48550/")) return `doi:${doi}`;
  const arxivId = getArxivId(paper);
  if (arxivId) return `arxiv:${arxivId}`;
  if (doi) return `doi:${doi}`;
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
