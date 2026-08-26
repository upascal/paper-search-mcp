import type { EvalMetrics } from "./types.js";

/** Print evaluation metrics as a formatted console table. */
export function printMetrics(metrics: EvalMetrics, runLabel?: string) {
  console.log("\n" + "=".repeat(60));
  if (runLabel) console.log(`  ${runLabel}`);
  console.log("=".repeat(60));

  console.log(`\n  Overall (${metrics.total_queries} queries)`);
  console.log(`  ${"─".repeat(40)}`);
  console.log(`  Recall@5:   ${(metrics.recall_at_5 * 100).toFixed(1)}%`);
  console.log(`  Recall@20:  ${(metrics.recall_at_20 * 100).toFixed(1)}%`);
  console.log(`  MRR:        ${(metrics.mrr * 100).toFixed(1)}%`);

  console.log(`\n  By query type`);
  console.log(`  ${"─".repeat(40)}`);
  for (const [type, m] of Object.entries(metrics.by_type)) {
    console.log(`  ${type} (n=${m.count})`);
    console.log(`    Recall@5:   ${(m.recall_at_5 * 100).toFixed(1)}%`);
    console.log(`    Recall@20:  ${(m.recall_at_20 * 100).toFixed(1)}%`);
    console.log(`    MRR:        ${(m.mrr * 100).toFixed(1)}%`);
  }

  if (metrics.platform_contributions) {
    console.log(`\n  Platform contributions (ground-truth hits)`);
    console.log(`  ${"─".repeat(40)}`);
    const entries = Object.entries(metrics.platform_contributions).sort(
      (a, b) => b[1] - a[1]
    );
    for (const [platform, count] of entries) {
      console.log(`  ${platform.padEnd(20)} ${count}`);
    }
  }

  console.log("\n" + "=".repeat(60));
}
