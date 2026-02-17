# paper-search-mcp

Academic paper search MCP server for Cloudflare Workers, designed for deployment via [mcp-deploy](https://github.com/upascal/mcp-deploy).

Searches across multiple platforms:
- **Semantic Scholar** — CS, social science, interdisciplinary research
- **CrossRef** — 150M+ records, DOI lookups, journal metadata
- **arXiv** — CS, math, physics preprints
- **PubMed** — biomedical literature
- **bioRxiv / medRxiv** — biology and medical preprints

## How it works

This repo contains only MCP logic. Auth, deployment, and UI are handled by mcp-deploy. The repo ships:

- `src/` — MCP server code (Cloudflare Workers + Durable Objects)
- `mcp-deploy.json` — deployment contract (secrets, config, worker settings)

## Local development

```bash
npm install
npx wrangler dev
# Health check: http://localhost:8787/
```

## Release

Tag a version to trigger the GitHub Actions release workflow:

```bash
git tag v0.1.0
git push --tags
```

This builds `worker.mjs` and publishes it alongside `mcp-deploy.json` as release assets. mcp-deploy fetches these assets to deploy the worker.

## Testing

```bash
npm test
```

Integration tests hit live APIs. Set `.dev.vars` with optional API keys for better rate limits:

```
SEMANTIC_SCHOLAR_API_KEY=...
PUBMED_API_KEY=...
CONTACT_EMAIL=you@example.com
```
