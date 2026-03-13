import type { Paper } from "./platforms/types.js";

/**
 * Lifecycle-based discovery signals for ranking research papers.
 *
 * Two scoring modes reflect two research workflows:
 *
 * 1. **discovery** (0–6 weeks): Surface promising new research before citations
 *    accumulate. Relies on venue quality, multi-platform presence, metadata
 *    completeness, and recency. Author h-index is heavily deweighted (research
 *    shows it's biased against early-career researchers, slower-citing fields
 *    like social science, and women).
 *
 * 2. **literature_review** (temporally wide-ranging): Rank established papers
 *    using field-normalized citation metrics (FWCI, citation_normalized_percentile
 *    from OpenAlex) which enable cross-discipline comparison — essential for
 *    work spanning social science, CS, and economics where raw citation counts
 *    differ by an order of magnitude.
 *
 * The key architectural insight from the research: design every scoring function
 * to accept paper age as a parameter that re-weights the signal ensemble.
 */

/** Scoring mode. */
export type ScoringMode = "discovery" | "literature_review";

/** Individual signal values attached to each paper for transparency. */
export interface DiscoverySignals {
  venue_quality: number;
  fwci: number;
  citation_percentile: number;
  source_count: number;
  abstract_quality: number;
  metadata_richness: number;
  recency: number;
  author_reputation: number;
  author_count: number;
}

/**
 * Weight profiles for each scoring mode.
 *
 * Discovery mode prioritizes signals available for brand-new papers.
 * Literature review mode leans on field-normalized citation metrics.
 *
 * Both sum to 1.0.
 */
const WEIGHT_PROFILES: Record<ScoringMode, Record<keyof DiscoverySignals, number>> = {
  discovery: {
    venue_quality: 0.25,     // Strongest pre-citation quality signal
    source_count: 0.20,      // Multi-platform presence = more notable
    abstract_quality: 0.15,  // Substantive abstract = more complete work
    metadata_richness: 0.10, // Well-indexed = better provenance
    recency: 0.10,           // Newer = more timely for discovery
    author_reputation: 0.08, // Deweighted: biased by field, career stage, gender
    fwci: 0.05,              // Usually null for new papers, but use if available
    citation_percentile: 0.02, // Rarely available for new papers
    author_count: 0.05,      // Minor signal
  },
  literature_review: {
    fwci: 0.30,              // Field-normalized impact — the gold standard
    venue_quality: 0.20,     // Venue tier matters for established work
    citation_percentile: 0.15, // Complementary to FWCI
    source_count: 0.10,      // Multi-platform presence
    author_reputation: 0.08, // Still deweighted vs. old 30%
    abstract_quality: 0.05,  // Less important for established papers
    metadata_richness: 0.05, // Hygiene check
    recency: 0.05,           // Slight recency preference
    author_count: 0.02,      // Minor signal
  },
};

/**
 * Compute a 0–100 score for a paper.
 *
 * @param paper - The paper to score
 * @param mode - Scoring mode: "discovery" for new papers (0–6 weeks),
 *               "literature_review" for established papers
 * @param venueQualityData - Optional venue 2yr_mean_citedness from OpenAlex
 *                           batch lookup (keyed by openalex_source_id)
 */
export function computeDiscoveryScore(
  paper: Paper,
  mode: ScoringMode = "discovery",
  venueQualityData?: Map<string, { citedness_2yr: number; h_index: number; works_count: number }>
): {
  score: number;
  signals: DiscoverySignals;
  mode: ScoringMode;
  field_context?: string;
} {
  const signals: DiscoverySignals = {
    venue_quality: scoreVenueQuality(paper, venueQualityData),
    fwci: scoreFWCI(paper),
    citation_percentile: scoreCitationPercentile(paper),
    source_count: scoreSourceCount(paper),
    abstract_quality: scoreAbstractQuality(paper),
    metadata_richness: scoreMetadataRichness(paper),
    recency: scoreRecency(paper, mode),
    author_reputation: scoreAuthorReputation(paper),
    author_count: scoreAuthorCount(paper),
  };

  const weights = WEIGHT_PROFILES[mode];

  let score = 0;
  for (const [key, weight] of Object.entries(weights)) {
    score += signals[key as keyof DiscoverySignals] * weight;
  }
  score = Math.round(score * 100);

  // Include field context if available (helps LLM interpret h-index)
  const fieldContext =
    (paper.extra?.primary_field as string) ??
    (paper.extra?.primary_subfield as string) ??
    undefined;

  return { score, signals, mode, field_context: fieldContext };
}

/**
 * Enrich papers with discovery scores and return sorted by score descending.
 */
export function enrichWithDiscoveryScore(
  papers: Paper[],
  mode: ScoringMode = "discovery",
  venueQualityData?: Map<string, { citedness_2yr: number; h_index: number; works_count: number }>
): Paper[] {
  return papers
    .map((paper) => {
      const { score, signals, mode: scoringMode, field_context } =
        computeDiscoveryScore(paper, mode, venueQualityData);
      return {
        ...paper,
        extra: {
          ...paper.extra,
          discovery_score: score,
          discovery_signals: signals,
          scoring_mode: scoringMode,
          ...(field_context ? { field_context } : {}),
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
 * Venue quality: uses OpenAlex 2yr_mean_citedness (≈ impact factor) when
 * available from batch lookup, otherwise falls back to venue type heuristic.
 *
 * Citedness normalization: 2yr_mean_citedness of 10+ → 1.0 (top venues like
 * Nature, Science). Most journals fall 1–5. Preprints get 0.4 (partial credit).
 */
function scoreVenueQuality(
  paper: Paper,
  venueQualityData?: Map<string, { citedness_2yr: number; h_index: number; works_count: number }>
): number {
  // Try enriched venue data first
  const sourceId = paper.extra?.openalex_source_id as string | undefined;
  if (sourceId && venueQualityData?.has(sourceId)) {
    const venue = venueQualityData.get(sourceId)!;
    if (venue.citedness_2yr > 0) {
      // Normalize: 10+ citedness → 1.0, log scale for better spread
      return Math.min(Math.log10(venue.citedness_2yr + 1) / Math.log10(11), 1.0);
    }
  }

  // Fallback: heuristic based on venue name and type
  const venue =
    (paper.extra?.venue as string) ??
    (paper.extra?.journal as string) ??
    (paper.extra?.container_title as string);

  if (!venue) {
    if (
      paper.source === "arxiv" ||
      paper.source === "biorxiv" ||
      paper.source === "medrxiv"
    ) {
      return 0.4; // Preprint servers: partial credit
    }
    return 0.0;
  }

  const venueType =
    (paper.extra?.venue_type as string) ??
    (paper.extra?.type as string);
  if (venueType === "journal" || venueType === "conference") return 0.8;

  return 0.6; // Has venue name but unknown type
}

/**
 * Field-Weighted Citation Impact from OpenAlex.
 * FWCI of 1.0 = average for the field. >1 = above average.
 * Normalized: FWCI of 5+ → 1.0 (excellent). Null → 0.5 (neutral).
 */
function scoreFWCI(paper: Paper): number {
  const fwci = paper.extra?.fwci as number | null | undefined;
  if (fwci == null) return 0.5; // Neutral when unavailable
  if (fwci <= 0) return 0.0;
  // Log scale: FWCI 5+ → 1.0
  return Math.min(Math.log10(fwci + 1) / Math.log10(6), 1.0);
}

/**
 * Citation normalized percentile from OpenAlex.
 * Already a 0–1 value representing percentile rank in same field/year/type.
 * Null → 0.5 (neutral).
 */
function scoreCitationPercentile(paper: Paper): number {
  const pct = paper.extra?.citation_normalized_percentile as number | null | undefined;
  if (pct == null) return 0.5;
  return pct; // Already 0–1
}

/**
 * Multi-platform presence: papers found by more platforms are more notable.
 */
function scoreSourceCount(paper: Paper): number {
  const count = (paper.extra?.source_count as number) ?? 1;
  return Math.min(count / 4, 1.0);
}

/**
 * Abstract quality: longer, more substantive abstracts indicate more complete work.
 */
function scoreAbstractQuality(paper: Paper): number {
  const len = paper.abstract?.length ?? 0;
  if (len === 0) return 0.0;
  return Math.min(len / 500, 1.0);
}

/**
 * Author count: multi-author papers often indicate more resources and review.
 */
function scoreAuthorCount(paper: Paper): number {
  const count = paper.authors?.length ?? 0;
  if (count === 0) return 0.0;
  return Math.min(count / 5, 1.0);
}

/**
 * Metadata richness: papers with categories, keywords, and DOI are better indexed.
 */
function scoreMetadataRichness(paper: Paper): number {
  let score = 0;
  if (paper.categories && paper.categories.length > 0) score += 0.25;
  if (paper.keywords && paper.keywords.length > 0) score += 0.25;
  if (paper.doi) score += 0.25;
  // Bonus for having field classification (OpenAlex topic data)
  if (paper.extra?.primary_topic) score += 0.25;
  return score;
}

/**
 * Recency scoring differs by mode:
 * - Discovery: 0–7 days = 1.0, linear decay to 42 days (6 weeks) = 0.0
 * - Literature review: 0–365 days = 1.0, exponential decay with 3-year half-life
 */
function scoreRecency(paper: Paper, mode: ScoringMode): number {
  if (!paper.published_date) return 0.5;
  const pubDate = new Date(paper.published_date).getTime();
  if (isNaN(pubDate)) return 0.5;

  const daysSince = (Date.now() - pubDate) / (1000 * 60 * 60 * 24);

  if (mode === "discovery") {
    if (daysSince <= 7) return 1.0;
    if (daysSince >= 42) return 0.0;
    return 1.0 - (daysSince - 7) / 35; // Linear decay 7–42 days
  }

  // Literature review: exponential decay, 3-year half-life
  const halfLife = 365 * 3;
  return Math.exp((-Math.LN2 * daysSince) / halfLife);
}

/**
 * Author reputation: max h-index among authors, heavily deweighted.
 *
 * NOTE: h-index varies dramatically by field and career stage.
 * Full professors average: biology ~30+, CS ~15, law ~2.8, social science ~8-15.
 * It's biased against early-career researchers, women, and slower-citing fields.
 * Use field-normalized metrics (FWCI) for cross-discipline comparison.
 *
 * Normalized: h-index 50+ → 1.0 (reduced from 80 to give more signal range).
 * No data → 0.5 (neutral, doesn't penalize).
 */
function scoreAuthorReputation(paper: Paper): number {
  const hIndices = paper.extra?.author_h_indices as number[] | undefined;
  if (!hIndices || hIndices.length === 0) return 0.5;
  const maxH = Math.max(...hIndices);
  return Math.min(maxH / 50, 1.0);
}
