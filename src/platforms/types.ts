/** Normalized paper record returned by all platforms. */
export interface Paper {
  paper_id: string;
  title: string;
  authors: string[];
  abstract: string;
  doi: string;
  url: string;
  pdf_url: string;
  published_date: string;
  source: string;
  citations: number;
  categories: string[];
  keywords: string[];
  extra?: Record<string, unknown>;
}

/** Search result envelope. */
export interface SearchResult {
  papers: Paper[];
  total_results?: number;
  query: string;
  source: string;
  warnings?: string[];
}

/** Search parameters accepted by all platforms. */
export interface SearchParams {
  query: string;
  max_results?: number;
  [key: string]: unknown;
}

/** Every platform module exports an object conforming to this. */
export interface PlatformSource {
  name: string;
  displayName: string;
  search(params: SearchParams, env: Env): Promise<SearchResult>;
  getById?(id: string, env: Env): Promise<Paper | null>;
}
