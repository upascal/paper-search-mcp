import type { Paper } from "./platforms/types.js";

/**
 * Discovery signals for ranking new research that lacks citation data.
 *
 * Instead of relying on citations (which take months/years to accumulate),
 * this module scores papers using proxy signals for quality and relevance:
 * author reputation, multi-platform presence, venue quality, and metadata
 * completeness.
 */

/** Individual signal values attached to each paper for transparency. */
export interface DiscoverySignals {
  author_reputation: number;
  source_count: number;
  venue_quality: number;
  abstract_quality: number;
  author_count: number;
  metadata_richness: number;
  recency: number;
}

/** Signal weights — must sum to 1.0. */
const WEIGHTS = {
  author_reputation: 0.3,
  source_count: 0.2,
  venue_quality: 0.15,
  abstract_quality: 0.1,
  author_count: 0.1,
  metadata_richness: 0.1,
  recency: 0.05,
} as const;

/**
 * Compute a 0–100 discovery score for a paper.
 * Higher scores indicate papers more likely to be high-quality new research.
 */
export function computeDiscoveryScore(paper: Paper): {
  score: number;
  signals: DiscoverySignals;
} {
  const signals: DiscoverySignals = {
    author_reputation: scoreAuthorReputation(paper),
    source_count: scoreSourceCount(paper),
    venue_quality: scoreVenueQuality(paper),
    abstract_quality: scoreAbstractQuality(paper),
    author_count: scoreAuthorCount(paper),
    metadata_richness: scoreMetadataRichness(paper),
    recency: scoreRecency(paper),
  };

  // Weighted sum → scale to 0–100
  let score = 0;
  for (const [key, weight] of Object.entries(WEIGHTS)) {
    score += signals[key as keyof DiscoverySignals] * weight;
  }
  score = Math.round(score * 100);

  return { score, signals };
}

/**
 * Enrich papers with discovery scores and return sorted by score descending.
 */
export function enrichWithDiscoveryScore(papers: Paper[]): Paper[] {
  return papers
    .map((paper) => {
      const { score, signals } = computeDiscoveryScore(paper);
      return {
        ...paper,
        extra: {
          ...paper.extra,
          discovery_score: score,
          discovery_signals: signals,
        },
      };
    })
    .sort(
      (a, b) =>
        ((b.extra?.discovery_score as number) ?? 0) -
        ((a.extra?.discovery_score as number) ?? 0)
    );
}

// ---------------------------------------------------------------------------
// Individual signal scoring functions (each returns 0.0–1.0)
// ---------------------------------------------------------------------------

/**
 * Author reputation: use the max h-index among authors.
 * Available from Semantic Scholar (author_h_indices in extra).
 * Normalized: h-index of 80+ → 1.0 (top researchers like Hinton, LeCun).
 * If no h-index data is available, returns 0.5 (neutral, doesn't penalize).
 */
function scoreAuthorReputation(paper: Paper): number {
  const hIndices = paper.extra?.author_h_indices as number[] | undefined;
  if (!hIndices || hIndices.length === 0) return 0.5;
  const maxH = Math.max(...hIndices);
  return Math.min(maxH / 80, 1.0);
}

/**
 * Multi-platform presence: papers found by more platforms are more notable.
 * source_count is set by RRF. Range: 1–4+ platforms.
 */
function scoreSourceCount(paper: Paper): number {
  const count = (paper.extra?.source_count as number) ?? 1;
  // 1 source → 0.25, 2 → 0.5, 3 → 0.75, 4+ → 1.0
  return Math.min(count / 4, 1.0);
}

/**
 * Venue quality: published in a known journal/conference scores higher.
 * Uses venue info from S2 (extra.venue), OpenAlex (extra.journal),
 * or CrossRef (extra.container_title).
 */
function scoreVenueQuality(paper: Paper): number {
  const venue =
    (paper.extra?.venue as string) ??
    (paper.extra?.journal as string) ??
    (paper.extra?.container_title as string);

  if (!venue) {
    // Check if it's a known preprint server (partial credit)
    if (
      paper.source === "arxiv" ||
      paper.source === "biorxiv" ||
      paper.source === "medrxiv"
    ) {
      return 0.4;
    }
    return 0.0;
  }

  // Has a venue name — check if it's a preprint venue vs. peer-reviewed
  const venueType = paper.extra?.venue_type as string | undefined;
  if (venueType === "journal" || venueType === "conference") return 1.0;

  // Has venue name but unknown type — likely a real publication
  return 0.8;
}

/**
 * Abstract quality: longer, more substantive abstracts indicate more complete work.
 * Normalized: 500+ characters → 1.0.
 */
function scoreAbstractQuality(paper: Paper): number {
  const len = paper.abstract?.length ?? 0;
  if (len === 0) return 0.0;
  return Math.min(len / 500, 1.0);
}

/**
 * Author count: multi-author papers often indicate more resources and review.
 * Normalized: 5+ authors → 1.0. Single author → 0.2 (still valid, just less signal).
 */
function scoreAuthorCount(paper: Paper): number {
  const count = paper.authors?.length ?? 0;
  if (count === 0) return 0.0;
  return Math.min(count / 5, 1.0);
}

/**
 * Metadata richness: papers with categories, keywords, and DOI are better indexed.
 * Each element contributes equally.
 */
function scoreMetadataRichness(paper: Paper): number {
  let score = 0;
  if (paper.categories && paper.categories.length > 0) score += 0.33;
  if (paper.keywords && paper.keywords.length > 0) score += 0.33;
  if (paper.doi) score += 0.34;
  return score;
}

/**
 * Recency: newer papers get a slight boost in discovery mode.
 * Papers from the last 7 days → 1.0, 30+ days → 0.0.
 */
function scoreRecency(paper: Paper): number {
  if (!paper.published_date) return 0.5; // neutral if unknown
  const pubDate = new Date(paper.published_date).getTime();
  if (isNaN(pubDate)) return 0.5;

  const now = Date.now();
  const daysSincePublication = (now - pubDate) / (1000 * 60 * 60 * 24);

  if (daysSincePublication <= 7) return 1.0;
  if (daysSincePublication >= 30) return 0.0;
  // Linear decay between 7 and 30 days
  return 1.0 - (daysSincePublication - 7) / 23;
}
