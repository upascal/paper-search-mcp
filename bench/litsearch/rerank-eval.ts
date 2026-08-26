/**
 * Offline re-ranking evaluator.
 *
 * Reads a results JSONL that includes per-query `candidates` (captured by
 * run.ts with --preset) and evaluates alternative ranking strategies on the
 * IDENTICAL retrieval pools — no API calls, no platform-health confounds.
 *
 * Usage:
 *   npx tsx bench/litsearch/rerank-eval.ts results/run-YYYY-MM-DD-default-relevance.jsonl
 */

import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type { BenchmarkResult, BenchCandidate } from "../shared/types.js";
import type { LitSearchQuery } from "./download.js";

const __dir = dirname(fileURLToPath(import.meta.url));

// Mirrors scoring.ts
function freshness(dateStr: string): number {
  if (!dateStr) return 0;
  const t = new Date(dateStr).getTime();
  if (isNaN(t)) return 0;
  const days = Math.max(0, (Date.now() - t) / 86_400_000);
  return Math.max(0, 1 - days / 730);
}
function citationNorm(c: number): number {
  if (!c || c <= 0) return 0;
  return Math.min(Math.log(c + 1) / Math.log(1001), 1.0);
}

type Norm = "max" | "minmax" | "rank";
interface Weights { r: number; q: number; f: number; c: number }

function rank(cands: BenchCandidate[], w: Weights, norm: Norm): BenchCandidate[] {
  const sum = w.r + w.q + w.f + w.c || 1;
  const [wr, wq, wf, wc] = [w.r / sum, w.q / sum, w.f / sum, w.c / sum];

  const max = Math.max(0, ...cands.map((x) => x.rrf));
  const min = Math.min(...cands.map((x) => x.rrf), max);
  const byRrf = [...cands].sort((a, b) => b.rrf - a.rrf);
  const rankOf = new Map(byRrf.map((x, i) => [x, i]));

  const rel = (x: BenchCandidate): number => {
    if (norm === "max") return max > 0 ? x.rrf / max : 0;
    if (norm === "minmax") return max > min ? (x.rrf - min) / (max - min) : 1;
    return 1 / (1 + (rankOf.get(x) ?? 0)); // "rank": 1, 1/2, 1/3, ...
  };

  return [...cands].sort((a, b) => {
    const sa = wr * rel(a) + wq * ((a.q ?? 0) / 100) + wf * freshness(a.d) + wc * citationNorm(a.c);
    const sb = wr * rel(b) + wq * ((b.q ?? 0) / 100) + wf * freshness(b.d) + wc * citationNorm(b.c);
    return sb - sa;
  });
}

function evaluate(
  results: BenchmarkResult[],
  queries: Map<string, LitSearchQuery>,
  order: (c: BenchCandidate[]) => BenchCandidate[]
): { r5: number; r20: number; mrr: number } {
  let r5 = 0, r20 = 0, mrr = 0, n = 0;
  for (const res of results) {
    const q = queries.get(res.query_id);
    if (!q || !res.candidates) continue;
    n++;
    const gt = new Set(q.corpus_ids.map(String));
    const ids = order(res.candidates).map((c) => c.cid).filter(Boolean) as string[];
    const top5 = new Set(ids.slice(0, 5));
    const top20 = new Set(ids.slice(0, 20));
    r5 += q.corpus_ids.filter((id) => top5.has(String(id))).length / q.corpus_ids.length;
    r20 += q.corpus_ids.filter((id) => top20.has(String(id))).length / q.corpus_ids.length;
    const first = ids.findIndex((id) => gt.has(id));
    if (first >= 0 && first < 20) mrr += 1 / (first + 1);
  }
  return { r5: r5 / n, r20: r20 / n, mrr: mrr / n };
}

const resultsPath = process.argv[2];
if (!resultsPath) {
  console.error("Usage: rerank-eval.ts <results.jsonl>");
  process.exit(1);
}

const results: BenchmarkResult[] = readFileSync(resolve(resultsPath), "utf-8")
  .trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));
const queryList: LitSearchQuery[] = JSON.parse(
  readFileSync(resolve(__dir, ".cache/queries.json"), "utf-8")
);
const queries = new Map(queryList.map((q) => [q.query_id, q]));

const withCands = results.filter((r) => r.candidates?.length).length;
console.log(`${results.length} queries, ${withCands} with candidate pools\n`);

const strategies: [string, (c: BenchCandidate[]) => BenchCandidate[]][] = [
  ["raw RRF (pre-dials baseline)", (c) => rank(c, { r: 1, q: 0, f: 0, c: 0 }, "max")],
  ["relevance 7/3, max-norm (shipped formula)", (c) => rank(c, { r: 7, q: 3, f: 0, c: 0 }, "max")],
  ["relevance 7/3, minmax-norm", (c) => rank(c, { r: 7, q: 3, f: 0, c: 0 }, "minmax")],
  ["relevance 7/3, rank-norm", (c) => rank(c, { r: 7, q: 3, f: 0, c: 0 }, "rank")],
  ["relevance 9/1, minmax-norm", (c) => rank(c, { r: 9, q: 1, f: 0, c: 0 }, "minmax")],
  ["relevance 9/1, rank-norm", (c) => rank(c, { r: 9, q: 1, f: 0, c: 0 }, "rank")],
  ["balanced 4/3/1.5/1.5, minmax", (c) => rank(c, { r: 4, q: 3, f: 1.5, c: 1.5 }, "minmax")],
  ["impact 2/3/0/5, minmax", (c) => rank(c, { r: 2, q: 3, f: 0, c: 5 }, "minmax")],
];

console.log("strategy".padEnd(45), "R@5".padStart(7), "R@20".padStart(7), "MRR".padStart(7));
for (const [name, fn] of strategies) {
  const m = evaluate(results, queries, fn);
  console.log(
    name.padEnd(45),
    (m.r5 * 100).toFixed(1).padStart(6) + "%",
    (m.r20 * 100).toFixed(1).padStart(6) + "%",
    (m.mrr * 100).toFixed(1).padStart(6) + "%"
  );
}
