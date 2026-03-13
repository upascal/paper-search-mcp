/**
 * Paper Search MCP Server (mcp-deploy compatible)
 *
 * A remote academic paper search tool using the Cloudflare Agents SDK.
 * Supports Semantic Scholar, CrossRef, arXiv, PubMed, bioRxiv, medRxiv, and OpenAlex.
 *
 * Platforms are toggled via ENABLED_PLATFORMS env var (comma-separated).
 * Default: semantic_scholar,crossref,arxiv,openalex
 *
 * Auth is handled by mcp-deploy's wrapper — this worker contains NO auth logic.
 */

import { McpAgent } from "agents/mcp";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { getEnabledPlatforms, getAllPlatformNames } from "./registry.js";
import { resolveSourceId, batchGetVenueQuality } from "./platforms/openalex.js";
import { getRecommendations } from "./platforms/semantic-scholar.js";
import { reciprocalRankFusion } from "./rrf.js";
import { enrichWithDiscoveryScore } from "./discovery-signals.js";
import type { ScoringMode } from "./discovery-signals.js";
import type { PlatformSource, Paper, SearchResult } from "./platforms/types.js";

// ---------------------------------------------------------------------------
// Core search helper (shared by search_papers and multi_search)
// ---------------------------------------------------------------------------

interface SearchOptions {
  query: string;
  max_results: number;
  per_platform: number;
  platforms?: string[];
  semantic?: boolean;
  date_from?: string;
  date_to?: string;
  sort_by?: string;
  min_citations?: number;
}

interface SearchOutput {
  rankedLists: Paper[][];
  platformResults: { platform: string; status: string; count?: number; error?: string }[];
  warnings: string[];
}

/**
 * Dispatch a single query to all target platforms and collect ranked lists.
 * Does NOT apply RRF or sorting — caller handles fusion across queries.
 */
async function dispatchSearch(
  opts: SearchOptions,
  allPlatforms: PlatformSource[],
  env: Env
): Promise<SearchOutput> {
  const targetPlatforms = opts.platforms
    ? allPlatforms.filter((p) => opts.platforms!.includes(p.name))
    : allPlatforms;

  const searches: Promise<SearchResult>[] = [];
  const labels: string[] = [];

  for (const p of targetPlatforms) {
    const searchParams: Record<string, unknown> = {
      query: opts.query,
      max_results: opts.per_platform,
    };

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

    if (p.name === "arxiv") {
      searchParams.sort_by = "relevance";
    }

    searches.push(p.search(searchParams as any, env));
    labels.push(p.name);
  }

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

// ---------------------------------------------------------------------------
// Per-platform Zod schemas for tool registration
// ---------------------------------------------------------------------------

function getSearchSchema(platform: PlatformSource) {
  const base: Record<string, any> = {
    query: z.string().describe("Search query"),
    max_results: z
      .number()
      .min(1)
      .max(100)
      .default(10)
      .describe("Max results to return"),
  };

  switch (platform.name) {
    case "semantic_scholar":
      base.year = z
        .string()
        .optional()
        .describe("Year filter: '2024', '2020-2024', '2020-', '-2020'");
      base.bulk = z
        .boolean()
        .optional()
        .describe(
          "Use bulk search endpoint. Supports Boolean syntax: +required -excluded \"exact phrase\" | OR. " +
            "Better for high-recall retrieval. Example: +\"artificial intelligence\" +society -\"computer vision\""
        );
      base.sort = z
        .string()
        .optional()
        .describe(
          "Sort (bulk mode only): 'citationCount:desc', 'citationCount:asc', 'publicationDate:desc', 'publicationDate:asc'"
        );
      break;
    case "crossref":
      base.query_title = z
        .string()
        .optional()
        .describe("Search specifically in paper titles (more precise than generic query)");
      base.query_author = z
        .string()
        .optional()
        .describe("Search specifically by author name");
      base.from_date = z
        .string()
        .optional()
        .describe("Start date filter (YYYY-MM-DD), e.g. '2024-01-01'");
      base.to_date = z
        .string()
        .optional()
        .describe("End date filter (YYYY-MM-DD), e.g. '2024-12-31'");
      base.journal_issn = z
        .string()
        .optional()
        .describe("Filter by journal ISSN, e.g. '2053-9517' for Big Data & Society");
      base.type = z
        .enum([
          "journal-article",
          "book-chapter",
          "proceedings-article",
          "posted-content",
          "dataset",
          "monograph",
        ])
        .optional()
        .describe("Content type filter (defaults to journal-article to reduce noise)");
      base.sort = z
        .enum([
          "relevance",
          "published",
          "deposited",
          "indexed",
          "is-referenced-by-count",
        ])
        .default("relevance")
        .optional()
        .describe("Sort field");
      base.order = z
        .enum(["asc", "desc"])
        .default("desc")
        .optional()
        .describe("Sort order");
      base.filter = z
        .string()
        .optional()
        .describe(
          "Raw CrossRef filter (advanced). Prefer the typed params above. e.g. 'has-abstract:true'"
        );
      break;
    case "arxiv":
      base.sort_by = z
        .enum(["relevance", "submittedDate", "lastUpdatedDate"])
        .default("relevance")
        .optional()
        .describe("Sort field (default: relevance)");
      base.sort_order = z
        .enum(["ascending", "descending"])
        .default("descending")
        .optional()
        .describe("Sort order");
      break;
    case "biorxiv":
    case "medrxiv":
      base.days = z
        .number()
        .min(1)
        .max(365)
        .default(30)
        .optional()
        .describe("How many days back to search (default 30)");
      base.category = z
        .string()
        .optional()
        .describe("Category filter, e.g. 'neuroscience', 'bioinformatics'");
      break;
    case "openalex":
      base.from_date = z
        .string()
        .optional()
        .describe("Start date (YYYY-MM-DD), e.g. '2024-01-01'");
      base.to_date = z
        .string()
        .optional()
        .describe("End date (YYYY-MM-DD), e.g. '2024-12-31'");
      base.source = z
        .string()
        .optional()
        .describe("Journal/source name or ISSN to filter by, e.g. 'Critical AI' or '2834-703X'");
      base.topic = z
        .string()
        .optional()
        .describe("Topic name to filter by, e.g. 'artificial intelligence'");
      base.open_access = z
        .boolean()
        .optional()
        .describe("Only return open-access papers");
      base.type = z
        .string()
        .optional()
        .describe("Work type filter, e.g. 'article', 'review', 'book-chapter'");
      base.sort = z
        .string()
        .optional()
        .describe("Sort: 'relevance_score:desc', 'cited_by_count:desc', 'publication_date:desc'");
      base.semantic = z
        .boolean()
        .optional()
        .describe(
          "Use AI-powered semantic search (GTE-Large embeddings over 217M works). " +
            "Finds conceptually related works even with different vocabulary. " +
            "Requires OPENALEX_API_KEY. $0.001/query. Best for natural language queries."
        );
      break;
  }

  return base;
}

function getByIdSchema(platform: PlatformSource) {
  switch (platform.name) {
    case "crossref":
      return {
        doi: z
          .string()
          .describe("DOI to look up, e.g. '10.1038/s41586-024-07487-w'"),
      };
    case "semantic_scholar":
      return {
        paper_id: z
          .string()
          .describe(
            "Paper ID — Semantic Scholar ID, or prefixed: DOI:xxx, ARXIV:xxx, PMID:xxx, URL:xxx"
          ),
      };
    case "openalex":
      return {
        id: z
          .string()
          .describe(
            "DOI (e.g. '10.1038/s41586-024-07487-w') or OpenAlex ID (e.g. 'W2741809807')"
          ),
      };
    default:
      return { id: z.string().describe("Paper identifier") };
  }
}

function getIdParam(params: Record<string, any>): string {
  return params.doi ?? params.paper_id ?? params.id ?? "";
}

// ---------------------------------------------------------------------------
// Search tool descriptions per platform
// ---------------------------------------------------------------------------

function getSearchDescription(platform: PlatformSource): string {
  switch (platform.name) {
    case "semantic_scholar":
      return "Search academic papers on Semantic Scholar using their ML-trained relevance ranker. Returns TLDRs, influential citation counts, and open access PDF links. Supports year filtering. Set bulk=true for Boolean syntax (+required -excluded \"exact phrase\") and high-recall retrieval up to 1000 results.";
    case "crossref":
      return "Search academic metadata on CrossRef. Covers 150M+ records across all disciplines. Returns DOIs, citation counts, journal info. Supports field-specific title/author queries, date range, journal ISSN, and type filtering. Defaults to journal-article type to reduce noise.";
    case "arxiv":
      return "Search preprints on arXiv. Covers CS, math, physics, quantitative biology, and more. Supports arXiv query syntax: ti: (title), au: (author), abs: (abstract), cat: (category).";
    case "pubmed":
      return "Search biomedical literature on PubMed/MEDLINE via NCBI E-utilities. Supports MeSH terms and field tags: [ti] (title), [au] (author), [mh] (MeSH heading).";
    case "biorxiv":
      return "Browse recent preprints on bioRxiv. Note: bioRxiv API is date-range based — your query filters results client-side by title/abstract/author text matching.";
    case "medrxiv":
      return "Browse recent preprints on medRxiv. Note: medRxiv API is date-range based — your query filters results client-side by title/abstract/author text matching.";
    case "openalex":
      return "Search 250M+ academic works on OpenAlex. Set semantic=true for AI-powered semantic search (finds conceptually related works even with different vocabulary, requires OPENALEX_API_KEY). Excellent filtering by journal/source, topic, date range, open access, and type.";
    default:
      return `Search papers on ${platform.displayName}.`;
  }
}

// ---------------------------------------------------------------------------
// MCP Agent — Durable Object
// ---------------------------------------------------------------------------

export class PaperSearchMCP extends McpAgent<Env> {
  server = new McpServer({
    name: "paper-search",
    version: "0.2.2",
  });

  async init() {
    const platforms = getEnabledPlatforms(this.env);

    // === get_help ===
    this.server.tool(
      "get_help",
      "Get usage instructions for the paper search tools. Lists enabled platforms and search tips.",
      async () => {
        const help = {
          enabled_platforms: platforms.map((p) => ({
            name: p.name,
            display: p.displayName,
            tools: [
              `search_${p.name}`,
              ...(p.getById ? [`get_${p.name}_paper`] : []),
            ],
          })),
          all_available_platforms: getAllPlatformNames(),
          unified_search: "search_papers — searches all enabled platforms in parallel",
          configuration: {
            ENABLED_PLATFORMS: `Set to comma-separated list. Current: ${platforms.map((p) => p.name).join(",")}`,
            SEMANTIC_SCHOLAR_API_KEY: "Optional. Get from semanticscholar.org for higher rate limits.",
            PUBMED_API_KEY: "Optional. Get from ncbi.nlm.nih.gov for higher rate limits.",
            CONTACT_EMAIL: "Optional. Used for CrossRef polite pool (better rate limits).",
          },
          tips: [
            "Use search_papers for best relevance — it searches all platforms and merges results with Reciprocal Rank Fusion (RRF).",
            "QUERY EXPANSION: For broad topics, use multi_search with 2-6 focused query variations — it runs ALL queries across ALL platforms in parallel within a single call, much faster than sequential search_papers calls. " +
              "Generate sub-queries covering different facets, synonyms, and related concepts. E.g. instead of 'climate change effects on agriculture', use " +
              "['crop yield climate variability', 'drought resistant farming adaptation', 'food security global warming']. Papers appearing across multiple queries rank highest via cross-query RRF.",
            "Set semantic=true on search_papers for natural-language or conceptual queries — it runs OpenAlex semantic search alongside keyword search for better recall on thematic queries.",
            "Use date_from/date_to on search_papers to scope results to a time window (YYYY-MM-DD). Use sort_by='date' to prioritize recent work, or sort_by='citations' for high-impact papers.",
            "TWO SCORING MODES for different research workflows: " +
              "(1) sort_by='discovery' — for new papers (0-6 weeks). Weights venue impact factor 25%, multi-platform presence 20%, metadata 10%, recency 10%. Author h-index deweighted to 8% (biased by field/gender/career-stage). " +
              "(2) sort_by='literature_review' — for established papers. Weights FWCI (field-normalized citation impact) 30%, venue quality 20%, citation percentile 15%. Enables cross-discipline comparison (essential for social science + CS + economics). " +
              "Each paper gets a 0-100 score with transparent signal breakdowns.",
            "Use min_citations on search_papers to filter out low-quality or uncited results (note: preprints typically have 0 citations).",
            "Use search_recent for daily digest workflows — it already handles date scoping and multi-platform RRF. Better than manually date-filtering search_papers for 'what's new' queries.",
            "Use find_similar_papers to expand a reading list — provide paper IDs you like, get ML-powered recommendations. Great after an initial search to discover related work.",
            "Use search_journal to monitor specific journals (e.g. 'Critical AI', 'Big Data & Society').",
            "WORKFLOW for thorough literature review: (1) multi_search with 3-5 query variations + semantic=true for broad coverage, " +
              "(2) evaluate_papers on the best DOIs with mode='literature_review' for deep quality analysis, " +
              "(3) find_similar_papers on top results to expand, (4) search_recent to catch new work.",
            "WORKFLOW for daily discovery: (1) multi_search with query variations + sort_by='discovery' + date filters for new papers, " +
              "(2) evaluate_papers on promising candidates with mode='discovery', (3) refine with additional queries if needed.",
            "evaluate_papers is a standalone quality assessment tool — use it AFTER searching to score/rank candidates from any search. Pass DOIs from search results. Two modes match the two workflows above.",
            "Semantic Scholar: set bulk=true for Boolean syntax (+required -excluded \"exact phrase\") and high-recall retrieval up to 1000 results.",
          ],
        };
        return {
          content: [{ type: "text", text: JSON.stringify(help, null, 2) }],
        };
      }
    );

    // === Per-platform tools ===
    for (const platform of platforms) {
      // search_{platform}
      this.server.tool(
        `search_${platform.name}`,
        getSearchDescription(platform),
        getSearchSchema(platform),
        async (params) => {
          try {
            const result = await platform.search(params, this.env);
            return {
              content: [
                { type: "text", text: JSON.stringify(result, null, 2) },
              ],
            };
          } catch (err: any) {
            return {
              content: [
                {
                  type: "text",
                  text: JSON.stringify({
                    error: err.message,
                    source: platform.name,
                  }),
                },
              ],
            };
          }
        }
      );

      // get_{platform}_paper (if supported)
      if (platform.getById) {
        const getByIdFn = platform.getById.bind(platform);
        this.server.tool(
          `get_${platform.name}_paper`,
          `Look up a single paper on ${platform.displayName} by identifier.`,
          getByIdSchema(platform),
          async (params) => {
            try {
              const paper = await getByIdFn(getIdParam(params), this.env);
              if (!paper) {
                return {
                  content: [
                    {
                      type: "text",
                      text: JSON.stringify({ error: "Paper not found" }),
                    },
                  ],
                };
              }
              return {
                content: [
                  { type: "text", text: JSON.stringify(paper, null, 2) },
                ],
              };
            } catch (err: any) {
              return {
                content: [
                  {
                    type: "text",
                    text: JSON.stringify({
                      error: err.message,
                      source: platform.name,
                    }),
                  },
                ],
              };
            }
          }
        );
      }
    }

    // === Unified search_papers (with Reciprocal Rank Fusion) ===
    this.server.tool(
      "search_papers",
      "Search across all enabled academic platforms in parallel, then merge results using Reciprocal Rank Fusion (RRF) " +
        "for a single relevance-ranked list. Papers found by multiple platforms rank higher. " +
        "Set semantic=true to also run OpenAlex semantic search for better natural-language query handling. " +
        "Supports date_from/date_to filtering, sort_by (relevance/date/citations/discovery/literature_review), and min_citations threshold. " +
        "Use sort_by='discovery' for NEW research (0-6 weeks) — ranks by venue impact factor, multi-platform presence, metadata quality; h-index deweighted to 8%. " +
        "Use sort_by='literature_review' for established papers — ranks by FWCI (field-normalized citation impact), citation percentile, venue quality; enables cross-discipline comparison. " +
        "For broad topics, prefer multi_search (parallel multi-query) over multiple search_papers calls — it's faster within the worker timeout. Then use evaluate_papers on the best candidates for deeper quality analysis. " +
        `Currently enabled: ${platforms.map((p) => p.displayName).join(", ")}.`,
      {
        query: z
          .string()
          .describe(
            "Search query — use specific, focused terms for best results. " +
              "Keyword search is literal-match; for conceptual/thematic queries, set semantic=true. " +
              "For broad topics, call this tool multiple times with different focused queries."
          ),
        max_results: z
          .number()
          .min(1)
          .max(50)
          .default(10)
          .describe("Max total results to return (after fusion)"),
        per_platform: z
          .number()
          .min(1)
          .max(50)
          .default(15)
          .describe("Results to fetch per platform before fusion (more = better fusion quality)"),
        platforms: z
          .array(z.string())
          .optional()
          .describe(
            `Limit to specific platforms. Available: ${platforms.map((p) => p.name).join(", ")}`
          ),
        semantic: z
          .boolean()
          .optional()
          .describe(
            "Also run OpenAlex semantic search alongside keyword search for better relevance on natural language queries"
          ),
        date_from: z
          .string()
          .optional()
          .describe("Start date (YYYY-MM-DD). Only return papers published on or after this date."),
        date_to: z
          .string()
          .optional()
          .describe("End date (YYYY-MM-DD). Only return papers published on or before this date."),
        sort_by: z
          .enum(["relevance", "date", "citations", "discovery", "literature_review"])
          .default("relevance")
          .optional()
          .describe(
            "Sort by: 'relevance' (RRF score), 'date' (newest first), 'citations' (most cited), " +
              "'discovery' (best for NEW research 0-6 weeks old — ranks by venue quality, multi-platform presence, metadata richness; h-index deweighted), " +
              "or 'literature_review' (best for established papers — ranks by field-normalized citation impact FWCI, citation percentile, venue quality; enables cross-discipline comparison)"
          ),
        min_citations: z
          .number()
          .min(0)
          .optional()
          .describe(
            "Minimum citation count. Papers below this are excluded. " +
              "Note: preprints (arXiv, bioRxiv) typically have 0 citations."
          ),
      },
      async (params) => {
        const { rankedLists, platformResults, warnings } = await dispatchSearch(
          {
            query: params.query,
            max_results: params.max_results,
            per_platform: params.per_platform,
            platforms: params.platforms,
            semantic: params.semantic,
            date_from: params.date_from,
            date_to: params.date_to,
          },
          platforms,
          this.env
        );

        // Apply Reciprocal Rank Fusion
        let fused = reciprocalRankFusion(rankedLists);

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

        // Apply min_citations filter
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

        // Apply sort
        if (params.sort_by === "discovery" || params.sort_by === "literature_review") {
          const mode: ScoringMode = params.sort_by === "literature_review" ? "literature_review" : "discovery";
          const sourceIds = fused
            .map((p) => p.extra?.openalex_source_id as string)
            .filter(Boolean);
          const venueData = sourceIds.length > 0
            ? await batchGetVenueQuality(sourceIds, this.env)
            : undefined;
          fused = enrichWithDiscoveryScore(fused, mode, venueData);
        } else if (params.sort_by === "date") {
          fused.sort(
            (a, b) =>
              new Date(b.published_date).getTime() -
              new Date(a.published_date).getTime()
          );
        } else if (params.sort_by === "citations") {
          fused.sort((a, b) => b.citations - a.citations);
        }

        const finalPapers = fused.slice(0, params.max_results);

        const output: Record<string, unknown> = {
          query: params.query,
          fusion: "reciprocal_rank_fusion",
          platform_results: platformResults,
          total_before_fusion: rankedLists.reduce((sum, l) => sum + l.length, 0),
          total_after_fusion: fused.length,
          papers: finalPapers,
        };
        if (params.date_from || params.date_to) {
          output.date_filter = { from: params.date_from ?? null, to: params.date_to ?? null };
        }
        if (warnings.length > 0) output.warnings = warnings;

        return {
          content: [{ type: "text", text: JSON.stringify(output, null, 2) }],
        };
      }
    );

    // === multi_search — parallel multi-query search with unified RRF ===
    this.server.tool(
      "multi_search",
      "Search multiple queries in parallel within a SINGLE worker invocation, then merge ALL results with RRF. " +
        "Much faster than calling search_papers multiple times — dispatches all queries to all platforms simultaneously " +
        "instead of sequential round trips. Essential for query expansion workflows. " +
        "Papers found across multiple queries AND multiple platforms rank highest. " +
        "USAGE: Pass 2-6 focused query variations covering different facets, synonyms, or sub-topics of the research question. " +
        "Example: for 'AI governance', use queries like ['algorithmic accountability regulation', " +
        "'machine learning policy framework', 'AI ethics institutional oversight', 'automated decision-making governance']. " +
        "Each query hits all enabled platforms in parallel. Results are deduplicated and fused into a single ranked list.",
      {
        queries: z
          .array(z.string())
          .min(2)
          .max(6)
          .describe(
            "Array of 2-6 focused search queries. Each should cover a different facet, synonym, " +
              "or sub-topic of the research question. More queries = better recall but slower."
          ),
        max_results: z
          .number()
          .min(1)
          .max(100)
          .default(20)
          .describe("Max total results to return after fusion across all queries"),
        per_platform: z
          .number()
          .min(1)
          .max(20)
          .default(10)
          .describe("Results per platform per query (keep low to stay within rate limits; 10 is a good default)"),
        semantic: z
          .boolean()
          .optional()
          .describe("Also run OpenAlex semantic search for each query (adds recall but uses more API budget)"),
        date_from: z
          .string()
          .optional()
          .describe("Start date (YYYY-MM-DD)"),
        date_to: z
          .string()
          .optional()
          .describe("End date (YYYY-MM-DD)"),
        sort_by: z
          .enum(["relevance", "date", "citations", "discovery", "literature_review"])
          .default("relevance")
          .optional()
          .describe(
            "Sort by: 'relevance' (RRF — papers appearing across multiple queries rank highest), " +
              "'discovery' (new research scoring), 'literature_review' (FWCI-based), 'date', or 'citations'"
          ),
        min_citations: z
          .number()
          .min(0)
          .optional()
          .describe("Minimum citation count filter"),
      },
      async (params) => {
        // Dispatch ALL queries in parallel — this is the key performance win.
        // Each query fans out to all platforms simultaneously.
        const allDispatches = params.queries.map((query) =>
          dispatchSearch(
            {
              query,
              max_results: params.max_results,
              per_platform: params.per_platform,
              semantic: params.semantic,
              date_from: params.date_from,
              date_to: params.date_to,
            },
            platforms,
            this.env
          )
        );

        const dispatchResults = await Promise.allSettled(allDispatches);

        // Collect all ranked lists across all queries for unified RRF
        const allRankedLists: Paper[][] = [];
        const queryResults: { query: string; status: string; lists: number; papers: number }[] = [];
        const warnings: string[] = [];

        dispatchResults.forEach((r, i) => {
          const query = params.queries[i];
          if (r.status === "fulfilled") {
            const { rankedLists, platformResults, warnings: qWarnings } = r.value;
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

        // Unified RRF across ALL queries and ALL platforms
        // Papers appearing in results for multiple queries get boosted
        let fused = reciprocalRankFusion(allRankedLists);

        // Post-fusion date filter
        if (params.date_from || params.date_to) {
          const from = params.date_from ? new Date(params.date_from).getTime() : 0;
          const to = params.date_to ? new Date(params.date_to + "T23:59:59").getTime() : Infinity;
          fused = fused.filter((p) => {
            if (!p.published_date) return true;
            const d = new Date(p.published_date).getTime();
            return d >= from && d <= to;
          });
        }

        // Apply min_citations filter
        if (params.min_citations !== undefined) {
          const before = fused.length;
          fused = fused.filter((p) => p.citations >= params.min_citations!);
          if (fused.length < before * 0.5) {
            warnings.push(
              `min_citations=${params.min_citations} filtered ${before - fused.length} of ${before} results.`
            );
          }
        }

        // Apply sort
        if (params.sort_by === "discovery" || params.sort_by === "literature_review") {
          const mode: ScoringMode = params.sort_by === "literature_review" ? "literature_review" : "discovery";
          const sourceIds = fused
            .map((p) => p.extra?.openalex_source_id as string)
            .filter(Boolean);
          const venueData = sourceIds.length > 0
            ? await batchGetVenueQuality(sourceIds, this.env)
            : undefined;
          fused = enrichWithDiscoveryScore(fused, mode, venueData);
        } else if (params.sort_by === "date") {
          fused.sort(
            (a, b) =>
              new Date(b.published_date).getTime() -
              new Date(a.published_date).getTime()
          );
        } else if (params.sort_by === "citations") {
          fused.sort((a, b) => b.citations - a.citations);
        }

        const finalPapers = fused.slice(0, params.max_results);

        const output: Record<string, unknown> = {
          queries: params.queries,
          fusion: "reciprocal_rank_fusion_cross_query",
          query_results: queryResults,
          total_before_fusion: allRankedLists.reduce((sum, l) => sum + l.length, 0),
          total_after_fusion: fused.length,
          papers: finalPapers,
        };
        if (params.date_from || params.date_to) {
          output.date_filter = { from: params.date_from ?? null, to: params.date_to ?? null };
        }
        if (warnings.length > 0) output.warnings = warnings;

        return {
          content: [{ type: "text", text: JSON.stringify(output, null, 2) }],
        };
      }
    );

    // === search_journal — search within a specific journal ===
    this.server.tool(
      "search_journal",
      "Search for articles within a specific journal. Resolves journal names to ISSNs automatically. " +
        "Great for monitoring specific publications like 'Critical AI' or 'Big Data & Society'.",
      {
        journal: z
          .string()
          .describe(
            "Journal name or ISSN. Examples: 'Critical AI', 'Big Data & Society', '2053-9517'"
          ),
        query: z
          .string()
          .optional()
          .describe("Optional search terms to filter within the journal"),
        days: z
          .number()
          .min(1)
          .max(365)
          .default(7)
          .describe("How many days back to search (default: 7)"),
        max_results: z
          .number()
          .min(1)
          .max(50)
          .default(20)
          .describe("Max results to return"),
      },
      async (params) => {
        const now = new Date();
        const fromDate = new Date(
          now.getTime() - params.days * 24 * 60 * 60 * 1000
        );
        const fromStr = fromDate.toISOString().split("T")[0];
        const toStr = now.toISOString().split("T")[0];

        const isIssn = /^\d{4}-\d{3}[\dXx]$/.test(params.journal);
        let issn: string | null = isIssn ? params.journal : null;
        let sourceId: string | null = null;

        // Resolve journal name to ISSN and OpenAlex source ID
        if (!isIssn) {
          const resolved = await resolveSourceId(params.journal, this.env);
          if (resolved) {
            issn = resolved.issn_l;
            sourceId = resolved.id;
          }
        }

        const searches: Promise<SearchResult>[] = [];
        const searchLabels: string[] = [];

        // OpenAlex search (preferred — better filtering)
        const openalexPlatform = platforms.find((p) => p.name === "openalex");
        if (openalexPlatform) {
          const oaParams: Record<string, unknown> = {
            query: params.query ?? "",
            max_results: params.max_results,
            from_date: fromStr,
            to_date: toStr,
            sort: "publication_date:desc",
          };
          if (sourceId) {
            oaParams.source = params.journal;
          } else if (issn) {
            oaParams.source = issn;
          }
          searches.push(openalexPlatform.search(oaParams as any, this.env));
          searchLabels.push("openalex");
        }

        // CrossRef search (backup — uses ISSN filter)
        const crossrefPlatform = platforms.find((p) => p.name === "crossref");
        if (crossrefPlatform && issn) {
          searches.push(
            crossrefPlatform.search(
              {
                query: params.query ?? "",
                max_results: params.max_results,
                from_date: fromStr,
                to_date: toStr,
                journal_issn: issn,
                sort: "published",
                order: "desc",
              } as any,
              this.env
            )
          );
          searchLabels.push("crossref");
        }

        if (searches.length === 0) {
          return {
            content: [
              {
                type: "text",
                text: JSON.stringify({
                  error: `Could not resolve journal "${params.journal}". Try using an ISSN instead.`,
                }),
              },
            ],
          };
        }

        const results = await Promise.allSettled(searches);
        const allPapers = deduplicateByDoi(
          results.flatMap((r, i) =>
            r.status === "fulfilled" ? r.value.papers : []
          )
        );

        // Sort by date descending
        allPapers.sort(
          (a, b) =>
            new Date(b.published_date).getTime() -
            new Date(a.published_date).getTime()
        );

        const output = {
          journal: params.journal,
          issn: issn,
          date_range: { from: fromStr, to: toStr },
          total: allPapers.length,
          papers: allPapers.slice(0, params.max_results),
        };
        return {
          content: [{ type: "text", text: JSON.stringify(output, null, 2) }],
        };
      }
    );

    // === find_similar_papers — S2 recommendations ===
    this.server.tool(
      "find_similar_papers",
      "Find papers similar to given seed papers using Semantic Scholar's recommendation engine. " +
        "Provide 1+ paper IDs you like (positive) and optionally paper IDs you don't want (negative). " +
        "Accepts Semantic Scholar IDs, DOIs (prefixed DOI:xxx), arXiv IDs (ARXIV:xxx), or PMIDs (PMID:xxx). " +
        "Great for expanding a reading list or finding related work.",
      {
        positive_paper_ids: z
          .array(z.string())
          .min(1)
          .describe(
            "Paper IDs to find similar papers to. " +
              "Examples: ['649def34f8be52c8b66281af98ae884c09aef38b', 'DOI:10.1038/s41586-024-07487-w', 'ARXIV:2305.03653']"
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
          .describe("Max recommendations to return (up to 500)"),
      },
      async (params) => {
        try {
          const papers = await getRecommendations(
            params.positive_paper_ids,
            params.negative_paper_ids ?? [],
            this.env,
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

    // === evaluate_papers — standalone scoring/evaluation ===
    this.server.tool(
      "evaluate_papers",
      "Evaluate and score a set of papers using field-normalized quality signals. " +
        "Takes DOIs or paper IDs from previous search results and returns detailed quality assessments. " +
        "Two modes: 'discovery' (for new papers 0-6 weeks — venue quality, multi-platform presence, metadata) " +
        "or 'literature_review' (for established papers — FWCI, citation percentile, venue impact factor). " +
        "Use this AFTER searching to get quality-ranked results, or to compare papers across different searches. " +
        "WORKFLOW: search_papers → pick candidates → evaluate_papers → refine search → evaluate_papers again. " +
        "NOTE: h-index is included but deweighted (8%) — it varies dramatically by field " +
        "(CS full professor ~15, biology ~30+, law ~2.8). Use FWCI for cross-discipline comparison.",
      {
        paper_ids: z
          .array(z.string())
          .min(1)
          .max(50)
          .describe(
            "DOIs or paper identifiers to evaluate. " +
              "Accepts DOIs (e.g. '10.1038/s41586-024-07487-w'), " +
              "Semantic Scholar IDs, or OpenAlex IDs (e.g. 'W2741809807'). " +
              "Tip: use DOIs from search results for best cross-platform enrichment."
          ),
        mode: z
          .enum(["discovery", "literature_review"])
          .default("discovery")
          .describe(
            "Scoring mode: 'discovery' for new papers (weights venue quality, recency, metadata), " +
              "'literature_review' for established papers (weights FWCI, citation percentile, venue impact)"
          ),
      },
      async (params) => {
        const mode: ScoringMode = params.mode as ScoringMode;

        // Fetch papers from OpenAlex and Semantic Scholar in parallel for richest data
        const openalexPlatform = platforms.find((p) => p.name === "openalex");
        const s2Platform = platforms.find((p) => p.name === "semantic_scholar");

        const paperResults: Paper[] = [];
        const errors: string[] = [];

        // Batch fetch from both platforms
        const fetchPromises: Promise<void>[] = [];

        for (const id of params.paper_ids) {
          const fetchers: Promise<Paper | null>[] = [];

          if (openalexPlatform?.getById) {
            fetchers.push(openalexPlatform.getById(id, this.env).catch(() => null));
          }
          if (s2Platform?.getById) {
            // Prefix DOIs for S2
            const s2Id = id.startsWith("10.") ? `DOI:${id}` : id;
            fetchers.push(s2Platform.getById(s2Id, this.env).catch(() => null));
          }

          fetchPromises.push(
            Promise.all(fetchers).then((results) => {
              const found = results.filter((r): r is Paper => r !== null);
              if (found.length === 0) {
                errors.push(`Not found: ${id}`);
                return;
              }
              // Merge data from both platforms (OpenAlex has FWCI, S2 has h-index)
              let merged = found[0];
              if (found.length > 1) {
                merged = {
                  ...found[0],
                  extra: { ...found[1].extra, ...found[0].extra },
                  // Take better abstract
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

        // Batch-enrich venue quality
        const sourceIds = paperResults
          .map((p) => p.extra?.openalex_source_id as string)
          .filter(Boolean);
        const venueData = sourceIds.length > 0
          ? await batchGetVenueQuality(sourceIds, this.env)
          : undefined;

        // Score and rank
        const scored = enrichWithDiscoveryScore(paperResults, mode, venueData);

        const output: Record<string, unknown> = {
          mode,
          mode_description: mode === "discovery"
            ? "Optimized for new papers (0-6 weeks). Weights: venue quality 25%, multi-platform 20%, abstract 15%, metadata 10%, recency 10%, author 8%, FWCI 5%."
            : "Optimized for established papers. Weights: FWCI 30%, venue quality 20%, citation percentile 15%, multi-platform 10%, author 8%.",
          total: scored.length,
          papers: scored,
          signal_notes: {
            fwci: "Field-Weighted Citation Impact from OpenAlex. 1.0 = field average. >1 = above average. Enables cross-discipline comparison.",
            citation_percentile: "Percentile rank vs. same field/year/type papers. 0.95 = top 5%.",
            venue_quality: "Based on 2yr_mean_citedness (≈ impact factor) when available, otherwise venue type heuristic.",
            author_reputation: "Max h-index among authors. CAUTION: varies dramatically by field (CS ~15, biology ~30+, law ~2.8). Deweighted to 8%.",
          },
        };
        if (errors.length > 0) output.errors = errors;

        return {
          content: [{ type: "text", text: JSON.stringify(output, null, 2) }],
        };
      }
    );

    // === search_recent — daily digest helper ===
    this.server.tool(
      "search_recent",
      "Search for recent articles across platforms — preferred over search_papers for 'what's new' queries. " +
        "Automatically scopes to a time window (default: last 1 day) with date-sorted results. " +
        "Searches OpenAlex, CrossRef, and Semantic Scholar with RRF fusion, optional journal scoping, " +
        "and deduplication. Set sort='discovery' to rank new papers by venue impact factor, multi-platform presence, and metadata " +
        "(h-index deweighted to 8% — it's biased across fields). " +
        "For deeper quality analysis on promising results, follow up with evaluate_papers.",
      {
        query: z
          .string()
          .describe(
            "Search terms — use focused keywords for best results. " +
              "For broad topics, make multiple calls with different sub-queries."
          ),
        days: z
          .number()
          .min(1)
          .max(90)
          .default(1)
          .describe("How many days back to search (default: 1)"),
        journals: z
          .array(z.string())
          .optional()
          .describe(
            "Optional list of journal names or ISSNs to scope the search. " +
              "Examples: ['Critical AI', '2053-9517', 'Big Data & Society']"
          ),
        max_results: z
          .number()
          .min(1)
          .max(50)
          .default(20)
          .describe("Max total results to return"),
        sort: z
          .enum(["date", "citations", "discovery", "literature_review"])
          .default("date")
          .describe(
            "Sort by: 'date' (newest first), 'citations' (most cited), " +
              "'discovery' (best for new research — ranks by venue quality, multi-platform presence, metadata; h-index deweighted), " +
              "or 'literature_review' (ranks by field-normalized citation impact, percentile, venue quality)"
          ),
      },
      async (params) => {
        const now = new Date();
        const fromDate = new Date(
          now.getTime() - params.days * 24 * 60 * 60 * 1000
        );
        const fromStr = fromDate.toISOString().split("T")[0];
        const toStr = now.toISOString().split("T")[0];

        const perPlatform = Math.min(params.max_results, 20);
        const searches: Promise<SearchResult>[] = [];
        const searchLabels: string[] = [];

        // If journals are specified, resolve ISSNs
        const journalIssns: string[] = [];
        if (params.journals) {
          for (const j of params.journals) {
            if (/^\d{4}-\d{3}[\dXx]$/.test(j)) {
              journalIssns.push(j);
            } else {
              const resolved = await resolveSourceId(j, this.env);
              if (resolved?.issn_l) journalIssns.push(resolved.issn_l);
            }
          }
        }

        // OpenAlex — best for date + journal filtering
        const openalexPlatform = platforms.find((p) => p.name === "openalex");
        if (openalexPlatform) {
          if (journalIssns.length > 0) {
            // Search each journal separately on OpenAlex
            for (const issn of journalIssns) {
              searches.push(
                openalexPlatform.search(
                  {
                    query: params.query,
                    max_results: perPlatform,
                    from_date: fromStr,
                    to_date: toStr,
                    source: issn,
                    sort: "publication_date:desc",
                  } as any,
                  this.env
                )
              );
              searchLabels.push(`openalex:${issn}`);
            }
          } else {
            searches.push(
              openalexPlatform.search(
                {
                  query: params.query,
                  max_results: perPlatform,
                  from_date: fromStr,
                  to_date: toStr,
                  sort: "publication_date:desc",
                } as any,
                this.env
              )
            );
            searchLabels.push("openalex");
          }
        }

        // CrossRef — with date and journal filters
        const crossrefPlatform = platforms.find((p) => p.name === "crossref");
        if (crossrefPlatform) {
          if (journalIssns.length > 0) {
            for (const issn of journalIssns) {
              searches.push(
                crossrefPlatform.search(
                  {
                    query: params.query,
                    max_results: perPlatform,
                    from_date: fromStr,
                    to_date: toStr,
                    journal_issn: issn,
                    sort: "published",
                    order: "desc",
                  } as any,
                  this.env
                )
              );
              searchLabels.push(`crossref:${issn}`);
            }
          } else {
            searches.push(
              crossrefPlatform.search(
                {
                  query: params.query,
                  max_results: perPlatform,
                  from_date: fromStr,
                  to_date: toStr,
                  sort: "published",
                  order: "desc",
                } as any,
                this.env
              )
            );
            searchLabels.push("crossref");
          }
        }

        // Semantic Scholar — year-based filtering (less granular)
        const semanticPlatform = platforms.find(
          (p) => p.name === "semantic_scholar"
        );
        if (semanticPlatform && !params.journals) {
          const year = fromDate.getFullYear();
          searches.push(
            semanticPlatform.search(
              {
                query: params.query,
                max_results: perPlatform,
                year: `${year}-`,
              } as any,
              this.env
            )
          );
          searchLabels.push("semantic_scholar");
        }

        const results = await Promise.allSettled(searches);

        const rankedLists: Paper[][] = [];
        const platformResults: { platform: string; status: string; count?: number; error?: string }[] = [];
        const warnings: string[] = [];

        results.forEach((r, i) => {
          if (r.status === "fulfilled") {
            rankedLists.push(r.value.papers);
            platformResults.push({
              platform: searchLabels[i],
              status: "ok",
              count: r.value.papers.length,
            });
            if (r.value.warnings) {
              for (const w of r.value.warnings) warnings.push(`${searchLabels[i]}: ${w}`);
            }
          } else {
            platformResults.push({
              platform: searchLabels[i],
              status: "error",
              error: r.reason?.message ?? String(r.reason),
            });
            warnings.push(`${searchLabels[i]} failed: ${r.reason?.message ?? String(r.reason)}`);
          }
        });

        // Use RRF to merge and rank results
        let fused = reciprocalRankFusion(rankedLists);

        // Apply secondary sort if requested
        if (params.sort === "discovery" || params.sort === "literature_review") {
          const mode: ScoringMode = params.sort === "literature_review" ? "literature_review" : "discovery";
          const sourceIds = fused
            .map((p) => p.extra?.openalex_source_id as string)
            .filter(Boolean);
          const venueData = sourceIds.length > 0
            ? await batchGetVenueQuality(sourceIds, this.env)
            : undefined;
          fused = enrichWithDiscoveryScore(fused, mode, venueData);
        } else if (params.sort === "citations") {
          fused.sort((a, b) => b.citations - a.citations);
        } else if (params.sort === "date") {
          fused.sort(
            (a, b) =>
              new Date(b.published_date).getTime() -
              new Date(a.published_date).getTime()
          );
        }

        const output: Record<string, unknown> = {
          query: params.query,
          date_range: { from: fromStr, to: toStr },
          journals_filter: params.journals ?? null,
          fusion: "reciprocal_rank_fusion",
          platform_results: platformResults,
          total: fused.length,
          papers: fused.slice(0, params.max_results),
        };
        if (warnings.length > 0) output.warnings = warnings;
        return {
          content: [{ type: "text", text: JSON.stringify(output, null, 2) }],
        };
      }
    );
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Deduplicate papers by DOI, keeping the first occurrence. */
function deduplicateByDoi(papers: Paper[]): Paper[] {
  const seen = new Set<string>();
  const result: Paper[] = [];
  for (const p of papers) {
    const key = p.doi ? p.doi.toLowerCase() : `${p.source}:${p.paper_id}`;
    if (!seen.has(key)) {
      seen.add(key);
      result.push(p);
    }
  }
  return result;
}

// ---------------------------------------------------------------------------
// Worker fetch handler — clean, no auth (mcp-deploy handles auth)
// ---------------------------------------------------------------------------

export default {
  fetch(request: Request, env: Env, ctx: ExecutionContext) {
    const url = new URL(request.url);

    // Health check
    if (url.pathname === "/") {
      return new Response(
        JSON.stringify({ name: "paper-search", version: "0.2.2", status: "ok" }),
        { headers: { "content-type": "application/json" } }
      );
    }

    return (
      PaperSearchMCP.serve("/mcp") as {
        fetch: (req: Request, env: Env, ctx: ExecutionContext) => Response | Promise<Response>;
      }
    ).fetch(request, env, ctx);
  },
};
