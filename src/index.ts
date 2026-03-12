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
import { resolveSourceId } from "./platforms/openalex.js";
import type { PlatformSource, Paper, SearchResult } from "./platforms/types.js";

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
        .enum(["submittedDate", "relevance", "lastUpdatedDate"])
        .default("submittedDate")
        .optional()
        .describe("Sort field");
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
      return "Search academic papers on Semantic Scholar. Great for CS, social science, and interdisciplinary research. Supports year filtering and returns citation counts + open access PDF links.";
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
      return "Search 250M+ academic works on OpenAlex. Excellent filtering by journal/source, topic, date range, open access, and type. Free API, no key required. Best for structured queries like 'articles in Big Data & Society from last 30 days'.";
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
    version: "0.1.0",
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
            "Use search_papers for broad discovery across all platforms at once",
            "Use search_journal to find recent articles from a specific journal (e.g. 'Critical AI', 'Big Data & Society')",
            "Use search_recent for daily digest workflows — searches recent articles across platforms with date filtering",
            "OpenAlex is best for structured queries — filter by journal, topic, date, open access, and citation count",
            "Semantic Scholar is best for CS and social science — has citation counts and field-of-study tags",
            "CrossRef now defaults to journal-article type and supports title-specific and author-specific queries for less noise",
            "arXiv is best for the latest CS/math/physics preprints",
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

    // === Unified search_papers ===
    this.server.tool(
      "search_papers",
      "Search across all enabled academic platforms in parallel. Returns combined results grouped by source. " +
        `Currently enabled: ${platforms.map((p) => p.displayName).join(", ")}.`,
      {
        query: z.string().describe("Search query"),
        max_results: z
          .number()
          .min(1)
          .max(20)
          .default(5)
          .describe("Max results per platform"),
        platforms: z
          .array(z.string())
          .optional()
          .describe(
            `Limit to specific platforms. Available: ${platforms.map((p) => p.name).join(", ")}`
          ),
      },
      async (params) => {
        const targetPlatforms = params.platforms
          ? platforms.filter((p) => params.platforms!.includes(p.name))
          : platforms;

        const results = await Promise.allSettled(
          targetPlatforms.map((p) =>
            p.search(
              { query: params.query, max_results: params.max_results },
              this.env
            )
          )
        );

        const combined: { results: any[]; errors: any[] } = {
          results: [],
          errors: [],
        };
        results.forEach((r, i) => {
          if (r.status === "fulfilled") {
            combined.results.push(r.value);
          } else {
            combined.errors.push({
              source: targetPlatforms[i].name,
              error: r.reason?.message ?? String(r.reason),
            });
          }
        });

        return {
          content: [{ type: "text", text: JSON.stringify(combined, null, 2) }],
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

    // === search_recent — daily digest helper ===
    this.server.tool(
      "search_recent",
      "Search for recent articles across platforms. Designed for daily digest workflows. " +
        "Searches OpenAlex, CrossRef, and Semantic Scholar with date filtering, optional journal scoping, " +
        "and deduplication. Returns results sorted by date.",
      {
        query: z.string().describe("Search terms, e.g. 'social impact of artificial intelligence'"),
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
          .enum(["date", "citations"])
          .default("date")
          .describe("Sort by publication date or citation count"),
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

        const errors: { source: string; error: string }[] = [];
        const allPapers: Paper[] = [];
        results.forEach((r, i) => {
          if (r.status === "fulfilled") {
            allPapers.push(...r.value.papers);
          } else {
            errors.push({
              source: searchLabels[i],
              error: r.reason?.message ?? String(r.reason),
            });
          }
        });

        const deduplicated = deduplicateByDoi(allPapers);

        // Sort
        if (params.sort === "citations") {
          deduplicated.sort((a, b) => b.citations - a.citations);
        } else {
          deduplicated.sort(
            (a, b) =>
              new Date(b.published_date).getTime() -
              new Date(a.published_date).getTime()
          );
        }

        const output = {
          query: params.query,
          date_range: { from: fromStr, to: toStr },
          journals_filter: params.journals ?? null,
          total: deduplicated.length,
          papers: deduplicated.slice(0, params.max_results),
          ...(errors.length > 0 ? { errors } : {}),
        };
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
        JSON.stringify({ name: "paper-search", version: "0.1.0", status: "ok" }),
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
