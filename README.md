# paper-search-mcp

Academic paper search MCP server for Cloudflare Workers, designed for deployment via [mcp-deploy](https://github.com/upascal/mcp-deploy).

Searches across multiple platforms with **Reciprocal Rank Fusion (RRF)** to merge results into a single relevance-ranked list. Papers found by multiple sources rank higher automatically.

### Platforms

- **Semantic Scholar** — 200M+ papers across all fields, ML-trained relevance ranking, TLDRs, influential citation counts, bulk Boolean search, paper recommendations
- **OpenAlex** — 250M+ works, AI-powered semantic search (GTE-Large embeddings), journal/topic/date filtering
- **CrossRef** — 150M+ records, DOI lookups, field-specific title/author queries, journal ISSN filtering
- **arXiv** — CS, math, physics preprints
- **PubMed** — biomedical literature
- **bioRxiv / medRxiv** — biology and medical preprints

### Tools

| Tool | Description |
|------|-------------|
| `search_papers` | Unified search across all enabled platforms with RRF fusion. Set `semantic=true` for natural language queries. |
| `search_journal` | Search within a specific journal by name or ISSN. Resolves names automatically. |
| `search_recent` | Daily digest — recent articles with date filtering, optional journal scoping, and RRF ranking. |
| `find_similar_papers` | Semantic Scholar recommendations — provide papers you like, get related papers back. |
| `search_{platform}` | Direct per-platform search with platform-specific parameters. |
| `get_{platform}_paper` | Look up a single paper by identifier (DOI, arXiv ID, etc). |
| `get_help` | Lists enabled platforms, available tools, and usage tips. |

## How it works

This repo contains only MCP logic. Auth, deployment, and UI are handled by mcp-deploy. The repo ships:

- `src/` — MCP server code (Cloudflare Workers + Durable Objects)
- `mcp-deploy.json` — deployment contract (secrets, config, worker settings)

### RRF fusion

`search_papers` and `search_recent` query multiple APIs in parallel, then merge results using [Reciprocal Rank Fusion](https://dl.acm.org/doi/10.1145/1571941.1572114) (k=60). This produces better rankings than any single API because:

- Papers ranked highly by multiple sources get boosted
- Different APIs have different coverage and ranking models
- Deduplication by DOI keeps the richest metadata version

### Semantic search

OpenAlex offers AI-powered semantic search using GTE-Large embeddings over 217M works. Set `semantic=true` on `search_papers` or `search_openalex` to find conceptually related papers even when they use different terminology. Requires an `OPENALEX_API_KEY` ($0.001/query); falls back to keyword search without one.

### Paper recommendations

`find_similar_papers` uses Semantic Scholar's recommendation engine. Provide 1+ paper IDs you like (and optionally papers to avoid), and it returns related papers ranked by ML similarity. Accepts Semantic Scholar IDs, DOIs (`DOI:xxx`), arXiv IDs (`ARXIV:xxx`), or PMIDs (`PMID:xxx`).

## Configuration

### API keys (optional but recommended)

| Key | Purpose |
|-----|---------|
| `OPENALEX_API_KEY` | Required since Feb 2026. Enables semantic search and higher rate limits. Free at [openalex.org](https://docs.openalex.org/how-to-use-the-api/api-key). |
| `SEMANTIC_SCHOLAR_API_KEY` | Higher rate limits and access to recommendations. Get from [semanticscholar.org](https://www.semanticscholar.org/product/api). |
| `PUBMED_API_KEY` | Higher rate limits. Get from [ncbi.nlm.nih.gov](https://www.ncbi.nlm.nih.gov/books/NBK25497/). |
| `CONTACT_EMAIL` | Identifies requests to CrossRef and OpenAlex for better rate limits. |

### Platform selection

Set `ENABLED_PLATFORMS` to a comma-separated list. Default: `semantic_scholar,crossref,arxiv,openalex`.

Available: `semantic_scholar`, `crossref`, `arxiv`, `openalex`, `pubmed`, `biorxiv`, `medrxiv`.

## Local development

```bash
npm install
npx wrangler dev
# Health check: http://localhost:8787/
```

## Release

Tag a version to trigger the GitHub Actions release workflow:

```bash
git tag v0.2.1
git push --tags
```

This builds `worker.mjs` and publishes it alongside `mcp-deploy.json` as release assets. mcp-deploy fetches these assets to deploy the worker.

## Testing

```bash
npm test
```

Integration tests hit live APIs. Set `.dev.vars` with optional API keys for better rate limits:

```
OPENALEX_API_KEY=...
SEMANTIC_SCHOLAR_API_KEY=...
PUBMED_API_KEY=...
CONTACT_EMAIL=you@example.com
```
