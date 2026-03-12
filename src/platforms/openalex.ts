import { fetchWithRetry } from "./fetch-utils.js";
import type {
  PlatformSource,
  Paper,
  SearchResult,
  SearchParams,
} from "./types.js";

const BASE_URL = "https://api.openalex.org";

function buildHeaders(env: Env): Record<string, string> {
  const h: Record<string, string> = {
    Accept: "application/json",
  };
  const email =
    env.CONTACT_EMAIL ?? "paper-search-mcp@users.noreply.github.com";
  // OpenAlex "polite pool" — faster rate limits when you identify yourself
  h["User-Agent"] = `paper-search-mcp/0.1.0 (mailto:${email})`;
  return h;
}

/** Add common query params (mailto, api_key) to a URLSearchParams. */
function applyAuth(sp: URLSearchParams, env: Env): void {
  if (env.CONTACT_EMAIL) sp.set("mailto", env.CONTACT_EMAIL);
  if (env.OPENALEX_API_KEY) sp.set("api_key", env.OPENALEX_API_KEY);
}

/**
 * OpenAlex stores abstracts as inverted indexes: { "word": [pos1, pos2], ... }
 * This reconstructs the plain-text abstract.
 */
function reconstructAbstract(
  invertedIndex: Record<string, number[]> | null | undefined
): string {
  if (!invertedIndex) return "";
  const words: [number, string][] = [];
  for (const [word, positions] of Object.entries(invertedIndex)) {
    for (const pos of positions) {
      words.push([pos, word]);
    }
  }
  words.sort((a, b) => a[0] - b[0]);
  return words.map((w) => w[1]).join(" ");
}

function parsePaper(item: any): Paper {
  const authors = (item.authorships ?? []).map(
    (a: any) => a.author?.display_name ?? ""
  );

  const doi = (item.doi ?? "").replace("https://doi.org/", "");
  const pdfUrl =
    item.open_access?.oa_url ??
    item.best_oa_location?.pdf_url ??
    "";

  return {
    paper_id: item.id ?? "",
    title: item.display_name ?? item.title ?? "",
    authors,
    abstract: reconstructAbstract(item.abstract_inverted_index),
    doi,
    url: item.doi ?? item.id ?? "",
    pdf_url: pdfUrl,
    published_date: item.publication_date ?? "",
    source: "openalex",
    citations: item.cited_by_count ?? 0,
    categories: (item.topics ?? []).map((t: any) => t.display_name),
    keywords: (item.keywords ?? []).map((k: any) =>
      typeof k === "string" ? k : k.display_name ?? k.keyword ?? ""
    ),
    extra: {
      journal: item.primary_location?.source?.display_name,
      journal_issn: item.primary_location?.source?.issn_l,
      volume: item.biblio?.volume,
      issue: item.biblio?.issue,
      type: item.type,
      is_open_access: item.open_access?.is_oa,
      openalex_id: item.id,
    },
  };
}

/**
 * Resolve a journal/source name to an OpenAlex source ID.
 * Returns the source ID (e.g. "S1234567") or null.
 */
export async function resolveSourceId(
  name: string,
  env: Env
): Promise<{ id: string; issn_l: string | null } | null> {
  const sp = new URLSearchParams({ search: name, per_page: "1" });
  applyAuth(sp, env);

  const url = `${BASE_URL}/sources?${sp}`;
  const resp = await fetchWithRetry(url, { headers: buildHeaders(env) });
  if (!resp.ok) return null;
  const json = (await resp.json()) as any;
  const result = json.results?.[0];
  if (!result) return null;
  return { id: result.id, issn_l: result.issn_l ?? null };
}

/**
 * Resolve a topic name to an OpenAlex topic ID.
 */
export async function resolveTopicId(
  name: string,
  env: Env
): Promise<string | null> {
  const sp = new URLSearchParams({ search: name, per_page: "1" });
  applyAuth(sp, env);

  const url = `${BASE_URL}/topics?${sp}`;
  const resp = await fetchWithRetry(url, { headers: buildHeaders(env) });
  if (!resp.ok) return null;
  const json = (await resp.json()) as any;
  return json.results?.[0]?.id ?? null;
}

export const openalex: PlatformSource = {
  name: "openalex",
  displayName: "OpenAlex",

  async search(params: SearchParams, env: Env): Promise<SearchResult> {
    const perPage = Math.min(params.max_results ?? 10, 100);

    const sp = new URLSearchParams({ per_page: String(perPage) });
    applyAuth(sp, env);

    // Search query — use semantic search when requested, otherwise keyword search
    if (params.semantic === true || params.semantic === "true") {
      // OpenAlex semantic search uses GTE-Large embeddings over 217M works.
      // Requires API key. $0.001/query. Finds conceptually related works
      // even when they use different terminology.
      if (params.query) sp.set("search.semantic", params.query);
      if (env.OPENALEX_API_KEY) sp.set("api_key", env.OPENALEX_API_KEY);
    } else {
      if (params.query) sp.set("search", params.query);
    }

    // Build filter parts
    const filters: string[] = [];

    // Date range
    if (params.from_date) {
      filters.push(`from_publication_date:${params.from_date}`);
    }
    if (params.to_date) {
      filters.push(`to_publication_date:${params.to_date}`);
    }

    // Source/journal filter — by ISSN or by name (resolved to ID)
    if (params.source) {
      const source = String(params.source);
      const issnRegex = /^\d{4}-\d{3}[\dXx]$/;
      if (issnRegex.test(source)) {
        filters.push(`primary_location.source.issn:${source}`);
      } else {
        const resolved = await resolveSourceId(source, env);
        if (resolved) {
          filters.push(`primary_location.source.id:${resolved.id}`);
        }
      }
    }

    // Topic filter
    if (params.topic) {
      const topicId = await resolveTopicId(String(params.topic), env);
      if (topicId) {
        filters.push(`topics.id:${topicId}`);
      }
    }

    // Open access filter
    if (params.open_access === true || params.open_access === "true") {
      filters.push("is_oa:true");
    }

    // Type filter (default to articles to reduce noise)
    if (params.type) {
      filters.push(`type:${params.type}`);
    }

    if (filters.length > 0) {
      sp.set("filter", filters.join(","));
    }

    // Sort
    const sort = params.sort ?? "relevance_score:desc";
    sp.set("sort", String(sort));

    const url = `${BASE_URL}/works?${sp}`;
    const resp = await fetchWithRetry(url, { headers: buildHeaders(env) });
    if (!resp.ok) {
      throw new Error(`OpenAlex API ${resp.status}: ${await resp.text()}`);
    }

    const json = (await resp.json()) as any;
    const papers = (json.results ?? []).map(parsePaper);
    return {
      papers,
      total_results: json.meta?.count,
      query: params.query,
      source: "openalex",
    };
  },

  async getById(id: string, env: Env): Promise<Paper | null> {
    // Accept DOI or OpenAlex ID
    const isDoi = id.startsWith("10.") || id.includes("/");
    const lookupId = isDoi ? `doi:${id}` : id;

    const sp = new URLSearchParams();
    applyAuth(sp, env);

    const url = `${BASE_URL}/works/${encodeURIComponent(lookupId)}?${sp}`;
    const resp = await fetchWithRetry(url, { headers: buildHeaders(env) });
    if (resp.status === 404) return null;
    if (!resp.ok) {
      throw new Error(`OpenAlex API ${resp.status}: ${await resp.text()}`);
    }
    return parsePaper(await resp.json());
  },
};
