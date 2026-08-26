/**
 * Maps between MCP result IDs (DOI, S2 paper ID) and LitSearch corpus IDs.
 *
 * LitSearch ground truth uses Semantic Scholar corpus IDs.
 * The MCP returns DOIs and S2 paper IDs. This module bridges the gap.
 */

import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type { Paper } from "../../src/platforms/types.js";
import type { IdMapping } from "./download.js";

const __dir = dirname(fileURLToPath(import.meta.url));
const CACHE_DIR = resolve(__dir, ".cache");

export class IdMapper {
  private byCorpusId = new Map<number, IdMapping>();
  private byDoi = new Map<string, IdMapping>();
  private byS2Id = new Map<string, IdMapping>();
  private byTitle = new Map<string, IdMapping>();

  constructor() {
    const raw = readFileSync(resolve(CACHE_DIR, "id-map.json"), "utf-8");
    const mappings: IdMapping[] = JSON.parse(raw);

    for (const m of mappings) {
      this.byCorpusId.set(m.corpus_id, m);
      if (m.doi) this.byDoi.set(m.doi.toLowerCase(), m);
      if (m.s2_paper_id) this.byS2Id.set(m.s2_paper_id, m);
      if (m.title) this.byTitle.set(this.normalizeTitle(m.title), m);
    }
  }

  /**
   * Given an MCP Paper result, try to find the matching LitSearch corpus ID.
   * Returns the corpus ID if found, null otherwise.
   */
  paperToCorpusId(paper: Paper): number | null {
    // 1. DOI match (most reliable)
    if (paper.doi) {
      const m = this.byDoi.get(paper.doi.toLowerCase());
      if (m) return m.corpus_id;
    }

    // 2. S2 paper ID match (for Semantic Scholar results)
    if (paper.source === "semantic_scholar" && paper.paper_id) {
      const m = this.byS2Id.get(paper.paper_id);
      if (m) return m.corpus_id;
    }

    // 3. Normalized title match (fuzzy fallback)
    if (paper.title) {
      const m = this.byTitle.get(this.normalizeTitle(paper.title));
      if (m) return m.corpus_id;
    }

    return null;
  }

  /**
   * Map a ranked list of MCP papers to corpus IDs.
   * Returns corpus IDs in rank order, skipping unmapped papers.
   */
  mapResults(papers: Paper[]): number[] {
    const seen = new Set<number>();
    const mapped: number[] = [];

    for (const paper of papers) {
      const corpusId = this.paperToCorpusId(paper);
      if (corpusId !== null && !seen.has(corpusId)) {
        seen.add(corpusId);
        mapped.push(corpusId);
      }
    }

    return mapped;
  }

  /** Get the DOI for a ground-truth corpus ID. */
  getDoiForCorpusId(corpusId: number): string | undefined {
    return this.byCorpusId.get(corpusId)?.doi;
  }

  /** Get mapping stats. */
  get stats() {
    return {
      total: this.byCorpusId.size,
      withDoi: this.byDoi.size,
      withS2Id: this.byS2Id.size,
      withTitle: this.byTitle.size,
    };
  }

  private normalizeTitle(title: string): string {
    return title
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, "")
      .replace(/\s+/g, " ")
      .trim();
  }
}
