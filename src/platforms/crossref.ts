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
    const sp = new URLSearchParams({
      query: params.query,
      rows: String(rows),
    });
    if (params.sort) sp.set("sort", String(params.sort));
    if (params.order) sp.set("order", String(params.order));
    if (params.filter) sp.set("filter", String(params.filter));

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
