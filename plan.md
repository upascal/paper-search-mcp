# Plan: Weighted ranking dials for search_papers

## Problem
`search_papers` does RRF fusion but throws away quality signals. `discover_recent_papers` scores quality but sorts purely by it. Neither lets the user tune the blend.

## Design: 4 dials + 3 presets

### Ranking dimensions (0–10 integer dials, normalized internally)
| Dial | Signal source | Default |
|------|--------------|---------|
| `relevance_weight` | RRF score (query match across platforms) | 7 |
| `quality_weight` | Quality score from discovery-signals (venue, FWCI, metadata, age-adaptive) | 3 |
| `recency_weight` | Days since publication → 0–1 (newer = higher) | 0 |
| `citation_weight` | Raw citation count → 0–1 (log-scaled) | 0 |

### Presets (replace `sort_by`)
| Preset | relevance | quality | recency | citations | Use case |
|--------|-----------|---------|---------|-----------|----------|
| `"relevance"` (default) | 7 | 3 | 0 | 0 | Standard search — mostly query match, slight quality boost |
| `"balanced"` | 4 | 3 | 1.5 | 1.5 | Even mix of all signals |
| `"discovery"` | 3 | 3 | 4 | 0 | Finding fresh/noteworthy work |
| `"impact"` | 2 | 3 | 0 | 5 | Established, highly-cited papers |

Users can pass a `ranking_preset` and/or individual `*_weight` params. Individual weights override the preset when specified.

### Scoring formula
```
final_score = w_r * normalize(rrf_score) + w_q * (quality_score / 100) + w_f * freshness(date) + w_c * citation_norm(citations)
```

Where:
- `normalize(rrf_score)` = rrf_score / max_rrf_score (so top RRF result = 1.0)
- `quality_score / 100` = already 0–100, just scale to 0–1
- `freshness(date)` = 1.0 for today, decays to 0 over ~2 years (matching MATURITY_DAYS)
- `citation_norm(citations)` = log(citations + 1) / log(1001) capped at 1.0

Weights are normalized to sum to 1.0 before applying.

## Changes

### 1. `src/scoring.ts` (new)
- `computeBlendedScore(paper, maxRrfScore, weights)` → number
- `normalizeWeights(weights)` → normalized weights summing to 1
- `RANKING_PRESETS` constant
- `freshness(date)` and `citationNorm(citations)` helper functions
- Types: `RankingWeights`, `RankingPreset`

### 2. `src/index.ts` — search_papers tool
- Remove `sort_by` param
- Add `ranking_preset` param (enum: relevance/balanced/discovery/impact, default "relevance")
- Add 4 optional `*_weight` params (0–10 numbers)
- After RRF fusion, compute quality scores (same venue batch fetch as discover_recent_papers)
- Compute blended scores and sort by them
- Attach `ranking_scores: { final, relevance, quality, recency, citations }` to each paper's extra
- Include `ranking: { preset, weights_used }` in output metadata

### 3. `src/index.ts` — discover_recent_papers tool
- Add same ranking params (but with `ranking_preset` defaulting to `"discovery"`)
- Use same blended scoring instead of pure quality sort
- This makes both tools consistent

### 4. Tests
- Unit tests for scoring functions in `src/scoring.ts`
- Verify preset weight resolution + individual overrides
- Verify normalization edge cases (all zeros → equal weights)
