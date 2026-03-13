import { fetchWithRetry } from "./fetch-utils.js";
import type { PlatformSource, Paper, SearchResult, SearchParams } from "./types.js";

const BASE_URL = "https://api.semanticscholar.org/graph/v1";
const RECOMMENDATIONS_URL = "https://api.semanticscholar.org/recommendations/v1";

// Include tldr, s2FieldsOfStudy, and author-level metrics for discovery signals
const FIELDS =
  "title,abstract,year,citationCount,influentialCitationCount,authors,authors.hIndex,authors.citationCount,authors.paperCount,url,publicationDate,externalIds,fieldsOfStudy,s2FieldsOfStudy,openAccessPdf,tldr,publicationVenue";

// Bulk search fields (nested author fields also work in bulk)
const BULK_FIELDS =
  "title,abstract,year,citationCount,influentialCitationCount,authors,authors.hIndex,authors.citationCount,authors.paperCount,url,publicationDate,externalIds,fieldsOfStudy,s2FieldsOfStudy,openAccessPdf,tldr,publicationVenue";

function headers(env: Env): Record<string, string> {
  const h: Record<string, string> = {};
  if (env.SEMANTIC_SCHOLAR_API_KEY) h["x-api-key"] = env.SEMANTIC_SCHOLAR_API_KEY;
  return h;
}

function parsePaper(raw: any): Paper {
  // Extract s2 field-of-study with sources for richer categorization
  const categories = raw.s2FieldsOfStudy
    ? raw.s2FieldsOfStudy.map((f: any) => f.category ?? "")
    : raw.fieldsOfStudy ?? [];

  // Extract author-level metrics for discovery signals
  const authorHIndices: number[] = [];
  for (const a of raw.authors ?? []) {
    if (a.hIndex != null) authorHIndices.push(a.hIndex);
  }

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
    categories,
    keywords: [],
    extra: {
      externalIds: raw.externalIds,
      influentialCitationCount: raw.influentialCitationCount,
      tldr: raw.tldr?.text ?? null,
      author_h_indices: authorHIndices.length > 0 ? authorHIndices : undefined,
      venue: raw.publicationVenue?.name ?? undefined,
      venue_type: raw.publicationVenue?.type ?? undefined,
    },
  };
}

export const semanticScholar: PlatformSource = {
  name: "semantic_scholar",
  displayName: "Semantic Scholar",

  async search(params: SearchParams, env: Env): Promise<SearchResult> {
    // Use bulk search when Boolean syntax is detected or explicitly requested
    const useBulk = params.bulk === true || params.bulk === "true";

    if (useBulk) {
      return bulkSearch(params, env);
    }

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

/**
 * Bulk search endpoint: supports Boolean syntax, sorting, and up to 1000 results per page.
 * Boolean operators: + (required), - (excluded), | (OR), "exact phrase"
 * Example: +"artificial intelligence" +society -"computer vision"
 */
async function bulkSearch(params: SearchParams, env: Env): Promise<SearchResult> {
  const limit = Math.min(params.max_results ?? 10, 1000);
  const sp = new URLSearchParams({
    query: params.query,
    fields: BULK_FIELDS,
  });
  if (params.year) sp.set("year", String(params.year));
  if (params.sort) {
    // bulk supports: citationCount:asc, citationCount:desc, publicationDate:asc, publicationDate:desc
    sp.set("sort", String(params.sort));
  }

  const url = `${BASE_URL}/paper/search/bulk?${sp}`;
  const resp = await fetchWithRetry(url, { headers: headers(env) });
  if (!resp.ok) {
    throw new Error(`Semantic Scholar Bulk API ${resp.status}: ${await resp.text()}`);
  }

  const json = (await resp.json()) as any;
  const allPapers = (json.data ?? []).map(parsePaper);
  // Bulk returns up to 1000, but respect max_results
  const papers = allPapers.slice(0, limit);
  return {
    papers,
    total_results: json.total,
    query: params.query,
    source: "semantic_scholar",
  };
}

/**
 * Recommendations API: given seed paper IDs, find similar papers.
 * POST https://api.semanticscholar.org/recommendations/v1/papers
 */
export async function getRecommendations(
  positivePaperIds: string[],
  negativePaperIds: string[],
  env: Env,
  options?: { limit?: number; fields?: string }
): Promise<Paper[]> {
  const limit = options?.limit ?? 20;
  const fields = options?.fields ?? FIELDS;

  const sp = new URLSearchParams({
    fields,
    limit: String(limit),
  });

  const url = `${RECOMMENDATIONS_URL}/papers?${sp}`;
  const resp = await fetchWithRetry(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...headers(env),
    },
    body: JSON.stringify({
      positivePaperIds,
      negativePaperIds,
    }),
  });

  if (!resp.ok) {
    throw new Error(`S2 Recommendations API ${resp.status}: ${await resp.text()}`);
  }

  const json = (await resp.json()) as any;
  return (json.recommendedPapers ?? []).map(parsePaper);
}
