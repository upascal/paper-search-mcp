# paper-search-mcp

Academic paper search MCP server for Cloudflare Workers, designed for deployment via [mcp-deploy](https://github.com/upascal/mcp-deploy).

Searches across multiple platforms with unified ranking via Reciprocal Rank Fusion (RRF):

- **Semantic Scholar** — CS, social science, interdisciplinary; ML relevance ranking, TLDRs, influential citations, bulk Boolean search, paper recommendations
- **OpenAlex** — 250M+ works; semantic search via GTE-Large embeddings, journal/topic/OA filtering
- **CrossRef** — 150M+ records; DOI lookups, field-specific queries, journal metadata
- **arXiv** — CS, math, physics preprints; query syntax (`ti:`, `au:`, `abs:`, `cat:`)
- **PubMed** — Biomedical literature via NCBI E-utilities; MeSH terms
- **bioRxiv / medRxiv** — Biology and medical preprints; category filtering

Default enabled: `semantic_scholar`, `crossref`, `arxiv`, `openalex`. Configurable via `ENABLED_PLATFORMS`.

## Tools

### Search

| Tool | Description |
|------|-------------|
| `search_papers` | Unified search across all enabled platforms with RRF fusion and deduplication |
| `search_semantic_scholar` | Search Semantic Scholar (supports `bulk=true` for Boolean syntax, up to 1000 results) |
| `search_openalex` | Search OpenAlex (supports `semantic=true` for embedding-based search) |
| `search_crossref` | Search CrossRef with title/author/journal filters |
| `search_arxiv` | Search arXiv preprints |
| `search_pubmed` | Search PubMed/MEDLINE |
| `search_biorxiv` | Browse bioRxiv preprints |
| `search_medrxiv` | Browse medRxiv preprints |
| `search_journal` | Search a specific journal by name or ISSN with date filtering |
| `search_recent` | Daily digest — recent articles across platforms, sorted by date or citations |

### Lookup & Discovery

| Tool | Description |
|------|-------------|
| `get_semantic_scholar_paper` | Look up by S2 ID, DOI, arXiv ID, or PMID |
| `get_crossref_paper` | Look up by DOI |
| `get_openalex_paper` | Look up by DOI or OpenAlex ID |
| `find_similar_papers` | ML-powered recommendations from seed papers (positive + optional negative IDs) |
| `get_help` | Lists enabled platforms, configuration, and usage tips |

## Key features

**RRF Fusion** — `search_papers`, `search_recent`, and `search_journal` merge results from multiple platforms using Reciprocal Rank Fusion (`score = Σ 1/(k + rank)`, k=60). Papers are deduplicated by DOI with metadata merged from the richest source.

**Semantic Search** — OpenAlex semantic search uses GTE-Large embeddings over 217M works to find conceptually related papers even with different vocabulary. Enable with `semantic=true`. Requires `OPENALEX_API_KEY`.

**Paper Recommendations** — `find_similar_papers` uses Semantic Scholar's ML engine. Provide positive seed paper IDs (and optional negative IDs to steer away from) to get ranked recommendations.

**Bulk Boolean Search** — Semantic Scholar bulk search supports `+required`, `-excluded`, `"exact phrase"`, and `|` OR operators. Enable with `bulk=true` for high-recall retrieval up to 1000 results.

## How it works

This repo contains only MCP logic. Auth, deployment, and UI are handled by mcp-deploy. The repo ships:

- `src/` — MCP server code (Cloudflare Workers + Durable Objects)
- `mcp-deploy.json` — deployment contract (secrets, config, worker settings)

All platforms return a normalized `Paper` interface with consistent fields (`title`, `authors`, `abstract`, `doi`, `url`, `pdf_url`, `published_date`, `citations`, etc.). Platform-specific data is stored in the `extra` field.

## Configuration

| Variable | Required | Description |
|----------|----------|-------------|
| `ENABLED_PLATFORMS` | No | Comma-separated list (default: `semantic_scholar,crossref,arxiv,openalex`) |
| `SEMANTIC_SCHOLAR_API_KEY` | No | Higher rate limits; required for recommendations |
| `OPENALEX_API_KEY` | No* | Enables semantic search ($0.001/query, 100K credits/day free) |
| `PUBMED_API_KEY` | No | Higher rate limits on E-utilities |
| `CONTACT_EMAIL` | No | Polite pool access for CrossRef and OpenAlex |

*OpenAlex keyword search works without a key; semantic search and higher rate limits require one.

## Local development

```bash
npm install
npx wrangler dev
# Health check: http://localhost:8787/
```

## Testing

```bash
npm test
```

Integration tests hit live APIs. Set `.dev.vars` with optional API keys for better rate limits:

```
SEMANTIC_SCHOLAR_API_KEY=...
PUBMED_API_KEY=...
OPENALEX_API_KEY=...
CONTACT_EMAIL=you@example.com
```

## Release

Tag a version to trigger the GitHub Actions release workflow:

```bash
git tag v0.2.1
git push --tags
```

This builds `worker.mjs` and publishes it alongside `mcp-deploy.json` as release assets. mcp-deploy fetches these assets to deploy the worker.
