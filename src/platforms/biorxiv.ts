import type { PlatformSource, Paper, SearchResult, SearchParams } from "./types.js";

const BASE_URL = "https://api.biorxiv.org/details";

function parsePaper(
  item: any,
  server: "biorxiv" | "medrxiv",
  domain: string
): Paper {
  const doi = item.doi ?? "";
  const version = item.version ?? 1;
  return {
    paper_id: doi,
    title: item.title ?? "",
    authors: (item.authors ?? "").split("; ").filter(Boolean),
    abstract: item.abstract ?? "",
    doi,
    url: `https://${domain}/content/${doi}v${version}`,
    pdf_url: `https://${domain}/content/${doi}v${version}.full.pdf`,
    published_date: item.date ?? "",
    source: server,
    citations: 0,
    categories: item.category ? [item.category] : [],
    keywords: [],
  };
}

function createBiorxivPlatform(
  server: "biorxiv" | "medrxiv"
): PlatformSource {
  const domain =
    server === "biorxiv" ? "www.biorxiv.org" : "www.medrxiv.org";
  const display = server === "biorxiv" ? "bioRxiv" : "medRxiv";

  return {
    name: server,
    displayName: display,

    async search(params: SearchParams, _env: Env): Promise<SearchResult> {
      const days = (params.days as number) ?? 30;
      const limit = params.max_results ?? 10;

      const end = new Date();
      const start = new Date(end.getTime() - days * 86_400_000);
      const startStr = start.toISOString().slice(0, 10);
      const endStr = end.toISOString().slice(0, 10);

      let url = `${BASE_URL}/${server}/${startStr}/${endStr}/0`;
      if (params.category) {
        const cat = String(params.category).toLowerCase().replace(/ /g, "_");
        url += `?category=${encodeURIComponent(cat)}`;
      }

      const resp = await fetch(url);
      if (!resp.ok) {
        throw new Error(`${display} API ${resp.status}: ${await resp.text()}`);
      }

      const json = (await resp.json()) as any;
      const collection: any[] = json.collection ?? [];

      // Client-side text filter — bioRxiv/medRxiv API is date-range based, not keyword search
      let filtered = collection;
      if (params.query) {
        const q = params.query.toLowerCase();
        filtered = collection.filter(
          (item) =>
            (item.title ?? "").toLowerCase().includes(q) ||
            (item.abstract ?? "").toLowerCase().includes(q) ||
            (item.authors ?? "").toLowerCase().includes(q)
        );
      }

      const papers = filtered
        .slice(0, limit)
        .map((item) => parsePaper(item, server, domain));
      return {
        papers,
        total_results: filtered.length,
        query: params.query,
        source: server,
      };
    },
  };
}

export const biorxiv = createBiorxivPlatform("biorxiv");
export const medrxiv = createBiorxivPlatform("medrxiv");
