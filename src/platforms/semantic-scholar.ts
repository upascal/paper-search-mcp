import { fetchWithRetry } from "./fetch-utils.js";
import type { PlatformSource, Paper, SearchResult, SearchParams } from "./types.js";

const BASE_URL = "https://api.semanticscholar.org/graph/v1";
const FIELDS =
  "title,abstract,year,citationCount,authors,url,publicationDate,externalIds,fieldsOfStudy,openAccessPdf";

function headers(env: Env): Record<string, string> {
  const h: Record<string, string> = {};
  if (env.SEMANTIC_SCHOLAR_API_KEY) h["x-api-key"] = env.SEMANTIC_SCHOLAR_API_KEY;
  return h;
}

function parsePaper(raw: any): Paper {
  return {
    paper_id: raw.paperId ?? "",
    title: raw.title ?? "",
    authors: (raw.authors ?? []).map((a: any) => a.name ?? ""),
    abstract: raw.abstract ?? "",
    doi: raw.externalIds?.DOI ?? "",
    url: raw.url ?? "",
    pdf_url: raw.openAccessPdf?.url ?? "",
    published_date: raw.publicationDate ?? "",
    source: "semantic_scholar",
    citations: raw.citationCount ?? 0,
    categories: raw.fieldsOfStudy ?? [],
    keywords: [],
    extra: { externalIds: raw.externalIds },
  };
}

export const semanticScholar: PlatformSource = {
  name: "semantic_scholar",
  displayName: "Semantic Scholar",

  async search(params: SearchParams, env: Env): Promise<SearchResult> {
    const limit = Math.min(params.max_results ?? 10, 100);
    const sp = new URLSearchParams({
      query: params.query,
      limit: String(limit),
      fields: FIELDS,
    });
    if (params.year) sp.set("year", String(params.year));

    const url = `${BASE_URL}/paper/search?${sp}`;
    const resp = await fetchWithRetry(url, { headers: headers(env) });
    if (!resp.ok) {
      throw new Error(`Semantic Scholar API ${resp.status}: ${await resp.text()}`);
    }

    const json = (await resp.json()) as any;
    const papers = (json.data ?? []).map(parsePaper);
    return {
      papers,
      total_results: json.total,
      query: params.query,
      source: "semantic_scholar",
    };
  },

  async getById(paperId: string, env: Env): Promise<Paper | null> {
    const url = `${BASE_URL}/paper/${encodeURIComponent(paperId)}?fields=${FIELDS}`;
    const resp = await fetchWithRetry(url, { headers: headers(env) });
    if (resp.status === 404) return null;
    if (!resp.ok) {
      throw new Error(`Semantic Scholar API ${resp.status}: ${await resp.text()}`);
    }
    return parsePaper(await resp.json());
  },
};
