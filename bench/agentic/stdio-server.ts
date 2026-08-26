/**
 * Stdio MCP adapter for agentic benchmarking.
 *
 * Runs the exact same tools as the Cloudflare Worker, but over stdio
 * so the Claude Agent SDK can spawn and connect to it directly.
 *
 * Usage (standalone):   npx tsx bench/agentic/stdio-server.ts
 * Usage (via Agent SDK): spawned automatically by the bench runner
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { registerTools } from "../../src/tools.js";
import { benchEnv } from "../shared/env.js";

const server = new McpServer(
  { name: "paper-search", version: "0.3.0" },
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
  },
);

registerTools(server, benchEnv);

const transport = new StdioServerTransport();
await server.connect(transport);
