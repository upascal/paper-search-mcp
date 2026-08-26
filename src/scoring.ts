/**
 * Blended ranking for search results — the "ranking dials".
 *
 * RRF fusion measures query match; discovery-signals measures quality.
 * This module blends them (plus recency and raw citations) under
 * user-tunable weights:
 *
 *   final = w_r * normalize(rrf) + w_q * quality/100
 *         + w_f * freshness(date) + w_c * citationNorm(citations)
 *
 * Weights are 0–10 dials, normalized to sum to 1 before applying.
 */

import { batchGetVenueQuality } from "./platforms/openalex.js";
import { enrichWithQualityScore } from "./discovery-signals.js";
import type { Paper } from "./platforms/types.js";

export interface RankingWeights {
  relevance: number;
  quality: number;
  recency: number;
  citations: number;
}

export type RankingPreset = "relevance" | "balanced" | "discovery" | "impact";

export const RANKING_PRESETS: Record<RankingPreset, RankingWeights> = {
  // Standard search — mostly query match, slight quality boost
  relevance: { relevance: 7, quality: 3, recency: 0, citations: 0 },
  // Even mix of all signals
  balanced: { relevance: 4, quality: 3, recency: 1.5, citations: 1.5 },
  // Finding fresh/noteworthy work
  discovery: { relevance: 3, quality: 3, recency: 4, citations: 0 },
  // Established, highly-cited papers
  impact: { relevance: 2, quality: 3, recency: 0, citations: 5 },
};

/** Freshness window: 1.0 today, linear decay to 0 at ~2 years (MATURITY_DAYS). */
const FRESHNESS_WINDOW_DAYS = 730;

/** Individual weight params override the preset when specified. */
export function resolveWeights(
  preset: RankingPreset | undefined,
  overrides: Partial<RankingWeights> = {}
): { weights: RankingWeights; preset: RankingPreset } {
  const base = RANKING_PRESETS[preset ?? "relevance"];
  return {
    preset: preset ?? "relevance",
    weights: {
      relevance: overrides.relevance ?? base.relevance,
      quality: overrides.quality ?? base.quality,
      recency: overrides.recency ?? base.recency,
      citations: overrides.citations ?? base.citations,
    },
  };
}

/** Normalize weights to sum to 1.0. All-zero input → equal weights. */
export function normalizeWeights(w: RankingWeights): RankingWeights {
  const sum = w.relevance + w.quality + w.recency + w.citations;
  if (sum <= 0) {
    return { relevance: 0.25, quality: 0.25, recency: 0.25, citations: 0.25 };
  }
  return {
    relevance: w.relevance / sum,
    quality: w.quality / sum,
    recency: w.recency / sum,
    citations: w.citations / sum,
  };
}

/** 1.0 for a paper published today, decaying linearly to 0 over ~2 years. */
export function freshness(dateStr: string | undefined): number {
  if (!dateStr) return 0;
  const t = new Date(dateStr).getTime();
  if (isNaN(t)) return 0;
  const days = Math.max(0, (Date.now() - t) / (1000 * 60 * 60 * 24));
  return Math.max(0, 1 - days / FRESHNESS_WINDOW_DAYS);
}

/** Log-scaled citation count: 0 citations → 0, 1000+ citations → 1.0. */
export function citationNorm(citations: number): number {
  if (!citations || citations <= 0) return 0;
  return Math.min(Math.log(citations + 1) / Math.log(1001), 1.0);
}

export interface RankingScores {
  final: number;
  relevance: number;
  quality: number;
  recency: number;
  citations: number;
}

/**
 * Compute the blended score for one paper. Expects rrf_score (and, when
 * quality weighting is active, quality_score) already attached to extra.
 */
export function computeBlendedScore(
  paper: Paper,
  maxRrfScore: number,
  normalized: RankingWeights
): RankingScores {
  const rrf = (paper.extra?.rrf_score as number) ?? 0;
  const relevance = maxRrfScore > 0 ? rrf / maxRrfScore : 0;
  const quality = ((paper.extra?.quality_score as number) ?? 0) / 100;
  const recency = freshness(paper.published_date);
  const citations = citationNorm(paper.citations);

  const final =
    normalized.relevance * relevance +
    normalized.quality * quality +
    normalized.recency * recency +
    normalized.citations * citations;

  return {
    final: Math.round(final * 1000) / 1000,
    relevance: Math.round(relevance * 1000) / 1000,
    quality: Math.round(quality * 1000) / 1000,
    recency: Math.round(recency * 1000) / 1000,
    citations: Math.round(citations * 1000) / 1000,
  };
}

/**
 * Full ranking pipeline for fused results: enrich with quality scores when
 * quality weighting is active (venue batch lookup + age-adaptive signals),
 * compute blended scores, attach extra.ranking_scores, sort descending.
 *
 * Shared by search_papers, discover_recent_papers, and the bench runner so
 * offline evaluation measures exactly what production ranks.
 */
export async function applyBlendedRanking(
  papers: Paper[],
  weights: RankingWeights,
  env: Env
): Promise<Paper[]> {
  const normalized = normalizeWeights(weights);

  let enriched = papers;
  if (normalized.quality > 0) {
    const sourceIds = papers
      .map((p) => p.extra?.openalex_source_id as string)
      .filter(Boolean);
    const venueData =
      sourceIds.length > 0
        ? await batchGetVenueQuality(sourceIds, env)
        : undefined;
    enriched = enrichWithQualityScore(papers, venueData);
  }

  const maxRrf = Math.max(
    0,
    ...enriched.map((p) => (p.extra?.rrf_score as number) ?? 0)
  );

  return enriched
    .map((p) => ({
      ...p,
      extra: {
        ...p.extra,
        ranking_scores: computeBlendedScore(p, maxRrf, normalized),
      },
    }))
    .sort(
      (a, b) =>
        ((b.extra?.ranking_scores as RankingScores)?.final ?? 0) -
        ((a.extra?.ranking_scores as RankingScores)?.final ?? 0)
    );
}
