# paper-search-mcp

Academic paper search MCP server for Cloudflare Workers, designed for deployment via [mcp-deploy](https://github.com/upascal/mcp-deploy).

Searches across multiple platforms with unified ranking via Reciprocal Rank Fusion (RRF):

- **Semantic Scholar** — CS, social science, interdisciplinary; ML relevance ranking, TLDRs, influential citations, citation graph, paper recommendations
- **OpenAlex** — 250M+ works; FWCI and citation-percentile quality signals, venue metrics, citation graph, semantic search via GTE-Large embeddings
- **CrossRef** — 150M+ records; DOI lookups, journal metadata
- **arXiv** — CS, math, physics preprints
- **PubMed** — Biomedical literature via NCBI E-utilities
- **bioRxiv / medRxiv** — Biology and medical preprints

**Core platforms** (always on): Semantic Scholar, CrossRef, OpenAlex — provide quality scoring signals (FWCI, h-index, venue quality, citations).
**Optional platforms** (configurable via `ENABLED_PLATFORMS`): arXiv, PubMed, bioRxiv, medRxiv. Default: `arxiv`.

## Tools

| Tool | Description |
|------|-------------|
| `search_papers` | Unified search across all enabled platforms with RRF fusion. Accepts 1–6 decomposed queries, date filtering, citation thresholds, and blended ranking dials (`relevance` / `balanced` / `discovery` / `impact` presets or custom weights) |
| `discover_recent_papers` | Recent-work digest — search scoped to the last N days, optionally filtered to specific journals |
| `rerank_papers` | Deep quality scoring on up to 50 papers (DOIs / S2 IDs / OpenAlex IDs). Fetches rich metadata from S2 + OpenAlex in batched calls, then ranks by age-adaptive quality signals (FWCI, venue impact, citation percentile) |
| `find_similar_papers` | ML-powered recommendations from seed papers (positive + optional negative IDs) via Semantic Scholar's embedding recommender; falls back to OpenAlex related works when rate-limited |
| `get_paper` | Look up one paper by DOI, arXiv ID, PMID, OpenAlex ID, or S2 ID — auto-detects the ID type and queries the right platform(s) |
| `get_citation_graph` | Walk citations (follow-up work) or references (foundational work) of a paper; S2 citation graph with OpenAlex fallback |

## Key features

**RRF fusion** — search results from all platforms are merged with Reciprocal Rank Fusion (`score = Σ 1/(k + rank)`, k=60) and deduplicated by DOI/arXiv ID with metadata merged from the richest source.

**Blended ranking** — post-fusion scoring blends query relevance, venue/author quality, recency, and citation impact. Four presets (`relevance`, `balanced`, `discovery`, `impact`) or custom weight dials per call.

**Citation graph traversal** — `get_citation_graph` walks references and citations for multi-hop chaining. Backed by Semantic Scholar, with an automatic OpenAlex fallback (`cites:` filter / `referenced_works`) that also makes OpenAlex `W…` IDs resolvable.

**Rate-limit survivability** — built for good-citizen behavior on free API tiers:

- Per-domain throttle that serializes concurrent requests into spaced slots; key-aware spacing for Semantic Scholar (1 req/s with an API key, 1 per 3.5s without)
- Exponential backoff with jitter, `Retry-After` support, and a hard per-call time budget
- 60s domain cooldown after a request exhausts its retries on 429, so one hot-limited platform never stalls every search; other platforms keep answering
- Batched lookups: one S2 `POST /paper/batch` and one OpenAlex OR-filter call resolve up to 50 papers in `rerank_papers` instead of a request per paper
- In-memory TTL response cache (24h for paper metadata, 6h for citation graphs and recommendations, 1h for searches); cache hits are served even while a domain is cooling down

**Semantic search** — OpenAlex semantic search uses GTE-Large embeddings over 217M works to find conceptually related papers even with different vocabulary. Requires `OPENALEX_API_KEY`.

**Date filtering** — `search_papers` supports `date_from` / `date_to` (YYYY-MM-DD), mapped to platform-native filters where possible with post-fusion filtering as a safety net.

## Deploy

Install [mcp-deploy](https://github.com/upascal/mcp-deploy) and deploy to Cloudflare Workers:

```bash
npm install -g mcp-deploy
mcp-deploy login
mcp-deploy add upascal/paper-search-mcp
mcp-deploy deploy paper-search-mcp
```

Or use the web UI: `mcp-deploy gui`

## How it works

This repo contains only MCP logic. Auth, deployment, and UI are handled by [mcp-deploy](https://github.com/upascal/mcp-deploy) (`npm install -g mcp-deploy`). The repo ships:

- `src/` — MCP server code (Cloudflare Workers + Durable Objects)
- `mcp-deploy.json` — deployment contract (secrets, config, worker settings)
- `bench/` — retrieval benchmarks (see below)

All platforms return a normalized `Paper` interface with consistent fields (`title`, `authors`, `abstract`, `doi`, `url`, `pdf_url`, `published_date`, `citations`, etc.). Platform-specific data is stored in the `extra` field.

## Configuration

| Variable | Required | Description |
|----------|----------|-------------|
| `ENABLED_PLATFORMS` | No | Comma-separated list of optional platforms (default: `arxiv`). Core platforms are always on. |
| `SEMANTIC_SCHOLAR_API_KEY` | No | Strongly recommended: a dedicated 1 req/s budget instead of the shared anonymous pool. Without it, S2 requests are spaced 3.5s apart and rate-limit cooldowns are common. |
| `OPENALEX_API_KEY` | No* | Enables semantic search ($0.001/query, 100K credits/day free) |
| `PUBMED_API_KEY` | No | Higher rate limits on E-utilities |
| `CONTACT_EMAIL` | No | Polite-pool access for CrossRef and OpenAlex (faster, more reliable) |

*OpenAlex keyword search works without a key; semantic search and higher rate limits require one.

## Benchmarks

`bench/` contains a retrieval evaluation harness over [LitSearch](https://github.com/princeton-nlp/LitSearch) (597 queries with ground-truth citations):

```bash
npm run bench:download   # fetch queries + resolve ground-truth IDs (cached)
npm run bench:run        # non-agentic: one federated search per query
npm run bench:eval       # compute recall@k / MRR from run output
npm run bench:agentic    # agentic: Claude drives the real MCP over stdio
```

Runs are resumable and write JSONL + metrics to `bench/litsearch/results/`. A `SEMANTIC_SCHOLAR_API_KEY` in `.dev.vars` speeds up full sweeps dramatically.

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

Unit tests are offline; integration tests hit live APIs (only S2 rate limiting is tolerated as a skip). Set `.dev.vars` with optional API keys for reliable runs:

```
SEMANTIC_SCHOLAR_API_KEY=...
PUBMED_API_KEY=...
OPENALEX_API_KEY=...
CONTACT_EMAIL=you@example.com
```

## Release

Tag a version to trigger the GitHub Actions release workflow:

```bash
git tag v0.4.0
git push --tags
```

This builds `worker.mjs` and publishes it alongside `mcp-deploy.json` as release assets. mcp-deploy fetches these assets to deploy the worker.
