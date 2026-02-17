import { XMLParser } from "fast-xml-parser";
import type { PlatformSource, Paper, SearchResult, SearchParams } from "./types.js";

const API_URL = "http://export.arxiv.org/api/query";

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "@_",
  isArray: (_name: string) =>
    _name === "entry" || _name === "author" || _name === "link" || _name === "category",
});

function parsePaper(entry: any): Paper {
  const idUrl: string = entry.id ?? "";
  const paper_id = idUrl.split("/abs/").pop()?.replace(/v\d+$/, "") ?? "";

  const links: any[] = entry.link ?? [];
  let pdf_url = `https://arxiv.org/pdf/${paper_id}.pdf`;
  for (const link of links) {
    if (link["@_type"] === "application/pdf") {
      pdf_url = link["@_href"] ?? pdf_url;
      break;
    }
  }

  const authors = (entry.author ?? []).map((a: any) =>
    typeof a === "string" ? a : a.name ?? ""
  );

  const categories = (entry.category ?? []).map((c: any) =>
    typeof c === "string" ? c : c["@_term"] ?? ""
  );

  return {
    paper_id,
    title: (entry.title ?? "").replace(/\s+/g, " ").trim(),
    authors,
    abstract: (entry.summary ?? "").replace(/\s+/g, " ").trim(),
    doi:
      typeof entry["arxiv:doi"] === "string"
        ? entry["arxiv:doi"]
        : entry["arxiv:doi"]?.["#text"] ?? "",
    url: idUrl,
    pdf_url,
    published_date: entry.published ?? "",
    source: "arxiv",
    citations: 0,
    categories,
    keywords: [],
  };
}

export const arxiv: PlatformSource = {
  name: "arxiv",
  displayName: "arXiv",

  async search(params: SearchParams, _env: Env): Promise<SearchResult> {
    const maxResults = Math.min(params.max_results ?? 10, 50);
    const sortBy = (params.sort_by as string) ?? "submittedDate";
    const sortOrder = (params.sort_order as string) ?? "descending";

    const sp = new URLSearchParams({
      search_query: params.query,
      max_results: String(maxResults),
      sortBy,
      sortOrder,
    });

    const url = `${API_URL}?${sp}`;
    const resp = await fetch(url);
    if (!resp.ok) {
      throw new Error(`arXiv API ${resp.status}: ${await resp.text()}`);
    }

    const xml = await resp.text();
    const parsed = parser.parse(xml);
    const feed = parsed.feed ?? parsed;
    const entries: any[] = feed.entry ?? [];

    const papers = entries.map(parsePaper);
    const totalStr =
      feed["opensearch:totalResults"]?.["#text"] ??
      feed["opensearch:totalResults"] ??
      undefined;
    const total = totalStr !== undefined ? parseInt(String(totalStr), 10) : undefined;

    return {
      papers,
      total_results: total,
      query: params.query,
      source: "arxiv",
    };
  },
};
