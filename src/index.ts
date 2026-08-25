/**
 * Paper Search MCP Server (mcp-deploy compatible)
 *
 * 6 composable tools for academic paper search:
 *   search_papers          — core multi-query search with RRF fusion
 *   discover_recent_papers — find noteworthy new research (age-adaptive scoring)
 *   rerank_papers          — deep quality scoring on specific papers
 *   find_similar_papers    — ML recommendations from seed papers (S2)
 *   get_paper              — look up a single paper by any ID type
 *   get_citation_graph          — citation graph traversal (forward/backward)
 *
 * Core platforms (always on): Semantic Scholar, CrossRef, OpenAlex
 * Optional platforms (ENABLED_PLATFORMS env var): arxiv, pubmed, biorxiv, medrxiv
 *
 * Auth is handled by mcp-deploy's wrapper — this worker contains NO auth logic.
 */

import { McpAgent } from "agents/mcp";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerTools } from "./tools.js";

// ---------------------------------------------------------------------------
// MCP Agent — Durable Object
// ---------------------------------------------------------------------------

export class PaperSearchMCP extends McpAgent<Env> {
  server = new McpServer(
    { name: "paper-search", version: "0.3.3" },
    {
      capabilities: { logging: {} },
      instructions: `Paper Search MCP — multi-platform academic paper discovery.

Strategy for best results:
1. DECOMPOSE the query into independent concepts/facets before searching.
   Example: "post-hoc hallucination detection at token and sentence level in neural generation"
   → facets: "hallucination detection", "token-level", "sentence-level", "neural sequence generation"
2. EXPAND each facet into search terms: canonical names, acronyms, synonyms, related methods.
   Example: "Word Mover's Distance for sentences" → ["Sentence Mover's Distance", "WMD sentence similarity", "optimal transport document distance"]
3. Pass 3-5 decomposed+expanded search terms to search_papers (NOT the raw user question).
   Short, specific queries (2-5 words) work better than long natural-language sentences.
4. When you find a highly relevant paper, pivot:
   - get_citation_graph direction="references" → foundational work it builds on
   - get_citation_graph direction="citations" → follow-up work building on it
   - find_similar_papers → related work via ML embeddings
5. For specific method/dataset queries, find the canonical paper first, then walk its citation graph.
6. Use get_paper to fetch full details (TLDR, fields of study, author metrics) for papers of interest.
7. Prefer broader searches (per_platform 15-20) over narrow ones for better recall.`,
    }
  );

  async init() {
    registerTools(this.server, this.env);
  }
}

// ---------------------------------------------------------------------------
// Worker fetch handler — clean, no auth (mcp-deploy handles auth)
// ---------------------------------------------------------------------------

export default {
  fetch(request: Request, env: Env, ctx: ExecutionContext) {
    const url = new URL(request.url);

    if (url.pathname === "/") {
      return new Response(
        JSON.stringify({ name: "paper-search", version: "0.3.3", status: "ok" }),
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
