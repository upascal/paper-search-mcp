import { fetchWithRetry } from "./fetch-utils.js";
import type { PlatformSource, Paper, SearchResult, SearchParams } from "./types.js";

const BASE_URL = "https://api.crossref.org";

function buildHeaders(env: Env): Record<string, string> {
  const email = env.CONTACT_EMAIL ?? "paper-search-mcp@users.noreply.github.com";
  return {
    "User-Agent": `paper-search-mcp/0.1.0 (mailto:${email})`,
  };
}

function parseDateParts(item: any): string {
  const parts =
    item.published?.["date-parts"]?.[0] ??
    item.issued?.["date-parts"]?.[0] ??
    item.created?.["date-parts"]?.[0] ??
    [];
  if (parts.length === 0) return "";
  const y = parts[0];
  const m = String(parts[1] ?? 1).padStart(2, "0");
  const d = String(parts[2] ?? 1).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

function parsePaper(item: any): Paper {
  const authors = (item.author ?? []).map((a: any) =>
    [a.given, a.family].filter(Boolean).join(" ")
  );

  let pdf_url = "";
  if (item.resource?.primary?.URL) pdf_url = item.resource.primary.URL;
  if (!pdf_url) {
    const pdfLink = (item.link ?? []).find(
      (l: any) => l["content-type"]?.includes("pdf")
    );
    if (pdfLink) pdf_url = pdfLink.URL;
  }

  return {
    paper_id: item.DOI ?? "",
    title: Array.isArray(item.title) ? item.title[0] ?? "" : item.title ?? "",
    authors,
    abstract: (item.abstract ?? "").replace(/<[^>]*>/g, ""),
    doi: item.DOI ?? "",
    url: item.URL ?? "",
    pdf_url,
    published_date: parseDateParts(item),
    source: "crossref",
    citations: item["is-referenced-by-count"] ?? 0,
    categories: item.type ? [item.type] : [],
    keywords: item.subject ?? [],
    extra: {
      publisher: item.publisher,
      container_title: item["container-title"]?.[0],
      volume: item.volume,
      issue: item.issue,
      page: item.page,
    },
  };
}

export const crossref: PlatformSource = {
  name: "crossref",
  displayName: "CrossRef",

  async search(params: SearchParams, env: Env): Promise<SearchResult> {
    const rows = Math.min(params.max_results ?? 10, 100);
    const sp = new URLSearchParams({ rows: String(rows) });

    // Field-specific queries are far more precise than the generic `query`.
    // Use query.title / query.author when provided, fall back to generic query.
    if (params.query_title) {
      sp.set("query.title", String(params.query_title));
    }
    if (params.query_author) {
      sp.set("query.author", String(params.query_author));
    }
    if (!params.query_title && !params.query_author) {
      // Use query.bibliographic instead of generic query — it searches
      // title + author + abstract (not publisher/funder/etc.), reducing noise.
      sp.set("query.bibliographic", params.query);
    }

    if (params.sort) sp.set("sort", String(params.sort));
    if (params.order) sp.set("order", String(params.order));

    // Build filter parts
    const filterParts: string[] = [];

    // Preserve raw filter string if provided
    if (params.filter) {
      filterParts.push(String(params.filter));
    }

    // Add convenience date filters
    if (params.from_date) {
      filterParts.push(`from-pub-date:${params.from_date}`);
    }
    if (params.to_date) {
      filterParts.push(`until-pub-date:${params.to_date}`);
    }

    // Add journal ISSN filter
    if (params.journal_issn) {
      filterParts.push(`issn:${params.journal_issn}`);
    }

    // Add type filter (default to journal-article to reduce noise)
    if (params.type) {
      filterParts.push(`type:${params.type}`);
    } else if (!params.filter) {
      // Default to journal articles when no explicit filter/type is set
      filterParts.push("type:journal-article");
    }

    if (filterParts.length > 0) {
      sp.set("filter", filterParts.join(","));
    }

    // Only request fields we actually use, for efficiency
    sp.set(
      "select",
      "DOI,title,author,abstract,URL,published,issued,created,is-referenced-by-count,type,subject,publisher,container-title,volume,issue,page,resource,link"
    );

    const email = env.CONTACT_EMAIL ?? "paper-search-mcp@users.noreply.github.com";
    sp.set("mailto", email);

    const url = `${BASE_URL}/works?${sp}`;
    const resp = await fetchWithRetry(url, { headers: buildHeaders(env) });
    if (!resp.ok) {
      throw new Error(`CrossRef API ${resp.status}: ${await resp.text()}`);
    }

    const json = (await resp.json()) as any;
    const items = json.message?.items ?? [];
    const papers = items.map(parsePaper);
    return {
      papers,
      total_results: json.message?.["total-results"],
      query: params.query,
      source: "crossref",
    };
  },

  async getById(doi: string, env: Env): Promise<Paper | null> {
    const url = `${BASE_URL}/works/${encodeURIComponent(doi)}`;
    const resp = await fetchWithRetry(url, { headers: buildHeaders(env) });
    if (resp.status === 404) return null;
    if (!resp.ok) {
      throw new Error(`CrossRef API ${resp.status}: ${await resp.text()}`);
    }
    const json = (await resp.json()) as any;
    return parsePaper(json.message);
  },
};
