/**
 * Agentic LitSearch benchmark runner.
 *
 * Uses the Claude Agent SDK to test the MCP in a realistic agentic loop:
 * an LLM decides which tools to call, how to phrase queries, and whether
 * to follow up with additional searches or recommendations.
 *
 * Each query gets a fresh, stateless session — no memory carries over.
 * The MCP server runs as a stdio subprocess (bench/agentic/stdio-server.ts),
 * so it tests the exact same tools as the Cloudflare Worker.
 *
 * Usage:
 *   npx tsx bench/agentic/run.ts                          # full run (597 queries)
 *   npx tsx bench/agentic/run.ts --limit 10               # first 10 queries
 *   npx tsx bench/agentic/run.ts --model haiku             # cheaper model
 *   npx tsx bench/agentic/run.ts --max-turns 3             # limit agent turns
 *   npx tsx bench/agentic/run.ts --platforms semantic_scholar,openalex
 */

import { query } from "@anthropic-ai/claude-agent-sdk";
import { readFileSync, appendFileSync, existsSync, mkdirSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { IdMapper } from "../litsearch/id-mapper.js";
import type { LitSearchQuery } from "../litsearch/download.js";
import type { BenchmarkResult } from "../shared/types.js";
import type { Paper } from "../../src/platforms/types.js";

const __dir = dirname(fileURLToPath(import.meta.url));
const CACHE_DIR = resolve(__dir, "../litsearch/.cache");
const RESULTS_DIR = resolve(__dir, "../litsearch/results");
const STDIO_SERVER = resolve(__dir, "stdio-server.ts");

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function parseArgs() {
  const args = process.argv.slice(2);
  const opts = {
    limit: Infinity,
    platforms: undefined as string | undefined,
    model: "haiku" as string,
    maxTurns: 12,
    verbose: false,
  };

  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case "--limit":
        opts.limit = parseInt(args[++i], 10);
        break;
      case "--platforms":
        opts.platforms = args[++i];
        break;
      case "--model":
        opts.model = args[++i];
        break;
      case "--max-turns":
        opts.maxTurns = parseInt(args[++i], 10);
        break;
      case "--verbose":
      case "-v":
        opts.verbose = true;
        break;
    }
  }
  return opts;
}

// ---------------------------------------------------------------------------
// Env vars for the stdio server subprocess
// ---------------------------------------------------------------------------

function loadDevVars(): Record<string, string> {
  try {
    const path = resolve(__dir, "../../.dev.vars");
    const content = readFileSync(path, "utf-8");
    const vars: Record<string, string> = {};
    for (const line of content.split("\n")) {
      const match = line.match(/^(\w+)=(.+)$/);
      if (match) vars[match[1]] = match[2].trim().replace(/^["']|["']$/g, "");
    }
    return vars;
  } catch {
    return {};
  }
}

// ---------------------------------------------------------------------------
// System prompt
// ---------------------------------------------------------------------------

const SYSTEM_PROMPT = `You are a research paper search assistant. Find papers relevant to the given query using the available tools. Be thorough — use multiple search strategies, citation walking, and similar-paper recommendations to maximize recall. Do not explain your process, just search and briefly confirm what you found.`;

// ---------------------------------------------------------------------------
// Extract papers from agent message stream
// ---------------------------------------------------------------------------

/**
 * Parse papers from a tool result JSON string.
 * Tool results contain `papers` arrays or a single `paper` object.
 */
function extractPapersFromJson(text: string): Paper[] {
  try {
    const data = JSON.parse(text);
    const papers: Paper[] = [];
    if (Array.isArray(data.papers)) papers.push(...data.papers);
    if (data.paper && typeof data.paper === "object") papers.push(data.paper);
    return papers;
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// Run a single query through the agent
// ---------------------------------------------------------------------------

interface QueryResult {
  mappedIds: number[];
  rawCount: number;
  toolCalls: number;
  latencyMs: number;
  costUsd?: number;
  error?: string;
}

async function runQuery(
  queryText: string,
  mcpServerConfig: Record<string, unknown>,
  mapper: IdMapper,
  opts: { model: string; maxTurns: number; verbose: boolean },
): Promise<QueryResult> {
  const start = Date.now();
  let toolCalls = 0;
  const allPapers: Paper[] = [];

  try {
    let costUsd: number | undefined;

    for await (const message of query({
      prompt: `Find papers relevant to this query:\n\n"${queryText}"`,
      options: {
        systemPrompt: SYSTEM_PROMPT,
        model: opts.model,
        maxTurns: opts.maxTurns,
        tools: [],
        mcpServers: { "paper-search": mcpServerConfig as any },
        permissionMode: "bypassPermissions",
        allowDangerouslySkipPermissions: true,
        persistSession: false,
        cwd: process.cwd(),
      },
    })) {
      // Count tool calls and extract tool results from assistant messages
      if (message.type === "assistant" && message.message?.content) {
        for (const block of message.message.content) {
          if ("type" in block && block.type === "tool_use") {
            toolCalls++;
            if (opts.verbose) {
              const name = "name" in block ? block.name : "unknown";
              console.log(`    [tool] ${name}`);
            }
          }
        }
      }

      // Extract papers from tool result messages (user messages with tool_result)
      if (message.type === "user" && message.message?.content) {
        const content = message.message.content;
        if (Array.isArray(content)) {
          for (const block of content) {
            if (typeof block === "object" && "type" in block && block.type === "tool_result") {
              // tool_result content can be string or array of content blocks
              const resultContent = (block as any).content;
              if (typeof resultContent === "string") {
                allPapers.push(...extractPapersFromJson(resultContent));
              } else if (Array.isArray(resultContent)) {
                for (const sub of resultContent) {
                  if (sub.type === "text" && typeof sub.text === "string") {
                    allPapers.push(...extractPapersFromJson(sub.text));
                  }
                }
              }
            }
          }
        }
      }

      // Capture cost from result
      if (message.type === "result") {
        costUsd = (message as any).total_cost_usd;
        if (message.subtype !== "success") {
          const errors = "errors" in message ? (message.errors as string[]) : [];
          return {
            mappedIds: [],
            rawCount: 0,
            toolCalls,
            latencyMs: Date.now() - start,
            costUsd,
            error: errors.join(", ") || "Agent session failed",
          };
        }
      }
    }

    const mappedIds = mapper.mapResults(allPapers);

    return {
      mappedIds,
      rawCount: allPapers.length,
      toolCalls,
      latencyMs: Date.now() - start,
      costUsd,
    };
  } catch (err: any) {
    return {
      mappedIds: [],
      rawCount: 0,
      toolCalls,
      latencyMs: Date.now() - start,
      error: err.message,
    };
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const opts = parseArgs();

  // Load benchmark data
  if (!existsSync(resolve(CACHE_DIR, "queries.json"))) {
    console.error("Dataset not downloaded. Run: npx tsx bench/litsearch/download.ts");
    process.exit(1);
  }
  if (!existsSync(resolve(CACHE_DIR, "id-map.json"))) {
    console.error("ID map not built. Run: npx tsx bench/litsearch/download.ts");
    process.exit(1);
  }

  const queries: LitSearchQuery[] = JSON.parse(
    readFileSync(resolve(CACHE_DIR, "queries.json"), "utf-8"),
  );
  const mapper = new IdMapper();

  // Build env vars for the stdio server subprocess
  const devVars = loadDevVars();
  const serverEnv: Record<string, string> = {
    ...(process.env as Record<string, string>),
  };
  // Pass API keys and config to the subprocess
  if (devVars.SEMANTIC_SCHOLAR_API_KEY) serverEnv.SEMANTIC_SCHOLAR_API_KEY = devVars.SEMANTIC_SCHOLAR_API_KEY;
  if (devVars.OPENALEX_API_KEY) serverEnv.OPENALEX_API_KEY = devVars.OPENALEX_API_KEY;
  if (devVars.PUBMED_API_KEY) serverEnv.PUBMED_API_KEY = devVars.PUBMED_API_KEY;
  if (devVars.CONTACT_EMAIL) serverEnv.CONTACT_EMAIL = devVars.CONTACT_EMAIL;
  if (opts.platforms) serverEnv.ENABLED_PLATFORMS = opts.platforms;
  else if (devVars.ENABLED_PLATFORMS) serverEnv.ENABLED_PLATFORMS = devVars.ENABLED_PLATFORMS;

  // MCP server config — Agent SDK spawns this as a stdio subprocess
  const mcpServerConfig = {
    type: "stdio" as const,
    command: "npx",
    args: ["tsx", STDIO_SERVER],
    env: serverEnv,
  };

  const toRun = queries.slice(0, opts.limit);

  // Output file
  mkdirSync(RESULTS_DIR, { recursive: true });
  const timestamp = new Date().toISOString().slice(0, 10);
  const platformTag = opts.platforms ?? "default";
  const outFile = resolve(RESULTS_DIR, `agentic-${timestamp}-${opts.model}-${platformTag}.jsonl`);

  // Resume support
  const completed = new Set<string>();
  if (existsSync(outFile)) {
    const lines = readFileSync(outFile, "utf-8").trim().split("\n").filter(Boolean);
    for (const line of lines) {
      const r: BenchmarkResult = JSON.parse(line);
      completed.add(r.query_id);
    }
    console.log(`Resuming: ${completed.size} queries already done`);
  }

  console.log(`Model: ${opts.model}`);
  console.log(`Max turns: ${opts.maxTurns}`);
  console.log(`Queries: ${toRun.length}`);
  console.log(`ID mapper: ${mapper.stats.total} papers, ${mapper.stats.withDoi} with DOI`);
  console.log(`MCP server: ${STDIO_SERVER}`);
  console.log(`Output: ${outFile}\n`);

  let done = completed.size;
  const total = toRun.length;
  let errors = 0;
  let totalCost = 0;

  for (const q of toRun) {
    if (completed.has(q.query_id)) continue;

    const result = await runQuery(q.query_text, mcpServerConfig, mapper, {
      model: opts.model,
      maxTurns: opts.maxTurns,
      verbose: opts.verbose,
    });

    if (result.costUsd) totalCost += result.costUsd;

    if (result.error) {
      errors++;
      console.error(`[${done + 1}/${total}] ${q.query_id}: ERROR — ${result.error}`);
    } else {
      const gt = new Set(q.corpus_ids.map(String));
      const hits = result.mappedIds.filter((id) => gt.has(String(id))).length;
      const r5 = result.mappedIds.slice(0, 5).filter((id) => gt.has(String(id))).length;

      const benchResult: BenchmarkResult = {
        query_id: q.query_id,
        result_ids: result.mappedIds.map(String),
        raw_result_count: result.rawCount,
        latency_ms: result.latencyMs,
        platforms_responded: [],
        platform_counts: { tool_calls: result.toolCalls },
      };

      appendFileSync(outFile, JSON.stringify(benchResult) + "\n");

      console.log(
        `[${done + 1}/${total}] ${q.query_id}: ` +
          `${result.rawCount} results, ${result.mappedIds.length} mapped, ` +
          `${hits}/${q.corpus_ids.length} hits, ` +
          `r@5=${r5}, ${result.toolCalls} tools ` +
          `(${result.latencyMs}ms${result.costUsd ? `, $${result.costUsd.toFixed(4)}` : ""})`,
      );
    }

    done++;
  }

  console.log(`\nDone! ${done} queries, ${errors} errors`);
  if (totalCost > 0) console.log(`Total cost: $${totalCost.toFixed(4)}`);
  console.log(`Results: ${outFile}`);
  console.log(`\nEvaluate: npx tsx bench/litsearch/evaluate.ts ${outFile}`);
}

main().catch((err) => {
  console.error("Agentic benchmark failed:", err);
  process.exit(1);
});
