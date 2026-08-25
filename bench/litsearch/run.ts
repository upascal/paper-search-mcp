/**
 * LitSearch open-corpus benchmark runner.
 *
 * Runs each query through the MCP's platform modules + RRF fusion,
 * maps results to LitSearch corpus IDs, and writes JSONL output.
 *
 * Usage:
 *   npx tsx bench/litsearch/run.ts                   # full run (597 queries)
 *   npx tsx bench/litsearch/run.ts --limit 50        # first 50 queries
 *   npx tsx bench/litsearch/run.ts --platforms semantic_scholar,openalex
 *   npx tsx bench/litsearch/run.ts --semantic         # also run OpenAlex semantic search
 *   npx tsx bench/litsearch/run.ts --delay 1000       # ms between queries (default 500)
 *   npx tsx bench/litsearch/run.ts --per-platform 20  # results per platform (default 15)
 */

import { readFileSync, appendFileSync, existsSync, mkdirSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { benchEnv } from "../shared/env.js";
import { getEnabledPlatforms } from "../../src/registry.js";
import { reciprocalRankFusion } from "../../src/rrf.js";
import { resolveWeights, applyBlendedRanking } from "../../src/scoring.js";
import type { RankingPreset } from "../../src/scoring.js";
import { IdMapper } from "./id-mapper.js";
import type { LitSearchQuery } from "./download.js";
import type { BenchmarkResult } from "../shared/types.js";
import type { PlatformSource, Paper } from "../../src/platforms/types.js";

const __dir = dirname(fileURLToPath(import.meta.url));
const CACHE_DIR = resolve(__dir, ".cache");
const RESULTS_DIR = resolve(__dir, "results");

// ---------------------------------------------------------------------------
// Per-platform rate limiter
// ---------------------------------------------------------------------------

/**
 * Simple token-bucket rate limiter that enforces minimum spacing between calls.
 * Each platform gets its own limiter so slow platforms don't block fast ones.
 */
class RateLimiter {
  private lastCall = 0;

  constructor(private minIntervalMs: number) {}

  async wait(): Promise<void> {
    const now = Date.now();
    const elapsed = now - this.lastCall;
    if (elapsed < this.minIntervalMs) {
      await new Promise((r) => setTimeout(r, this.minIntervalMs - elapsed));
    }
    this.lastCall = Date.now();
  }
}

// S2 unauthenticated: ~100 req / 5 min ≈ 1 req / 3s
// S2 authenticated: ~100 req / 1s — no throttle needed
// CrossRef polite pool: 50 req/s with mailto — generous
// OpenAlex polite pool: ~10 req/s with API key — generous
// arXiv API: ~1 req/3s but the adapter uses the bulk export search
const RATE_LIMITS: Record<string, { authenticated: number; unauthenticated: number }> = {
  semantic_scholar: { authenticated: 50, unauthenticated: 3500 },
  crossref: { authenticated: 100, unauthenticated: 500 },
  openalex: { authenticated: 200, unauthenticated: 500 },
  arxiv: { authenticated: 3500, unauthenticated: 3500 },
};

function buildRateLimiters(platforms: PlatformSource[], env: Env): Map<string, RateLimiter> {
  const limiters = new Map<string, RateLimiter>();
  for (const p of platforms) {
    const limits = RATE_LIMITS[p.name] ?? { authenticated: 200, unauthenticated: 500 };
    const hasKey =
      (p.name === "semantic_scholar" && !!env.SEMANTIC_SCHOLAR_API_KEY) ||
      (p.name === "openalex" && !!env.OPENALEX_API_KEY) ||
      (p.name === "crossref" && !!env.CONTACT_EMAIL) ||
      (p.name !== "semantic_scholar" && p.name !== "openalex" && p.name !== "crossref");
    const interval = hasKey ? limits.authenticated : limits.unauthenticated;
    limiters.set(p.name, new RateLimiter(interval));
  }
  return limiters;
}

// ---------------------------------------------------------------------------
// S2 warm-up probe — wait for rate limit window to clear
// ---------------------------------------------------------------------------

async function waitForS2(env: Env, maxWaitMs = 120_000): Promise<void> {
  const testUrl = "https://api.semanticscholar.org/graph/v1/paper/search?query=test&limit=1&fields=title";
  const h: Record<string, string> = {};
  if (env.SEMANTIC_SCHOLAR_API_KEY) h["x-api-key"] = env.SEMANTIC_SCHOLAR_API_KEY;

  const start = Date.now();
  let attempt = 0;

  while (Date.now() - start < maxWaitMs) {
    try {
      const resp = await fetch(testUrl, { headers: h });
      if (resp.status !== 429) {
        if (attempt > 0) console.log(`S2 available after ${Math.round((Date.now() - start) / 1000)}s`);
        return;
      }
    } catch {
      // network error, retry
    }

    attempt++;
    const waitSec = Math.min(10, 5 * attempt);
    console.log(`S2 rate-limited, waiting ${waitSec}s... (${Math.round((Date.now() - start) / 1000)}s elapsed)`);
    await new Promise((r) => setTimeout(r, waitSec * 1000));
  }

  console.warn("S2 still rate-limited after 2 min — proceeding without S2");
}

// ---------------------------------------------------------------------------
// CLI argument parsing
// ---------------------------------------------------------------------------

function parseArgs() {
  const args = process.argv.slice(2);
  const opts = {
    limit: Infinity,
    platforms: undefined as string | undefined,
    semantic: false,
    delay: 500,
    perPlatform: 15,
    maxResults: 50,
    // "none" = raw RRF ordering (pre-dials baseline); otherwise a scoring.ts preset
    preset: "none" as RankingPreset | "none",
  };

  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case "--limit":
        opts.limit = parseInt(args[++i], 10);
        break;
      case "--platforms":
        opts.platforms = args[++i];
        break;
      case "--semantic":
        opts.semantic = true;
        break;
      case "--delay":
        opts.delay = parseInt(args[++i], 10);
        break;
      case "--per-platform":
        opts.perPlatform = parseInt(args[++i], 10);
        break;
      case "--max-results":
        opts.maxResults = parseInt(args[++i], 10);
        break;
      case "--preset":
        opts.preset = args[++i] as RankingPreset | "none";
        break;
    }
  }

  return opts;
}

// ---------------------------------------------------------------------------
// Search a single query across all platforms + RRF
// ---------------------------------------------------------------------------

async function searchQuery(
  query: string,
  platforms: PlatformSource[],
  env: Env,
  limiters: Map<string, RateLimiter>,
  opts: { perPlatform: number; semantic: boolean; preset: RankingPreset | "none" }
): Promise<{ papers: Paper[]; platformCounts: Record<string, number> }> {
  // Split platforms into fast (can run in parallel) and slow (need serialized rate limiting).
  // S2 without API key is slow — its retry loop can last 30s+ and shouldn't overlap
  // with other S2 requests.
  const s2NoKey = !env.SEMANTIC_SCHOLAR_API_KEY;
  const fastPlatforms = platforms.filter((p) => !(s2NoKey && p.name === "semantic_scholar"));
  const slowPlatforms = platforms.filter((p) => s2NoKey && p.name === "semantic_scholar");

  // Fire fast platforms in parallel
  const searches: Promise<{ papers: Paper[]; source: string }>[] = [];

  for (const p of fastPlatforms) {
    const limiter = limiters.get(p.name);
    searches.push(
      (async () => {
        if (limiter) await limiter.wait();
        return p
          .search({ query, max_results: opts.perPlatform }, env)
          .then((r) => ({ papers: r.papers, source: p.name }));
      })().catch(() => ({ papers: [], source: p.name }))
    );
  }

  // Optional semantic search via OpenAlex
  if (opts.semantic) {
    const oa = fastPlatforms.find((p) => p.name === "openalex");
    if (oa) {
      const limiter = limiters.get("openalex");
      searches.push(
        (async () => {
          if (limiter) await limiter.wait();
          return oa
            .search({ query, max_results: opts.perPlatform, semantic: true } as any, env)
            .then((r) => ({ papers: r.papers, source: "openalex_semantic" }));
        })().catch(() => ({ papers: [], source: "openalex_semantic" }))
      );
    }
  }

  // Run slow platforms sequentially (so retries finish before next query starts)
  for (const p of slowPlatforms) {
    const limiter = limiters.get(p.name);
    searches.push(
      (async () => {
        // Wait for fast platforms to finish first, then run S2
        // so its retry loop doesn't compete with parallel requests
        if (limiter) await limiter.wait();
        return p
          .search({ query, max_results: opts.perPlatform }, env)
          .then((r) => ({ papers: r.papers, source: p.name }));
      })().catch(() => ({ papers: [], source: p.name }))
    );
  }

  const results = await Promise.allSettled(searches);

  const rankedLists: Paper[][] = [];
  const platformCounts: Record<string, number> = {};

  for (const r of results) {
    if (r.status === "fulfilled") {
      rankedLists.push(r.value.papers);
      platformCounts[r.value.source] = r.value.papers.length;
    }
  }

  const fused = reciprocalRankFusion(rankedLists);
  // Apply the production blended-ranking pipeline unless measuring raw RRF
  const papers =
    opts.preset === "none"
      ? fused
      : await applyBlendedRanking(
          fused,
          resolveWeights(opts.preset).weights,
          env
        );
  return { papers, platformCounts };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const opts = parseArgs();

  // Override enabled platforms if specified
  if (opts.platforms) {
    (benchEnv as any).ENABLED_PLATFORMS = opts.platforms;
  }

  const platforms = getEnabledPlatforms(benchEnv);
  const limiters = buildRateLimiters(platforms, benchEnv);

  // Log rate limit info
  const s2Limiter = RATE_LIMITS.semantic_scholar;
  const s2HasKey = !!benchEnv.SEMANTIC_SCHOLAR_API_KEY;
  const s2Interval = s2HasKey ? s2Limiter.authenticated : s2Limiter.unauthenticated;

  console.log(`Platforms: ${platforms.map((p) => p.name).join(", ")}`);
  console.log(`Semantic search: ${opts.semantic ? "on" : "off"}`);
  console.log(`Per-platform results: ${opts.perPlatform}`);
  console.log(`Delay between queries: ${opts.delay}ms`);
  if (platforms.some((p) => p.name === "semantic_scholar")) {
    console.log(
      `S2 rate limit: ${s2Interval}ms/req (${s2HasKey ? "authenticated" : "unauthenticated — get API key for 70x speedup"})`
    );
  }

  // Warm-up: verify S2 is reachable before burning through queries
  if (platforms.some((p) => p.name === "semantic_scholar")) {
    await waitForS2(benchEnv);
  }

  // Load data
  if (!existsSync(resolve(CACHE_DIR, "queries.json"))) {
    console.error("Dataset not downloaded. Run: npx tsx bench/litsearch/download.ts");
    process.exit(1);
  }
  if (!existsSync(resolve(CACHE_DIR, "id-map.json"))) {
    console.error("ID map not built. Run: npx tsx bench/litsearch/download.ts");
    process.exit(1);
  }

  const queries: LitSearchQuery[] = JSON.parse(
    readFileSync(resolve(CACHE_DIR, "queries.json"), "utf-8")
  );
  const mapper = new IdMapper();
  console.log(`ID mapper: ${mapper.stats.total} papers, ${mapper.stats.withDoi} with DOI\n`);

  // Determine which queries to run
  const toRun = queries.slice(0, opts.limit);

  // Output file
  mkdirSync(RESULTS_DIR, { recursive: true });
  const timestamp = new Date().toISOString().slice(0, 10);
  const platformTag = opts.platforms ?? "default";
  const presetTag = opts.preset === "none" ? "" : `-${opts.preset}`;
  const outFile = resolve(RESULTS_DIR, `run-${timestamp}-${platformTag}${presetTag}.jsonl`);

  // Resume support: load already-completed query IDs
  const completed = new Set<string>();
  if (existsSync(outFile)) {
    const lines = readFileSync(outFile, "utf-8").trim().split("\n").filter(Boolean);
    for (const line of lines) {
      const r: BenchmarkResult = JSON.parse(line);
      completed.add(r.query_id);
    }
    console.log(`Resuming: ${completed.size} queries already done in ${outFile}`);
  }

  let done = completed.size;
  const total = toRun.length;
  let errors = 0;

  for (const query of toRun) {
    if (completed.has(query.query_id)) continue;

    const start = Date.now();

    try {
      const { papers, platformCounts } = await searchQuery(
        query.query_text,
        platforms,
        benchEnv,
        limiters,
        { perPlatform: opts.perPlatform, semantic: opts.semantic, preset: opts.preset }
      );

      const mappedIds = mapper.mapResults(papers);
      const latency = Date.now() - start;

      const result: BenchmarkResult = {
        query_id: query.query_id,
        result_ids: mappedIds.map(String),
        raw_result_count: papers.length,
        latency_ms: latency,
        platforms_responded: Object.keys(platformCounts).filter(
          (k) => platformCounts[k] > 0
        ),
        platform_counts: platformCounts,
      };

      appendFileSync(outFile, JSON.stringify(result) + "\n");
      done++;

      // Progress
      const gt = new Set(query.corpus_ids.map(String));
      const hits = mappedIds.filter((id) => gt.has(String(id))).length;
      const r5 = mappedIds.slice(0, 5).filter((id) => gt.has(String(id))).length;
      console.log(
        `[${done}/${total}] ${query.query_id}: ` +
          `${papers.length} results, ${mappedIds.length} mapped, ` +
          `${hits}/${query.corpus_ids.length} hits, ` +
          `r@5=${r5} (${latency}ms)`
      );
    } catch (err: any) {
      errors++;
      console.error(`[${done}/${total}] ${query.query_id}: ERROR — ${err.message}`);
    }

    // Rate limit delay between queries
    if (done < total) {
      await new Promise((r) => setTimeout(r, opts.delay));
    }
  }

  console.log(`\nDone! ${done} queries, ${errors} errors`);
  console.log(`Results: ${outFile}`);
  console.log(`\nEvaluate: npx tsx bench/litsearch/evaluate.ts ${outFile}`);
}

main().catch((err) => {
  console.error("Benchmark failed:", err);
  process.exit(1);
});
