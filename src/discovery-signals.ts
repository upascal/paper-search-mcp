import type { Paper } from "./platforms/types.js";

/**
 * Age-adaptive quality scoring for research papers.
 *
 * Instead of discrete "discovery" vs "literature_review" modes, the weight
 * profile interpolates continuously based on paper age:
 *
 *   0–6 weeks:   Pre-citation signals (venue quality, multi-platform, metadata)
 *   6 weeks–1yr: Blend — early citation data emerging + venue/metadata
 *   1yr+:        Post-citation signals (FWCI, citation percentile, venue)
 *
 * This means every paper gets scored by the signals actually available at its
 * lifecycle stage. No mode selection needed — it's fully automatic.
 */

/** Individual signal values attached to each paper for transparency. */
export interface QualitySignals {
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
 * Weight anchors at each end of the lifecycle.
 * The actual weights are linearly interpolated between these based on paper age.
 *
 * "early" = brand new (0 days old), "mature" = 2+ years old.
 * At 0 days: 100% early weights. At 730 days (2yr): 100% mature weights.
 * Between: linear blend.
 */
const EARLY_WEIGHTS: Record<keyof QualitySignals, number> = {
  venue_quality: 0.25,
  source_count: 0.20,
  abstract_quality: 0.15,
  metadata_richness: 0.10,
  recency: 0.10,
  author_reputation: 0.08,
  fwci: 0.05,
  citation_percentile: 0.02,
  author_count: 0.05,
};

const MATURE_WEIGHTS: Record<keyof QualitySignals, number> = {
  fwci: 0.30,
  venue_quality: 0.20,
  citation_percentile: 0.15,
  source_count: 0.10,
  author_reputation: 0.08,
  abstract_quality: 0.05,
  metadata_richness: 0.05,
  recency: 0.05,
  author_count: 0.02,
};

/** Interpolation window in days: 0 = fully early, MATURITY_DAYS = fully mature. */
const MATURITY_DAYS = 730; // 2 years

/**
 * Compute interpolated weights based on paper age.
 */
function getWeights(daysSincePublication: number): Record<keyof QualitySignals, number> {
  const t = Math.min(Math.max(daysSincePublication, 0) / MATURITY_DAYS, 1.0);

  const weights = {} as Record<keyof QualitySignals, number>;
  for (const key of Object.keys(EARLY_WEIGHTS) as (keyof QualitySignals)[]) {
    weights[key] = EARLY_WEIGHTS[key] * (1 - t) + MATURE_WEIGHTS[key] * t;
  }
  return weights;
}

/**
 * Compute a 0–100 quality score for a paper.
 * Weights adapt automatically based on paper age.
 *
 * @param paper - The paper to score
 * @param venueQualityData - Optional venue 2yr_mean_citedness from OpenAlex
 *                           batch lookup (keyed by openalex_source_id)
 */
export function computeQualityScore(
  paper: Paper,
  venueQualityData?: Map<string, { citedness_2yr: number; h_index: number; works_count: number }>
): {
  score: number;
  signals: QualitySignals;
  lifecycle_stage: string;
  paper_age_days: number;
  field_context?: string;
} {
  const paperAgeDays = getPaperAgeDays(paper);

  const signals: QualitySignals = {
    venue_quality: scoreVenueQuality(paper, venueQualityData),
    fwci: scoreFWCI(paper),
    citation_percentile: scoreCitationPercentile(paper),
    source_count: scoreSourceCount(paper),
    abstract_quality: scoreAbstractQuality(paper),
    metadata_richness: scoreMetadataRichness(paper),
    recency: scoreRecency(paper),
    author_reputation: scoreAuthorReputation(paper),
    author_count: scoreAuthorCount(paper),
  };

  const weights = getWeights(paperAgeDays);

  let score = 0;
  for (const [key, weight] of Object.entries(weights)) {
    score += signals[key as keyof QualitySignals] * weight;
  }
  score = Math.round(score * 100);

  const fieldContext =
    (paper.extra?.primary_field as string) ??
    (paper.extra?.primary_subfield as string) ??
    undefined;

  return {
    score,
    signals,
    lifecycle_stage: getLifecycleStage(paperAgeDays),
    paper_age_days: paperAgeDays,
    field_context: fieldContext,
  };
}

/**
 * Enrich papers with quality scores and return sorted by score descending.
 */
export function enrichWithQualityScore(
  papers: Paper[],
  venueQualityData?: Map<string, { citedness_2yr: number; h_index: number; works_count: number }>
): Paper[] {
  return papers
    .map((paper) => {
      const { score, signals, lifecycle_stage, paper_age_days, field_context } =
        computeQualityScore(paper, venueQualityData);
      return {
        ...paper,
        extra: {
          ...paper.extra,
          quality_score: score,
          quality_signals: signals,
          lifecycle_stage,
          paper_age_days,
          ...(field_context ? { field_context } : {}),
        },
      };
    })
    .sort(
      (a, b) =>
        ((b.extra?.quality_score as number) ?? 0) -
        ((a.extra?.quality_score as number) ?? 0)
    );
}


function getPaperAgeDays(paper: Paper): number {
  if (!paper.published_date) return 365; // Unknown age: assume ~1 year (mid-range)
  const pubDate = new Date(paper.published_date).getTime();
  if (isNaN(pubDate)) return 365;
  return Math.max(0, (Date.now() - pubDate) / (1000 * 60 * 60 * 24));
}

function getLifecycleStage(days: number): string {
  if (days <= 42) return "new";        // 0-6 weeks
  if (days <= 365) return "emerging";  // 6 weeks - 1 year
  return "established";                // 1 year+
}

// ---------------------------------------------------------------------------
// Individual signal scoring functions (each returns 0.0–1.0)
// ---------------------------------------------------------------------------

/**
 * Venue quality: uses OpenAlex 2yr_mean_citedness (≈ impact factor) when
 * available from batch lookup, otherwise falls back to venue type heuristic.
 */
function scoreVenueQuality(
  paper: Paper,
  venueQualityData?: Map<string, { citedness_2yr: number; h_index: number; works_count: number }>
): number {
  const sourceId = paper.extra?.openalex_source_id as string | undefined;
  if (sourceId && venueQualityData?.has(sourceId)) {
    const venue = venueQualityData.get(sourceId)!;
    if (venue.citedness_2yr > 0) {
      return Math.min(Math.log10(venue.citedness_2yr + 1) / Math.log10(11), 1.0);
    }
  }

  const venue =
    (paper.extra?.venue as string) ??
    (paper.extra?.journal as string) ??
    (paper.extra?.container_title as string);

  if (!venue) {
    if (paper.source === "arxiv" || paper.source === "biorxiv" || paper.source === "medrxiv") {
      return 0.4;
    }
    return 0.0;
  }

  const venueType = (paper.extra?.venue_type as string) ?? (paper.extra?.type as string);
  if (venueType === "journal" || venueType === "conference") return 0.8;
  return 0.6;
}

/** FWCI from OpenAlex. 1.0 = field average. Null → 0.5 (neutral). */
function scoreFWCI(paper: Paper): number {
  const fwci = paper.extra?.fwci as number | null | undefined;
  if (fwci == null) return 0.5;
  if (fwci <= 0) return 0.0;
  return Math.min(Math.log10(fwci + 1) / Math.log10(6), 1.0);
}

/** Citation percentile from OpenAlex. Already 0–1. Null → 0.5. */
function scoreCitationPercentile(paper: Paper): number {
  const pct = paper.extra?.citation_normalized_percentile as number | null | undefined;
  if (pct == null) return 0.5;
  return pct;
}

/** Multi-platform presence: found by more platforms = more notable. */
function scoreSourceCount(paper: Paper): number {
  const count = (paper.extra?.source_count as number) ?? 1;
  return Math.min(count / 4, 1.0);
}

/** Abstract quality: longer abstracts indicate more complete work. */
function scoreAbstractQuality(paper: Paper): number {
  const len = paper.abstract?.length ?? 0;
  if (len === 0) return 0.0;
  return Math.min(len / 500, 1.0);
}

/** Author count: multi-author papers indicate more resources. */
function scoreAuthorCount(paper: Paper): number {
  const count = paper.authors?.length ?? 0;
  if (count === 0) return 0.0;
  return Math.min(count / 5, 1.0);
}

/** Metadata richness: categories, keywords, DOI, field classification. */
function scoreMetadataRichness(paper: Paper): number {
  let score = 0;
  if (paper.categories && paper.categories.length > 0) score += 0.25;
  if (paper.keywords && paper.keywords.length > 0) score += 0.25;
  if (paper.doi) score += 0.25;
  if (paper.extra?.primary_topic) score += 0.25;
  return score;
}

/**
 * Recency: exponential decay with 1-year half-life.
 * 0 days = 1.0, 365 days ≈ 0.5, 730 days ≈ 0.25.
 */
function scoreRecency(paper: Paper): number {
  if (!paper.published_date) return 0.5;
  const pubDate = new Date(paper.published_date).getTime();
  if (isNaN(pubDate)) return 0.5;
  const daysSince = Math.max(0, (Date.now() - pubDate) / (1000 * 60 * 60 * 24));
  const halfLife = 365;
  return Math.exp((-Math.LN2 * daysSince) / halfLife);
}

/**
 * Author reputation: max h-index. Heavily deweighted in scoring.
 * h-index varies by field (CS ~15, biology ~30+, law ~2.8).
 * No data → 0.5 (neutral).
 */
function scoreAuthorReputation(paper: Paper): number {
  const hIndices = paper.extra?.author_h_indices as number[] | undefined;
  if (!hIndices || hIndices.length === 0) return 0.5;
  const maxH = Math.max(...hIndices);
  return Math.min(maxH / 50, 1.0);
}
