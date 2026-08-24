/**
 * Download and cache the LitSearch benchmark dataset.
 *
 * 1. Fetches 597 queries from HuggingFace datasets API
 * 2. Collects unique ground-truth corpus IDs
 * 3. Batch-lookups DOIs + S2 paper IDs via Semantic Scholar API
 * 4. Caches everything as JSON in .cache/
 *
 * Usage: npx tsx bench/litsearch/download.ts
 */

import { mkdirSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { benchEnv } from "../shared/env.js";

const __dir = dirname(fileURLToPath(import.meta.url));
const CACHE_DIR = resolve(__dir, ".cache");
const QUERIES_FILE = resolve(CACHE_DIR, "queries.json");
const ID_MAP_FILE = resolve(CACHE_DIR, "id-map.json");

const HF_ROWS_URL =
  "https://datasets-server.huggingface.co/rows?dataset=princeton-nlp/LitSearch&config=query&split=full";
const S2_BATCH_URL = "https://api.semanticscholar.org/graph/v1/paper/batch";
const S2_FIELDS = "externalIds,title";

interface HFRow {
  query_set: string;
  query: string;
  specificity: number;
  quality: number;
  corpusids: number[];
}

export interface LitSearchQuery {
  query_id: string;
  query_text: string;
  query_set: string;
  specificity: number;
  quality: number;
  corpus_ids: number[];
}

/** DOI and S2 paper ID for a ground-truth corpus ID. */
export interface IdMapping {
  corpus_id: number;
  s2_paper_id: string;
  doi: string;
  arxiv_id: string;
  title: string;
}

async function fetchAllQueries(): Promise<LitSearchQuery[]> {
  const queries: LitSearchQuery[] = [];
  let offset = 0;
  const pageSize = 100;

  console.log("Fetching queries from HuggingFace...");

  while (true) {
    const url = `${HF_ROWS_URL}&offset=${offset}&length=${pageSize}`;
    const resp = await fetch(url);
    if (!resp.ok) throw new Error(`HuggingFace API error: ${resp.status} ${resp.statusText}`);

    const data = await resp.json() as { rows: { row_idx: number; row: HFRow }[]; num_rows_total: number };

    for (const { row_idx, row } of data.rows) {
      queries.push({
        query_id: `litsearch_${row_idx}`,
        query_text: row.query,
        query_set: row.query_set,
        specificity: row.specificity,
        quality: row.quality,
        corpus_ids: row.corpusids,
      });
    }

    console.log(`  fetched ${queries.length} / ${data.num_rows_total} queries`);

    if (queries.length >= data.num_rows_total || data.rows.length < pageSize) break;
    offset += pageSize;
  }

  return queries;
}

async function batchLookupS2(corpusIds: number[]): Promise<IdMapping[]> {
  const mappings: IdMapping[] = [];
  const batchSize = 500;
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (benchEnv.SEMANTIC_SCHOLAR_API_KEY) {
    headers["x-api-key"] = benchEnv.SEMANTIC_SCHOLAR_API_KEY;
  }

  console.log(`\nLooking up ${corpusIds.length} ground-truth papers via Semantic Scholar...`);

  for (let i = 0; i < corpusIds.length; i += batchSize) {
    const batch = corpusIds.slice(i, i + batchSize);
    const ids = batch.map((id) => `CorpusId:${id}`);

    const resp = await fetch(`${S2_BATCH_URL}?fields=${S2_FIELDS}`, {
      method: "POST",
      headers,
      body: JSON.stringify({ ids }),
    });

    if (resp.status === 429) {
      const retryAfter = parseInt(resp.headers.get("Retry-After") ?? "30", 10);
      console.log(`  rate limited, waiting ${retryAfter}s...`);
      await new Promise((r) => setTimeout(r, retryAfter * 1000));
      // Retry this batch
      i -= batchSize;
      continue;
    }

    if (!resp.ok) throw new Error(`S2 batch API error: ${resp.status} ${resp.statusText}`);

    const results = (await resp.json()) as (null | {
      paperId: string;
      externalIds: Record<string, string>;
      title: string;
    })[];

    for (let j = 0; j < results.length; j++) {
      const paper = results[j];
      const corpusId = batch[j];
      if (paper) {
        mappings.push({
          corpus_id: corpusId,
          s2_paper_id: paper.paperId,
          doi: paper.externalIds?.DOI ?? "",
          arxiv_id: paper.externalIds?.ArXiv ?? "",
          title: paper.title ?? "",
        });
      } else {
        // Paper not found in S2 — record it with empty IDs
        mappings.push({
          corpus_id: corpusId,
          s2_paper_id: "",
          doi: "",
          arxiv_id: "",
          title: "",
        });
      }
    }

    console.log(`  mapped ${mappings.length} / ${corpusIds.length} papers`);

    // Small delay between batches to be polite
    if (i + batchSize < corpusIds.length) {
      await new Promise((r) => setTimeout(r, 1000));
    }
  }

  return mappings;
}

async function main() {
  mkdirSync(CACHE_DIR, { recursive: true });

  // Step 1: Download queries (or use cache)
  let queries: LitSearchQuery[];
  if (existsSync(QUERIES_FILE)) {
    console.log("Using cached queries from", QUERIES_FILE);
    queries = JSON.parse(readFileSync(QUERIES_FILE, "utf-8"));
  } else {
    queries = await fetchAllQueries();
    writeFileSync(QUERIES_FILE, JSON.stringify(queries, null, 2));
    console.log(`Cached ${queries.length} queries to ${QUERIES_FILE}`);
  }

  // Step 2: Collect unique corpus IDs
  const allCorpusIds = new Set<number>();
  for (const q of queries) {
    for (const id of q.corpus_ids) allCorpusIds.add(id);
  }
  console.log(`\n${allCorpusIds.size} unique ground-truth papers across ${queries.length} queries`);

  // Step 3: Look up DOIs via S2 (or use cache)
  let idMap: IdMapping[];
  if (existsSync(ID_MAP_FILE)) {
    console.log("Using cached ID map from", ID_MAP_FILE);
    idMap = JSON.parse(readFileSync(ID_MAP_FILE, "utf-8"));
    const cached = new Set(idMap.map((m) => m.corpus_id));
    const missing = [...allCorpusIds].filter((id) => !cached.has(id));
    if (missing.length > 0) {
      console.log(`${missing.length} new corpus IDs to look up...`);
      const newMappings = await batchLookupS2(missing);
      idMap.push(...newMappings);
      writeFileSync(ID_MAP_FILE, JSON.stringify(idMap, null, 2));
    }
  } else {
    idMap = await batchLookupS2([...allCorpusIds]);
    writeFileSync(ID_MAP_FILE, JSON.stringify(idMap, null, 2));
    console.log(`Cached ${idMap.length} ID mappings to ${ID_MAP_FILE}`);
  }

  // Summary
  const withDoi = idMap.filter((m) => m.doi).length;
  const withS2 = idMap.filter((m) => m.s2_paper_id).length;
  const notFound = idMap.filter((m) => !m.s2_paper_id).length;
  console.log(`\nID mapping summary:`);
  console.log(`  ${withS2} papers found in Semantic Scholar`);
  console.log(`  ${withDoi} papers have DOIs`);
  console.log(`  ${notFound} papers not found`);
  console.log(`\nDone! Ready to run benchmarks.`);
}

main().catch((err) => {
  console.error("Download failed:", err);
  process.exit(1);
});
