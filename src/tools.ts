/**
 * Paper Search MCP — Tool Registration
 *
 * Single source of truth for all 6 tools. Used by:
 *   - PaperSearchMCP (Cloudflare Worker / Durable Object)
 *   - bench/agentic/stdio-server.ts (stdio adapter for Agent SDK testing)
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { getEnabledPlatforms, getOptionalPlatformNames } from "./registry.js";
import { resolveSourceId, batchGetVenueQuality } from "./platforms/openalex.js";
import { getRecommendations, getCitations } from "./platforms/semantic-scholar.js";
import { reciprocalRankFusion } from "./rrf.js";
import { enrichWithQualityScore } from "./discovery-signals.js";
import type { PlatformSource, Paper, SearchResult } from "./platforms/types.js";
import type { RequestHandlerExtra } from "@modelcontextprotocol/sdk/shared/protocol.js";
import type { ServerRequest, ServerNotification } from "@modelcontextprotocol/sdk/types.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

type Extra = RequestHandlerExtra<ServerRequest, ServerNotification>;

async function sendStatus(extra: Extra, message: string): Promise<void> {
  try {
    // Race against a short timeout: status updates are best-effort, and a
    // dead/unwritable stream must never stall the tool call itself.
    await Promise.race([
      extra.sendNotification({
        method: "notifications/message",
        params: { level: "info", logger: "paper-search", data: message },
      }),
      new Promise<void>((resolve) => setTimeout(resolve, 2000)),
    ]);
  } catch {
    // Client may not support logging — fail silently
  }
}

interface SearchOptions {
  query: string;
  max_results: number;
  per_platform: number;
  semantic?: boolean;
  date_from?: string;
  date_to?: string;
  journal_issn?: string;
  journal_source?: string;
}

interface SearchOutput {
  rankedLists: Paper[][];
  platformResults: { platform: string; status: string; count?: number; error?: string }[];
  warnings: string[];
}

/**
 * Dispatch a single query to all enabled platforms and collect ranked lists.
 * Does NOT apply RRF or sorting — caller handles fusion across queries.
 */
async function dispatchSearch(
  opts: SearchOptions,
  allPlatforms: PlatformSource[],
  env: Env
): Promise<SearchOutput> {
  const searches: Promise<SearchResult>[] = [];
  const labels: string[] = [];

  for (const p of allPlatforms) {
    const searchParams: Record<string, unknown> = {
      query: opts.query,
      max_results: opts.per_platform,
    };

    // Date filtering
    if (opts.date_from || opts.date_to) {
      switch (p.name) {
        case "semantic_scholar": {
          const fromYear = opts.date_from?.slice(0, 4);
          const toYear = opts.date_to?.slice(0, 4);
          if (fromYear && toYear) searchParams.year = `${fromYear}-${toYear}`;
          else if (fromYear) searchParams.year = `${fromYear}-`;
          else if (toYear) searchParams.year = `-${toYear}`;
          break;
        }
        case "crossref":
        case "openalex":
          if (opts.date_from) searchParams.from_date = opts.date_from;
          if (opts.date_to) searchParams.to_date = opts.date_to;
          break;
      }
    }

    // Journal filtering
    if (opts.journal_issn && p.name === "crossref") {
      searchParams.journal_issn = opts.journal_issn;
    }
    if (opts.journal_source && p.name === "openalex") {
      searchParams.source = opts.journal_source;
    }

    if (p.name === "arxiv") {
      searchParams.sort_by = "relevance";
    }

    searches.push(p.search(searchParams as any, env));
    labels.push(p.name);
  }

  // Semantic search (additional OpenAlex signal)
  if (opts.semantic) {
    const oaPlatform = allPlatforms.find((p) => p.name === "openalex");
    if (oaPlatform) {
      const semanticParams: Record<string, unknown> = {
        query: opts.query,
        max_results: opts.per_platform,
        semantic: true,
      };
      if (opts.date_from) semanticParams.from_date = opts.date_from;
      if (opts.date_to) semanticParams.to_date = opts.date_to;
      if (opts.journal_source) semanticParams.source = opts.journal_source;
      searches.push(oaPlatform.search(semanticParams as any, env));
      labels.push("openalex_semantic");
    }
  }

  const results = await Promise.allSettled(searches);

  const rankedLists: Paper[][] = [];
  const platformResults: { platform: string; status: string; count?: number; error?: string }[] = [];
  const warnings: string[] = [];

  results.forEach((r, i) => {
    if (r.status === "fulfilled") {
      rankedLists.push(r.value.papers);
      platformResults.push({ platform: labels[i], status: "ok", count: r.value.papers.length });
      if (r.value.warnings) {
        for (const w of r.value.warnings) warnings.push(`${labels[i]}: ${w}`);
      }
    } else {
      platformResults.push({ platform: labels[i], status: "error", error: r.reason?.message ?? String(r.reason) });
      warnings.push(`${labels[i]} failed: ${r.reason?.message ?? String(r.reason)}`);
    }
  });

  return { rankedLists, platformResults, warnings };
}

function detectIdType(id: string): { targetPlatforms: string[]; transformedId: string } {
  if (id.startsWith("W") && /^W\d+$/.test(id))
    return { targetPlatforms: ["openalex"], transformedId: id };
  if (id.startsWith("ARXIV:"))
    return { targetPlatforms: ["semantic_scholar"], transformedId: id };
  if (id.startsWith("PMID:"))
    return { targetPlatforms: ["semantic_scholar"], transformedId: id };
  if (id.startsWith("DOI:"))
    return { targetPlatforms: ["openalex", "crossref", "semantic_scholar"], transformedId: id };
  if (id.includes("/")) // DOI
    return { targetPlatforms: ["openalex", "crossref", "semantic_scholar"], transformedId: id };
  if (/^[0-9a-f]{40}$/.test(id)) // S2 corpus ID
    return { targetPlatforms: ["semantic_scholar"], transformedId: id };
  if (/^\d{4}\.\d{4,5}(v\d+)?$/.test(id)) // arXiv-style
    return { targetPlatforms: ["semantic_scholar"], transformedId: `ARXIV:${id}` };
  return { targetPlatforms: ["openalex", "semantic_scholar"], transformedId: id };
}

async function resolveJournal(
  journal: string,
  env: Env
): Promise<{ issn: string | null; sourceId: string | null }> {
  const isIssn = /^\d{4}-\d{3}[\dXx]$/.test(journal);
  if (isIssn) {
    return { issn: journal, sourceId: null };
  }
  const resolved = await resolveSourceId(journal, env);
  if (resolved) {
    return { issn: resolved.issn_l, sourceId: resolved.id };
  }
  return { issn: null, sourceId: null };
}

async function dispatchMultiQuery(
  queries: string[],
  baseOpts: Omit<SearchOptions, "query">,
  platforms: PlatformSource[],
  env: Env
): Promise<{
  allRankedLists: Paper[][];
  queryResults: { query: string; status: string; lists: number; papers: number }[];
  warnings: string[];
}> {
  const dispatches = queries.map((query) =>
    dispatchSearch({ ...baseOpts, query }, platforms, env)
  );

  const results = await Promise.allSettled(dispatches);

  const allRankedLists: Paper[][] = [];
  const queryResults: { query: string; status: string; lists: number; papers: number }[] = [];
  const warnings: string[] = [];

  results.forEach((r, i) => {
    const query = queries[i];
    if (r.status === "fulfilled") {
      const { rankedLists, warnings: qWarnings } = r.value;
      for (const list of rankedLists) allRankedLists.push(list);
      queryResults.push({
        query,
        status: "ok",
        lists: rankedLists.length,
        papers: rankedLists.reduce((sum, l) => sum + l.length, 0),
      });
      for (const w of qWarnings) warnings.push(`[${query}] ${w}`);
    } else {
      queryResults.push({ query, status: "error", lists: 0, papers: 0 });
      warnings.push(`[${query}] failed: ${r.reason?.message ?? String(r.reason)}`);
    }
  });

  return { allRankedLists, queryResults, warnings };
}

// ---------------------------------------------------------------------------
// Tool Registration
// ---------------------------------------------------------------------------

/**
 * Register all 6 paper-search tools on the given McpServer.
 * Used by both the Cloudflare Worker and the stdio bench adapter.
 */
export function registerTools(server: McpServer, env: Env): void {
  const platforms = getEnabledPlatforms(env);
  const platformNames = platforms.map((p) => p.displayName).join(", ");
  const optionalNames = getOptionalPlatformNames().join(", ");

  // =======================================================================
  // 1. search_papers — core search with RRF fusion
  // =======================================================================
  server.tool(
    "search_papers",
    "Search academic papers across multiple platforms in parallel, merged via Reciprocal Rank Fusion (RRF). " +
      "IMPORTANT: Decompose the user's question into short, specific search terms (2-5 words each) before calling. " +
      "Do NOT pass the raw user question — break it into facets, canonical names, acronyms, and synonyms. " +
      "All queries are dispatched to all platforms simultaneously in one call. " +
      "Papers found by multiple platforms and/or multiple queries rank highest. " +
      "Supports optional journal scoping, date filtering, semantic search, and citation thresholds. " +
      `Enabled platforms: ${platformNames}. ` +
      `Optional platforms (ENABLED_PLATFORMS env var): ${optionalNames}.`,
    {
      query: z
        .union([
          z.string(),
          z.array(z.string()).min(1).max(6),
        ])
        .describe(
          "Decomposed search terms — NOT the raw user question. " +
            "Pass 2-5 short, specific queries (2-5 words each) covering different facets, " +
            "canonical names, acronyms, and synonyms from the decomposed query. " +
            "Example: user asks about 'Word Mover Distance for sentences' → " +
            "['Sentence Movers Distance', 'WMD sentence similarity', 'optimal transport text distance']. " +
            "All queries run in parallel across all platforms."
        ),
      max_results: z
        .number()
        .min(1)
        .max(100)
        .default(20)
        .describe("Max total results after fusion"),
      per_platform: z
        .number()
        .min(1)
        .max(50)
        .default(10)
        .describe("Results per platform per query (10 is a good default)"),
      semantic: z
        .boolean()
        .optional()
        .describe("Also run OpenAlex semantic search for better natural-language query handling"),
      date_from: z
        .string()
        .optional()
        .describe("Start date (YYYY-MM-DD)"),
      date_to: z
        .string()
        .optional()
        .describe("End date (YYYY-MM-DD)"),
      journal: z
        .string()
        .optional()
        .describe("Scope to a specific journal. Accepts journal name or ISSN (e.g. 'Critical AI', '2053-9517')"),
      sort_by: z
        .enum(["relevance", "date", "citations"])
        .default("relevance")
        .optional()
        .describe("Sort by: 'relevance' (RRF score — default), 'date' (newest first), 'citations' (most cited)"),
      min_citations: z
        .number()
        .min(0)
        .optional()
        .describe("Minimum citation count. Note: preprints typically have 0 citations."),
    },
    async (params, extra) => {
      const queries = Array.isArray(params.query) ? params.query : [params.query];
      const warnings: string[] = [];

      // Resolve journal if provided
      let journalIssn: string | undefined;
      let journalSource: string | undefined;
      if (params.journal) {
        await sendStatus(extra, "Resolving journal...");
        const { issn, sourceId } = await resolveJournal(params.journal, env);
        if (!issn && !sourceId) {
          warnings.push(`Could not resolve journal "${params.journal}". Results may not be journal-scoped.`);
        }
        journalIssn = issn ?? undefined;
        journalSource = sourceId ?? params.journal;
      }

      await sendStatus(extra, `Searching ${queries.length} ${queries.length === 1 ? "query" : "queries"} across ${platforms.length} platforms...`);
      const { allRankedLists, queryResults, warnings: dispatchWarnings } =
        await dispatchMultiQuery(
          queries,
          {
            max_results: params.max_results,
            per_platform: params.per_platform,
            semantic: params.semantic,
            date_from: params.date_from,
            date_to: params.date_to,
            journal_issn: journalIssn,
            journal_source: journalSource,
          },
          platforms,
          env
        );
      warnings.push(...dispatchWarnings);

      await sendStatus(extra, "Merging results with rank fusion...");
      // Unified RRF across all queries and platforms
      let fused = reciprocalRankFusion(allRankedLists);

      // Post-fusion date filter (safety net for platforms that can't filter server-side)
      if (params.date_from || params.date_to) {
        const from = params.date_from ? new Date(params.date_from).getTime() : 0;
        const to = params.date_to ? new Date(params.date_to + "T23:59:59").getTime() : Infinity;
        fused = fused.filter((p) => {
          if (!p.published_date) return true;
          const d = new Date(p.published_date).getTime();
          return d >= from && d <= to;
        });
      }

      // Min citations filter
      if (params.min_citations !== undefined) {
        const before = fused.length;
        fused = fused.filter((p) => p.citations >= params.min_citations!);
        if (fused.length < before * 0.5) {
          warnings.push(
            `min_citations=${params.min_citations} filtered ${before - fused.length} of ${before} results. ` +
              "Preprint sources (arXiv, bioRxiv) typically have 0 citations."
          );
        }
      }

      // Sort
      if (params.sort_by === "date") {
        fused.sort((a, b) => new Date(b.published_date).getTime() - new Date(a.published_date).getTime());
      } else if (params.sort_by === "citations") {
        fused.sort((a, b) => b.citations - a.citations);
      }
      // default "relevance": keep RRF ordering

      const finalPapers = fused.slice(0, params.max_results);

      const output: Record<string, unknown> = {
        queries,
        fusion: "reciprocal_rank_fusion",
        query_results: queryResults,
        total_before_fusion: allRankedLists.reduce((sum, l) => sum + l.length, 0),
        total_after_fusion: fused.length,
        papers: finalPapers,
      };
      if (params.journal) {
        output.journal_filter = { journal: params.journal, issn: journalIssn ?? null };
      }
      if (params.date_from || params.date_to) {
        output.date_filter = { from: params.date_from ?? null, to: params.date_to ?? null };
      }
      if (warnings.length > 0) output.warnings = warnings;

      return {
        content: [{ type: "text", text: JSON.stringify(output, null, 2) }],
      };
    }
  );

  // =======================================================================
  // 2. discover_recent_papers — find noteworthy new research
  // =======================================================================
  server.tool(
    "discover_recent_papers",
    "Find noteworthy new research published in the last N days. " +
      "Ranks papers using age-adaptive quality scoring: venue impact factor, multi-platform presence, " +
      "metadata richness, and other pre-citation signals that work for brand-new papers. " +
      "Accepts 1-6 query variations for broader coverage. " +
      "Use this instead of search_papers when you want to surface promising new work.",
    {
      query: z
        .union([
          z.string(),
          z.array(z.string()).min(1).max(6),
        ])
        .describe("Decomposed search terms — 1-6 short, specific queries covering facets and synonyms"),
      days: z
        .number()
        .min(1)
        .max(90)
        .default(7)
        .describe("How many days back to search (default: 7)"),
      journals: z
        .array(z.string())
        .optional()
        .describe("Optional journal names or ISSNs to scope results (e.g. ['Critical AI', '2053-9517'])"),
      max_results: z
        .number()
        .min(1)
        .max(50)
        .default(20)
        .describe("Max results to return"),
    },
    async (params, extra) => {
      const queries = Array.isArray(params.query) ? params.query : [params.query];
      const warnings: string[] = [];

      const now = new Date();
      const fromDate = new Date(now.getTime() - params.days * 24 * 60 * 60 * 1000);
      const dateFrom = fromDate.toISOString().split("T")[0];
      const dateTo = now.toISOString().split("T")[0];

      // Resolve journal ISSNs if provided
      let journalIssn: string | undefined;
      let journalSource: string | undefined;
      const resolvedJournals: string[] = [];
      if (params.journals && params.journals.length > 0) {
        const { issn, sourceId } = await resolveJournal(params.journals[0], env);
        if (issn || sourceId) {
          journalIssn = issn ?? undefined;
          journalSource = sourceId ?? params.journals[0];
          resolvedJournals.push(params.journals[0]);
        } else {
          warnings.push(`Could not resolve journal "${params.journals[0]}".`);
        }
      }

      await sendStatus(extra, `Searching for papers from the last ${params.days} days...`);
      const { allRankedLists, queryResults, warnings: dispatchWarnings } =
        await dispatchMultiQuery(
          queries,
          {
            max_results: params.max_results,
            per_platform: Math.min(params.max_results, 15),
            date_from: dateFrom,
            date_to: dateTo,
            journal_issn: journalIssn,
            journal_source: journalSource,
          },
          platforms,
          env
        );
      warnings.push(...dispatchWarnings);

      await sendStatus(extra, "Merging and scoring results...");
      // RRF across all results
      let fused = reciprocalRankFusion(allRankedLists);

      // Post-fusion date filter
      const from = new Date(dateFrom).getTime();
      const to = new Date(dateTo + "T23:59:59").getTime();
      fused = fused.filter((p) => {
        if (!p.published_date) return true;
        const d = new Date(p.published_date).getTime();
        return d >= from && d <= to;
      });

      await sendStatus(extra, "Ranking by quality signals...");
      // Age-adaptive quality scoring — always applied, this IS the purpose
      const sourceIds = fused
        .map((p) => p.extra?.openalex_source_id as string)
        .filter(Boolean);
      const venueData = sourceIds.length > 0
        ? await batchGetVenueQuality(sourceIds, env)
        : undefined;
      fused = enrichWithQualityScore(fused, venueData);

      const finalPapers = fused.slice(0, params.max_results);

      const output: Record<string, unknown> = {
        queries,
        date_range: { from: dateFrom, to: dateTo },
        scoring: "age_adaptive_quality",
        query_results: queryResults,
        total: fused.length,
        papers: finalPapers,
      };
      if (params.journals) {
        output.journal_filter = params.journals;
      }
      if (warnings.length > 0) output.warnings = warnings;

      return {
        content: [{ type: "text", text: JSON.stringify(output, null, 2) }],
      };
    }
  );

  // =======================================================================
  // 3. rerank_papers — deep quality scoring on specific papers
  // =======================================================================
  server.tool(
    "rerank_papers",
    "Rerank a set of papers by quality signals. Takes DOIs or paper IDs from search results, " +
      "fetches rich metadata from OpenAlex and Semantic Scholar, then scores each paper using " +
      "age-adaptive quality signals (FWCI, venue impact, citation percentile, multi-platform presence). " +
      "Scoring adapts automatically based on paper age — new papers are scored by venue/metadata signals, " +
      "established papers by field-normalized citation impact. " +
      "Use AFTER search_papers to get quality-ranked results on your best candidates.",
    {
      paper_ids: z
        .array(z.string())
        .min(1)
        .max(50)
        .describe(
          "DOIs or paper identifiers to rerank. " +
            "Accepts DOIs (e.g. '10.1038/s41586-024-07487-w'), " +
            "Semantic Scholar IDs, or OpenAlex IDs (e.g. 'W2741809807'). " +
            "Tip: use DOIs from search results for best cross-platform enrichment."
        ),
    },
    async (params, extra) => {
      await sendStatus(extra, `Fetching metadata for ${params.paper_ids.length} papers...`);
      const openalexPlatform = platforms.find((p) => p.name === "openalex");
      const s2Platform = platforms.find((p) => p.name === "semantic_scholar");

      const paperResults: Paper[] = [];
      const unresolvedIds: { id: string; error: string }[] = [];

      const fetchPromises: Promise<void>[] = [];

      for (const id of params.paper_ids) {
        const fetchers: Promise<Paper | null>[] = [];

        if (openalexPlatform?.getById) {
          fetchers.push(openalexPlatform.getById(id, env).catch(() => null));
        }
        if (s2Platform?.getById) {
          const s2Id = id.startsWith("10.") ? `DOI:${id}` : id;
          fetchers.push(s2Platform.getById(s2Id, env).catch(() => null));
        }

        fetchPromises.push(
          Promise.all(fetchers).then((results) => {
            const found = results.filter((r): r is Paper => r !== null);
            if (found.length === 0) {
              unresolvedIds.push({ id, error: "Could not resolve — try providing a DOI" });
              return;
            }
            let merged = found[0];
            if (found.length > 1) {
              merged = {
                ...found[0],
                extra: { ...found[1].extra, ...found[0].extra },
                abstract:
                  (found[0].abstract?.length ?? 0) >= (found[1].abstract?.length ?? 0)
                    ? found[0].abstract
                    : found[1].abstract,
                citations: Math.max(found[0].citations, found[1].citations),
              };
            }
            merged.extra = { ...merged.extra, source_count: found.length };
            paperResults.push(merged);
          })
        );
      }

      await Promise.all(fetchPromises);

      await sendStatus(extra, "Enriching venue quality data...");
      // Batch-enrich venue quality
      const sourceIds = paperResults
        .map((p) => p.extra?.openalex_source_id as string)
        .filter(Boolean);
      const venueData = sourceIds.length > 0
        ? await batchGetVenueQuality(sourceIds, env)
        : undefined;

      await sendStatus(extra, "Computing quality scores...");
      // Score and rank using age-adaptive scoring
      const scored = enrichWithQualityScore(paperResults, venueData);

      const output: Record<string, unknown> = {
        scoring: "age_adaptive_quality",
        scoring_description:
          "Weights adapt by paper age: new papers scored by venue/metadata/multi-platform signals, " +
          "established papers scored by FWCI (field-normalized citation impact), citation percentile, venue quality.",
        total: scored.length,
        papers: scored,
        signal_notes: {
          quality_score: "0-100 composite score. Weights shift automatically based on paper age.",
          lifecycle_stage: "new (0-6 weeks), emerging (6 weeks-1 year), established (1 year+).",
          fwci: "Field-Weighted Citation Impact from OpenAlex. 1.0 = field average. Enables cross-discipline comparison.",
          venue_quality: "Based on 2yr_mean_citedness when available, otherwise venue type heuristic.",
          author_reputation: "Max h-index among authors. Deweighted (8%) — varies by field.",
        },
      };
      if (unresolvedIds.length > 0) output.unresolved = unresolvedIds;

      return {
        content: [{ type: "text", text: JSON.stringify(output, null, 2) }],
      };
    }
  );

  // =======================================================================
  // 4. find_similar_papers — S2 ML recommendations
  // =======================================================================
  server.tool(
    "find_similar_papers",
    "Find papers similar to given seed papers using Semantic Scholar's recommendation engine. " +
      "Provide 1+ paper IDs you like (positive) and optionally IDs to steer away from (negative). " +
      "Accepts DOIs (DOI:xxx), arXiv IDs (ARXIV:xxx), PMIDs (PMID:xxx), or S2 IDs. " +
      "Best used after search_papers finds a highly relevant seed paper. " +
      "Can chain: search → find_similar → get_citation_graph for comprehensive coverage.",
    {
      positive_paper_ids: z
        .array(z.string())
        .min(1)
        .describe(
          "Paper IDs to find similar papers to. " +
            "Examples: ['DOI:10.1038/s41586-024-07487-w', 'ARXIV:2305.03653']"
        ),
      negative_paper_ids: z
        .array(z.string())
        .optional()
        .describe("Paper IDs to steer recommendations away from"),
      max_results: z
        .number()
        .min(1)
        .max(500)
        .default(20)
        .describe("Max recommendations to return"),
    },
    async (params, extra) => {
      try {
        await sendStatus(extra, `Finding papers similar to ${params.positive_paper_ids.length} seed papers...`);
        const papers = await getRecommendations(
          params.positive_paper_ids,
          params.negative_paper_ids ?? [],
          env,
          { limit: params.max_results }
        );
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                {
                  seed_papers: params.positive_paper_ids,
                  negative_papers: params.negative_paper_ids ?? [],
                  total: papers.length,
                  papers,
                },
                null,
                2
              ),
            },
          ],
        };
      } catch (err: any) {
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                error: err.message,
                source: "semantic_scholar_recommendations",
              }),
            },
          ],
        };
      }
    }
  );

  // =======================================================================
  // 5. get_paper — look up a single paper by any ID type
  // =======================================================================
  server.tool(
    "get_paper",
    "Look up a single paper by identifier. Auto-detects ID type and queries the right platform(s) " +
      "for the richest metadata. Accepts DOIs, arXiv IDs, OpenAlex IDs, Semantic Scholar IDs, " +
      "or prefixed IDs (DOI:xxx, ARXIV:xxx, PMID:xxx). " +
      `Enabled platforms: ${platformNames}.`,
    {
      id: z
        .string()
        .describe(
          "Paper identifier. Examples: '10.1038/s41586-024-07487-w' (DOI), " +
            "'2305.03653' (arXiv), 'W2741809807' (OpenAlex), 'PMID:12345678'"
        ),
    },
    async (params, extra) => {
      const { targetPlatforms, transformedId } = detectIdType(params.id);

      await sendStatus(extra, `Looking up paper across ${targetPlatforms.length} platforms...`);
      const fetchers: Promise<{ platform: string; paper: Paper | null }>[] = [];

      for (const platName of targetPlatforms) {
        const plat = platforms.find((p) => p.name === platName);
        if (plat?.getById) {
          const fetchId = platName === "semantic_scholar" && params.id.startsWith("10.")
            ? `DOI:${transformedId}`
            : transformedId;
          fetchers.push(
            plat
              .getById(fetchId, env)
              .then((paper) => ({ platform: platName, paper }))
              .catch(() => ({ platform: platName, paper: null }))
          );
        }
      }

      const results = await Promise.all(fetchers);
      const found = results.filter((r) => r.paper !== null) as { platform: string; paper: Paper }[];

      if (found.length === 0) {
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                error: "Paper not found",
                id: params.id,
                searched_platforms: targetPlatforms,
              }),
            },
          ],
        };
      }

      // Merge results from multiple platforms for richest metadata
      let merged = found[0].paper;
      for (let i = 1; i < found.length; i++) {
        const other = found[i].paper;
        merged = {
          ...merged,
          extra: { ...other.extra, ...merged.extra },
          abstract:
            (merged.abstract?.length ?? 0) >= (other.abstract?.length ?? 0)
              ? merged.abstract
              : other.abstract,
          citations: Math.max(merged.citations, other.citations),
        };
      }
      merged.extra = { ...merged.extra, source_count: found.length };

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              {
                id: params.id,
                found_on: found.map((f) => f.platform),
                paper: merged,
              },
              null,
              2
            ),
          },
        ],
      };
    }
  );

  // =======================================================================
  // 6. get_citation_graph — citation graph traversal
  // =======================================================================
  server.tool(
    "get_citation_graph",
    "Walk the citation graph of a paper. " +
      "Use direction='references' to find foundational/prior work it builds on, " +
      "direction='citations' to find follow-up/derivative work. " +
      "Best used after finding a highly relevant paper via search_papers or find_similar_papers — " +
      "call multiple times to walk multi-hop citation chains. " +
      "Accepts S2 IDs, DOIs (DOI:xxx), arXiv IDs (ARXIV:xxx), or PMIDs (PMID:xxx).",
    {
      paper_id: z
        .string()
        .describe(
          "Paper identifier. Examples: 'DOI:10.1038/s41586-024-07487-w', 'ARXIV:2305.03653', " +
            "or a Semantic Scholar paper ID."
        ),
      direction: z
        .enum(["citations", "references"])
        .default("citations")
        .describe(
          "'citations' = papers that cite this one (follow-up work), " +
            "'references' = papers this one cites (foundational work)"
        ),
      max_results: z
        .number()
        .min(1)
        .max(100)
        .default(20)
        .describe("Max papers to return"),
    },
    async (params, extra) => {
      try {
        await sendStatus(
          extra,
          `Getting ${params.direction} for paper ${params.paper_id}...`
        );
        const papers = await getCitations(
          params.paper_id,
          params.direction,
          env,
          { limit: params.max_results }
        );
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                {
                  paper_id: params.paper_id,
                  direction: params.direction,
                  total: papers.length,
                  papers,
                },
                null,
                2
              ),
            },
          ],
        };
      } catch (err: any) {
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                error: err.message,
                paper_id: params.paper_id,
                direction: params.direction,
              }),
            },
          ],
        };
      }
    }
  );
}
