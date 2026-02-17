import { XMLParser } from "fast-xml-parser";
import type { PlatformSource, Paper, SearchResult, SearchParams } from "./types.js";

const ESEARCH_URL = "https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esearch.fcgi";
const EFETCH_URL = "https://eutils.ncbi.nlm.nih.gov/entrez/eutils/efetch.fcgi";

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "@_",
  isArray: (_name: string) =>
    _name === "Id" ||
    _name === "PubmedArticle" ||
    _name === "Author" ||
    _name === "AbstractText" ||
    _name === "ELocationID",
});

function apiKeyParam(env: Env): string {
  return env.PUBMED_API_KEY ? `&api_key=${env.PUBMED_API_KEY}` : "";
}

function parsePaper(article: any): Paper {
  const medline = article.MedlineCitation ?? {};
  const art = medline.Article ?? {};
  const pmid = medline.PMID?.["#text"] ?? medline.PMID ?? "";

  const authorList = art.AuthorList?.Author ?? [];
  const authors = authorList.map((a: any) => {
    const last = a.LastName ?? "";
    const init = a.Initials ?? a.ForeName ?? "";
    return last ? `${last} ${init}`.trim() : a.CollectiveName ?? "";
  });

  const abstractParts: any[] = art.Abstract?.AbstractText ?? [];
  const abstract = abstractParts
    .map((p: any) => (typeof p === "string" ? p : p["#text"] ?? ""))
    .join(" ");

  const elocations: any[] = art.ELocationID ?? [];
  const doiEl = elocations.find((e: any) => e["@_EIdType"] === "doi");
  const doi = doiEl?.["#text"] ?? doiEl ?? "";

  const pubDate = art.Journal?.JournalIssue?.PubDate ?? {};
  const year = pubDate.Year ?? "";
  const month = pubDate.Month ?? "01";
  const day = pubDate.Day ?? "01";
  const published_date = year ? `${year}-${month}-${day}` : "";

  return {
    paper_id: String(pmid),
    title: art.ArticleTitle ?? "",
    authors,
    abstract,
    doi: typeof doi === "string" ? doi : "",
    url: `https://pubmed.ncbi.nlm.nih.gov/${pmid}/`,
    pdf_url: "",
    published_date,
    source: "pubmed",
    citations: 0,
    categories: [],
    keywords: [],
  };
}

export const pubmed: PlatformSource = {
  name: "pubmed",
  displayName: "PubMed",

  async search(params: SearchParams, env: Env): Promise<SearchResult> {
    const maxResults = Math.min(params.max_results ?? 10, 100);
    const key = apiKeyParam(env);

    // Step 1: search for IDs
    const searchUrl = `${ESEARCH_URL}?db=pubmed&term=${encodeURIComponent(params.query)}&retmax=${maxResults}&retmode=xml${key}`;
    const searchResp = await fetch(searchUrl);
    if (!searchResp.ok) {
      throw new Error(`PubMed esearch ${searchResp.status}: ${await searchResp.text()}`);
    }

    const searchXml = await searchResp.text();
    const searchParsed = parser.parse(searchXml);
    const idList: any[] =
      searchParsed.eSearchResult?.IdList?.Id ?? [];
    const ids = idList.map((id: any) => (typeof id === "string" ? id : id["#text"] ?? String(id)));

    if (ids.length === 0) {
      return { papers: [], total_results: 0, query: params.query, source: "pubmed" };
    }

    // Step 2: fetch metadata
    const fetchUrl = `${EFETCH_URL}?db=pubmed&id=${ids.join(",")}&retmode=xml${key}`;
    const fetchResp = await fetch(fetchUrl);
    if (!fetchResp.ok) {
      throw new Error(`PubMed efetch ${fetchResp.status}: ${await fetchResp.text()}`);
    }

    const fetchXml = await fetchResp.text();
    const fetchParsed = parser.parse(fetchXml);
    const articles: any[] =
      fetchParsed.PubmedArticleSet?.PubmedArticle ?? [];

    const papers = articles.map(parsePaper);
    const totalStr =
      searchParsed.eSearchResult?.Count ?? undefined;
    const total = totalStr !== undefined ? parseInt(String(totalStr), 10) : undefined;

    return { papers, total_results: total, query: params.query, source: "pubmed" };
  },
};
