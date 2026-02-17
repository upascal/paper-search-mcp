import { readFileSync } from "node:fs";
import { resolve } from "node:path";

function loadDevVars(): Record<string, string> {
  try {
    const path = resolve(__dirname, "../../.dev.vars");
    const content = readFileSync(path, "utf-8");
    const vars: Record<string, string> = {};
    for (const line of content.split("\n")) {
      const match = line.match(/^(\w+)=(.+)$/);
      if (match) vars[match[1]] = match[2].trim();
    }
    return vars;
  } catch {
    return {};
  }
}

export const vars = loadDevVars();

export const mockEnv: Env = {
  ENABLED_PLATFORMS: "semantic_scholar,crossref,arxiv,pubmed,biorxiv,medrxiv",
  SEMANTIC_SCHOLAR_API_KEY: vars.SEMANTIC_SCHOLAR_API_KEY,
  PUBMED_API_KEY: vars.PUBMED_API_KEY,
  CONTACT_EMAIL: vars.CONTACT_EMAIL ?? "test@example.com",
  MCP_OBJECT: {} as any,
};
