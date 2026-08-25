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
 * OpenAlex treats * and ? as wildcards and rejects them in the default
 * stemmed search with a 400 ("Wildcards require exact search") — so a
 * natural-language question mark kills the whole request. Strip them.
 */
function sanitizeQuery(query: string): string {
  return query.replace(/[*?]/g, " ").replace(/\s+/g, " ").trim();
}

function normalizeDoi(id: string): string {
  return id.replace(/^https?:\/\/doi\.org\//i, "").toLowerCase();
}

/**
 * Map a paper identifier to an OpenAlex /works lookup key, or null when
 * OpenAlex cannot resolve that ID space. Accepts W-ids (bare or URL), DOIs
 * (bare, DOI:-prefixed, or doi.org URL), and PMID:-prefixed PubMed ids.
 *
 * Deliberately NOT mapped: arXiv ids via their DataCite DOIs
 * (10.48550/arXiv.*) — OpenAlex's index of those is unreliable (missing for
 * 1706.03762, hijacked by a junk record for 2201.11903, fragmented duplicate
 * for 2005.14165, verified 2026-08). Wrong-paper results are worse than none.
 * Raw S2 hashes and CorpusIds are likewise unresolvable here.
 */
export function toWorksKey(id: string): string | null {
  const bare = id.trim();
  const w = bare.match(/^(?:https?:\/\/openalex\.org\/)?(W\d+)$/i);
  if (w) return w[1].toUpperCase();
  const doi = bare.replace(/^DOI:/i, "").replace(/^https?:\/\/doi\.org\//i, "");
  if (/^10\.\d{4,}\//.test(doi)) return `doi:${doi}`;
  const pmid = bare.match(/^PMID:(\d+)$/i);
  if (pmid) return `pmid:${pmid[1]}`;
  return null;
}

/** Extract the short work ID (W12345) from a bare or URL-form OpenAlex ID. */
function shortWorkId(id: string): string {
  const m = id.match(/W\d+$/i);
  return m ? m[0].toUpperCase() : id.toUpperCase();
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
      openalex_source_id: item.primary_location?.source?.id,
      venue_type: item.primary_location?.source?.type,
      // Field-normalized citation metrics (the good stuff)
      fwci: item.fwci ?? null,
      citation_normalized_percentile:
        item.citation_normalized_percentile?.value ?? null,
      is_top_1_percent:
        item.citation_normalized_percentile?.is_in_top_1_percent ?? false,
      is_top_10_percent:
        item.citation_normalized_percentile?.is_in_top_10_percent ?? false,
      // Topic classification for field context
      primary_topic: item.primary_topic?.display_name ?? null,
      primary_subfield: item.primary_topic?.subfield?.display_name ?? null,
      primary_field: item.primary_topic?.field?.display_name ?? null,
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
  const sp = new URLSearchParams({ search: sanitizeQuery(name), per_page: "1" });
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
  const sp = new URLSearchParams({ search: sanitizeQuery(name), per_page: "1" });
  applyAuth(sp, env);

  const url = `${BASE_URL}/topics?${sp}`;
  const resp = await fetchWithRetry(url, { headers: buildHeaders(env) });
  if (!resp.ok) return null;
  const json = (await resp.json()) as any;
  return json.results?.[0]?.id ?? null;
}

/**
 * Batch-lookup venue quality metrics for a set of OpenAlex source IDs.
 * Returns a map of source_id → { 2yr_mean_citedness, h_index, works_count }.
 * Uses a single API call with pipe-delimited filter.
 */
export async function batchGetVenueQuality(
  sourceIds: string[],
  env: Env
): Promise<Map<string, { citedness_2yr: number; h_index: number; works_count: number }>> {
  const result = new Map<string, { citedness_2yr: number; h_index: number; works_count: number }>();
  if (sourceIds.length === 0) return result;

  // Deduplicate and limit to 50 per batch (OpenAlex filter limit)
  const unique = [...new Set(sourceIds)].slice(0, 50);
  // Extract short IDs (S12345) from full URLs
  const shortIds = unique.map((id) => {
    const match = id.match(/S\d+$/);
    return match ? match[0] : id;
  });

  const sp = new URLSearchParams({
    filter: `ids.openalex:${shortIds.join("|")}`,
    select: "id,summary_stats,works_count,display_name",
    per_page: String(shortIds.length),
  });
  applyAuth(sp, env);

  try {
    const url = `${BASE_URL}/sources?${sp}`;
    const resp = await fetchWithRetry(url, { headers: buildHeaders(env) });
    if (!resp.ok) return result;

    const json = (await resp.json()) as any;
    for (const source of json.results ?? []) {
      result.set(source.id, {
        citedness_2yr: source.summary_stats?.["2yr_mean_citedness"] ?? 0,
        h_index: source.summary_stats?.h_index ?? 0,
        works_count: source.works_count ?? 0,
      });
    }
  } catch {
    // Non-critical enrichment — fail silently
  }

  return result;
}

export const openalex: PlatformSource = {
  name: "openalex",
  displayName: "OpenAlex",

  async search(params: SearchParams, env: Env): Promise<SearchResult> {
    const perPage = Math.min(params.max_results ?? 10, 100);

    const sp = new URLSearchParams({ per_page: String(perPage) });
    applyAuth(sp, env);

    // Always include API key if available (required since Feb 2026)
    if (env.OPENALEX_API_KEY) sp.set("api_key", env.OPENALEX_API_KEY);

    // Search query — use semantic search when requested, otherwise keyword search
    const wantsSemantic = params.semantic === true || params.semantic === "true";
    if (wantsSemantic && env.OPENALEX_API_KEY) {
      // OpenAlex semantic search uses GTE-Large embeddings over 217M works.
      // Requires API key. $0.001/query. Finds conceptually related works
      // even when they use different terminology.
      if (params.query) sp.set("search.semantic", sanitizeQuery(params.query));
    } else {
      // Fall back to keyword search (also used when no API key is set)
      if (params.query) sp.set("search", sanitizeQuery(params.query));
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

  /**
   * Batch lookup by DOI or OpenAlex work ID: one pipe-delimited filter call
   * per 50 IDs (OpenAlex OR-filter limit) instead of a request per paper.
   * IDs OpenAlex cannot resolve (e.g. raw S2 hashes) come back as null.
   * Returns an array aligned with the input.
   */
  async getByIdBatch(ids: string[], env: Env): Promise<(Paper | null)[]> {
    const out: (Paper | null)[] = new Array(ids.length).fill(null);

    // Group input indices by lookup type; anything else stays null
    const doiIdx: number[] = [];
    const workIdx: number[] = [];
    for (let i = 0; i < ids.length; i++) {
      if (/^(https?:\/\/doi\.org\/)?10\./i.test(ids[i])) doiIdx.push(i);
      else if (/^(https?:\/\/openalex\.org\/)?W\d+$/i.test(ids[i])) workIdx.push(i);
    }

    const runChunks = async (
      indices: number[],
      filterKey: string,
      keyOfInput: (id: string) => string,
      keyOfItem: (item: any) => string
    ): Promise<void> => {
      for (let c = 0; c < indices.length; c += 50) {
        const chunk = indices.slice(c, c + 50);
        const keys = chunk.map((i) => keyOfInput(ids[i]));
        const sp = new URLSearchParams({
          filter: `${filterKey}:${keys.join("|")}`,
          per_page: String(chunk.length),
        });
        applyAuth(sp, env);
        try {
          const resp = await fetchWithRetry(`${BASE_URL}/works?${sp}`, {
            headers: buildHeaders(env),
          });
          if (!resp.ok) continue;
          const json = (await resp.json()) as any;
          const byKey = new Map<string, any>();
          for (const item of json.results ?? []) {
            byKey.set(keyOfItem(item), item);
          }
          for (const i of chunk) {
            const item = byKey.get(keyOfInput(ids[i]));
            if (item) out[i] = parsePaper(item);
          }
        } catch {
          // Leave nulls — rerank falls back to the other platform's record
        }
      }
    };

    await runChunks(doiIdx, "doi", normalizeDoi, (item) => normalizeDoi(item.doi ?? ""));
    await runChunks(workIdx, "ids.openalex", shortWorkId, (item) => shortWorkId(item.id ?? ""));

    return out;
  },
};

/** Resolve any works key to a bare W-id (needed by the cites: filter). */
async function resolveWorkId(key: string, env: Env): Promise<string | null> {
  if (/^W\d+$/.test(key)) return key;
  const sp = new URLSearchParams({ select: "id" });
  applyAuth(sp, env);
  const resp = await fetchWithRetry(`${BASE_URL}/works/${encodeURIComponent(key)}?${sp}`, {
    headers: buildHeaders(env),
  });
  if (!resp.ok) return null;
  const json = (await resp.json()) as any;
  const m = (json.id ?? "").match(/W\d+$/);
  return m ? m[0] : null;
}

/**
 * Citation graph via OpenAlex — the fallback when Semantic Scholar is
 * rate-limited, and the only path for OpenAlex-native W-ids.
 *
 * citations:  /works?filter=cites:W...        one call, hydrated results
 * references: referenced_works on the record, hydrated in ≤50-id batches
 *
 * Returns [] when the ID is outside OpenAlex's resolvable space (see
 * toWorksKey) so callers can distinguish "can't answer" from an error.
 */
export async function getOpenAlexCitations(
  paperId: string,
  direction: "citations" | "references",
  env: Env,
  options?: { limit?: number }
): Promise<Paper[]> {
  const limit = options?.limit ?? 20;
  const key = toWorksKey(paperId);
  if (!key) return [];

  if (direction === "citations") {
    const wid = await resolveWorkId(key, env);
    if (!wid) return [];
    const sp = new URLSearchParams({
      filter: `cites:${wid}`,
      sort: "cited_by_count:desc",
      per_page: String(Math.min(limit, 100)),
    });
    applyAuth(sp, env);
    const resp = await fetchWithRetry(`${BASE_URL}/works?${sp}`, { headers: buildHeaders(env) });
    if (!resp.ok) {
      throw new Error(`OpenAlex cites API ${resp.status}: ${await resp.text()}`);
    }
    const json = (await resp.json()) as any;
    return (json.results ?? []).map(parsePaper);
  }

  const sp = new URLSearchParams({ select: "id,referenced_works" });
  applyAuth(sp, env);
  const resp = await fetchWithRetry(`${BASE_URL}/works/${encodeURIComponent(key)}?${sp}`, {
    headers: buildHeaders(env),
  });
  if (resp.status === 404) return [];
  if (!resp.ok) {
    throw new Error(`OpenAlex works API ${resp.status}: ${await resp.text()}`);
  }
  const json = (await resp.json()) as any;
  const refs: string[] = (json.referenced_works ?? []).slice(0, limit);
  if (refs.length === 0) return [];
  const hydrated = await openalex.getByIdBatch!(refs, env);
  return hydrated.filter((p): p is Paper => p !== null);
}

/**
 * Related works via OpenAlex — co-citation/concept based, ~10 fixed per work.
 * Coarser than S2's embedding recommender and no negative steering; used only
 * as the degraded fallback when the recommendations API is rate-limited.
 */
export async function getOpenAlexRelated(
  seedIds: string[],
  env: Env,
  options?: { limit?: number }
): Promise<Paper[]> {
  const limit = options?.limit ?? 20;
  const relatedIds: string[] = [];
  const seen = new Set<string>();

  // related_works is fixed per work, so more seeds = more coverage; cap the
  // extra lookups at 3 seeds to bound latency
  for (const seed of seedIds.slice(0, 3)) {
    const key = toWorksKey(seed);
    if (!key) continue;
    const sp = new URLSearchParams({ select: "id,related_works" });
    applyAuth(sp, env);
    try {
      const resp = await fetchWithRetry(`${BASE_URL}/works/${encodeURIComponent(key)}?${sp}`, {
        headers: buildHeaders(env),
      });
      if (!resp.ok) continue;
      const json = (await resp.json()) as any;
      const selfId = (json.id ?? "").match(/W\d+$/)?.[0];
      if (selfId) seen.add(selfId);
      for (const rw of json.related_works ?? []) {
        const wid = String(rw).match(/W\d+$/)?.[0];
        if (wid && !seen.has(wid)) {
          seen.add(wid);
          relatedIds.push(wid);
        }
      }
    } catch {
      // Seed unresolvable — skip it, other seeds may still produce results
    }
  }

  if (relatedIds.length === 0) return [];
  const hydrated = await openalex.getByIdBatch!(relatedIds.slice(0, limit), env);
  return hydrated.filter((p): p is Paper => p !== null);
}
