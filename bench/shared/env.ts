import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dir = dirname(fileURLToPath(import.meta.url));

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

const vars = loadDevVars();

export const benchEnv: Env = {
  ENABLED_PLATFORMS:
    process.env.ENABLED_PLATFORMS ??
    vars.ENABLED_PLATFORMS ??
    "semantic_scholar,crossref,arxiv,openalex",
  SEMANTIC_SCHOLAR_API_KEY:
    process.env.SEMANTIC_SCHOLAR_API_KEY ?? vars.SEMANTIC_SCHOLAR_API_KEY,
  OPENALEX_API_KEY:
    process.env.OPENALEX_API_KEY ?? vars.OPENALEX_API_KEY,
  PUBMED_API_KEY:
    process.env.PUBMED_API_KEY ?? vars.PUBMED_API_KEY,
  CONTACT_EMAIL:
    process.env.CONTACT_EMAIL ?? vars.CONTACT_EMAIL ?? "bench@paper-search-mcp",
  MCP_OBJECT: {} as any,
};
