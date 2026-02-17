/**
 * Paper Search MCP Server (mcp-deploy compatible)
 *
 * A remote academic paper search tool using the Cloudflare Agents SDK.
 * Supports Semantic Scholar, CrossRef, arXiv, PubMed, bioRxiv, and medRxiv.
 *
 * Platforms are toggled via ENABLED_PLATFORMS env var (comma-separated).
 * Default: semantic_scholar,crossref,arxiv
 *
 * Auth is handled by mcp-deploy's wrapper — this worker contains NO auth logic.
 */

import { McpAgent } from "agents/mcp";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { getEnabledPlatforms, getAllPlatformNames } from "./registry.js";
import type { PlatformSource } from "./platforms/types.js";

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
          "CrossRef filter, e.g. 'from-pub-date:2024,type:journal-article'"
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
      return "Search academic metadata on CrossRef. Covers 150M+ records across all disciplines. Returns DOIs, citation counts, journal info. Supports filters by date, type, ISSN.";
    case "arxiv":
      return "Search preprints on arXiv. Covers CS, math, physics, quantitative biology, and more. Supports arXiv query syntax: ti: (title), au: (author), abs: (abstract), cat: (category).";
    case "pubmed":
      return "Search biomedical literature on PubMed/MEDLINE via NCBI E-utilities. Supports MeSH terms and field tags: [ti] (title), [au] (author), [mh] (MeSH heading).";
    case "biorxiv":
      return "Browse recent preprints on bioRxiv. Note: bioRxiv API is date-range based — your query filters results client-side by title/abstract/author text matching.";
    case "medrxiv":
      return "Browse recent preprints on medRxiv. Note: medRxiv API is date-range based — your query filters results client-side by title/abstract/author text matching.";
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
            "Use platform-specific tools for advanced filtering (year, category, DOI lookup)",
            "Semantic Scholar is best for CS and social science — has citation counts and field-of-study tags",
            "CrossRef is best for DOI lookups and finding exact journal metadata",
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
  }
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
