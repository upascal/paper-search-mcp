/** A benchmark query with ground-truth relevant papers. */
export interface BenchmarkQuery {
  query_id: string;
  query_text: string;
  /** "broad" = multiple relevant papers (eval at recall@20), "specific" = one target (eval at recall@5) */
  query_type: "broad" | "specific";
  /** Ground-truth paper identifiers (format depends on benchmark) */
  ground_truth_ids: string[];
  /** Optional metadata from the benchmark */
  meta?: Record<string, unknown>;
}

/** Result of running a single query through the MCP pipeline. */
export interface BenchmarkResult {
  query_id: string;
  /** Ranked list of paper identifiers mapped to ground-truth ID space */
  result_ids: string[];
  /** Number of results returned before ID mapping (some may not map) */
  raw_result_count: number;
  /** Milliseconds taken for the search */
  latency_ms: number;
  /** Which platforms returned results */
  platforms_responded: string[];
  /** Optional: per-platform result counts */
  platform_counts?: Record<string, number>;
  /** Optional: full fused candidate pool with ranking signals, for offline re-ranking */
  candidates?: BenchCandidate[];
}

export interface BenchCandidate {
  /** Mapped ground-truth corpus id, or null if unmapped */
  cid: string | null;
  /** RRF fusion score */
  rrf: number;
  /** Quality score 0-100 (null when quality enrichment was off) */
  q: number | null;
  /** Citation count */
  c: number;
  /** Publication date (ISO, possibly empty) */
  d: string;
}

/** Aggregate metrics from an evaluation run. */
export interface EvalMetrics {
  total_queries: number;
  recall_at_5: number;
  recall_at_20: number;
  mrr: number;
  /** Metrics broken down by query type */
  by_type: Record<string, {
    count: number;
    recall_at_5: number;
    recall_at_20: number;
    mrr: number;
  }>;
  /** Which platforms contributed ground-truth hits */
  platform_contributions?: Record<string, number>;
}
