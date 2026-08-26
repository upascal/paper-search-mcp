/**
 * Evaluate benchmark results against LitSearch ground truth.
 *
 * Computes recall@5, recall@20, and MRR.
 *
 * Usage:
 *   npx tsx bench/litsearch/evaluate.ts bench/litsearch/results/run-2026-03-13.jsonl
 *   npx tsx bench/litsearch/evaluate.ts  (auto-finds latest results file)
 */

import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type { BenchmarkResult, EvalMetrics } from "../shared/types.js";
import { printMetrics } from "../shared/reporter.js";
import type { LitSearchQuery } from "./download.js";

const __dir = dirname(fileURLToPath(import.meta.url));
const CACHE_DIR = resolve(__dir, ".cache");
const RESULTS_DIR = resolve(__dir, "results");

function loadQueries(): Map<string, LitSearchQuery> {
  const raw = readFileSync(resolve(CACHE_DIR, "queries.json"), "utf-8");
  const queries: LitSearchQuery[] = JSON.parse(raw);
  return new Map(queries.map((q) => [q.query_id, q]));
}

function loadResults(filePath: string): BenchmarkResult[] {
  const content = readFileSync(filePath, "utf-8");
  return content
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
}

function recallAtK(resultIds: string[], groundTruthIds: string[], k: number): number {
  const topK = new Set(resultIds.slice(0, k));
  const hits = groundTruthIds.filter((id) => topK.has(id)).length;
  return hits / groundTruthIds.length;
}

function reciprocalRank(resultIds: string[], groundTruthIds: string[]): number {
  const gtSet = new Set(groundTruthIds);
  for (let i = 0; i < resultIds.length; i++) {
    if (gtSet.has(resultIds[i])) return 1 / (i + 1);
  }
  return 0;
}

function queryType(query: LitSearchQuery): "broad" | "specific" {
  // Broad = multiple ground-truth papers, Specific = single target
  return query.corpus_ids.length > 1 ? "broad" : "specific";
}

export function evaluate(
  results: BenchmarkResult[],
  queries: Map<string, LitSearchQuery>
): EvalMetrics {
  let totalR5 = 0;
  let totalR20 = 0;
  let totalMRR = 0;
  let count = 0;

  const byType: Record<string, { r5: number; r20: number; mrr: number; n: number }> = {};

  for (const result of results) {
    const query = queries.get(result.query_id);
    if (!query) continue;

    const gt = query.corpus_ids.map(String);
    const r5 = recallAtK(result.result_ids, gt, 5);
    const r20 = recallAtK(result.result_ids, gt, 20);
    const mrr = reciprocalRank(result.result_ids, gt);

    totalR5 += r5;
    totalR20 += r20;
    totalMRR += mrr;
    count++;

    const type = queryType(query);
    if (!byType[type]) byType[type] = { r5: 0, r20: 0, mrr: 0, n: 0 };
    byType[type].r5 += r5;
    byType[type].r20 += r20;
    byType[type].mrr += mrr;
    byType[type].n++;
  }

  return {
    total_queries: count,
    recall_at_5: count > 0 ? totalR5 / count : 0,
    recall_at_20: count > 0 ? totalR20 / count : 0,
    mrr: count > 0 ? totalMRR / count : 0,
    by_type: Object.fromEntries(
      Object.entries(byType).map(([type, m]) => [
        type,
        {
          count: m.n,
          recall_at_5: m.n > 0 ? m.r5 / m.n : 0,
          recall_at_20: m.n > 0 ? m.r20 / m.n : 0,
          mrr: m.n > 0 ? m.mrr / m.n : 0,
        },
      ])
    ),
  };
}

// CLI entry point
function main() {
  const queries = loadQueries();

  // Find results file
  let resultsPath = process.argv[2];
  if (!resultsPath) {
    // Auto-find latest results file
    const files = readdirSync(RESULTS_DIR)
      .filter((f) => f.endsWith(".jsonl"))
      .sort()
      .reverse();
    if (files.length === 0) {
      console.error("No results files found in", RESULTS_DIR);
      console.error("Run the benchmark first: npx tsx bench/litsearch/run.ts");
      process.exit(1);
    }
    resultsPath = resolve(RESULTS_DIR, files[0]);
    console.log(`Using latest results: ${files[0]}`);
  }

  const results = loadResults(resultsPath);
  const metrics = evaluate(results, queries);
  printMetrics(metrics, `LitSearch Open-Corpus — ${resultsPath.split("/").pop()}`);

  // Also save metrics as JSON
  const metricsPath = resultsPath.replace(/\.jsonl$/, ".metrics.json");
  writeFileSync(metricsPath, JSON.stringify(metrics, null, 2));
  console.log(`\nMetrics saved to ${metricsPath}`);
}

main();
