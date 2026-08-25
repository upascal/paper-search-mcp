# Semantic Scholar API Key Application

Draft answers for the Semantic Scholar API key request form.
Fill in every `[bracketed]` placeholder before submitting.
**Submit from the institutional `.edu` address, not a personal account.**

Background: a previous application from a personal Gmail address received only the standard
holding reply ("we prioritize requests for academic and research institutions...") and was never
followed up on. This rewrite adds an institutional signal and a concrete, externally verifiable
research justification.

---

## Placeholders to fill

- `[role]` — PhD candidate / postdoctoral researcher / research scientist
- `[Department]`, `[University]`, `[Lab]`

Repo link is verified public: <https://github.com/upascal/paper-search-mcp>

---

## Q1. How do you plan to use Semantic Scholar API in your project? (50+ words)

I am a [role] in [Department] at [University], working in the [Lab] on information retrieval and
LLM-agent systems. I use the Semantic Scholar API in two connected research projects.

**1. Evaluating agentic literature search.** I maintain an open-source retrieval system and
benchmark harness that measures how much multi-turn agentic search improves literature discovery
over single-shot queries. The system federates Semantic Scholar, OpenAlex, CrossRef, and arXiv,
merges results with Reciprocal Rank Fusion, and lets an LLM agent decompose queries into facets,
traverse citation graphs, and pivot on embedding-based recommendations. On LitSearch (Princeton
NLP), single-shot federated search reaches Recall@5 of 0.12 on a 50-query sample, while multi-turn
agentic search reaches 0.64 on a 49-query sample. I am isolating which retrieval affordances —
query decomposition, citation traversal, or recommendation pivots — account for that gap. These
samples are small relative to the full 597-query set largely because unauthenticated rate limits
force roughly 3.5 seconds between Semantic Scholar requests; an API key would let me complete full
sweeps and report stable numbers instead of subsamples. Semantic Scholar is the only source in
the study that provides all three affordances (relevance-ranked search, a citation graph, and an
embedding recommender), so it is central rather than substitutable.

**2. Submitting to the AstaBench Literature Understanding leaderboard.** I am preparing a
submission to Ai2's AstaBench suite — PaperFindingBench, LitQA2-FullText-Search, ScholarQA-CS2,
and ArxivDIGESTables-Clean — to place this work on a public, externally comparable leaderboard
rather than reporting only self-run numbers. The agent I intend to submit uses the Semantic
Scholar Graph API directly as its retrieval backend, so an API key is a prerequisite for producing
a submission at all. Running these four tasks end-to-end, across repeated iterations as I tune the
retrieval strategy, is the bulk of my anticipated request volume.

**Endpoints and fields.** The code calls `/graph/v1/paper/search` and `/paper/search/bulk`
(fields: `title,abstract,year,citationCount,influentialCitationCount,authors,url,publicationDate,externalIds,openAccessPdf,publicationVenue`),
`/graph/v1/paper/{id}` (the same list plus
`fieldsOfStudy,s2FieldsOfStudy,tldr,authors.hIndex,authors.citationCount,authors.paperCount`),
`/paper/{id}/citations` and `/paper/{id}/references`, `/paper/batch` for ground-truth ID
resolution, and `POST /recommendations/v1/papers`. I also plan to add `/graph/v1/snippet/search`,
since the AstaBench literature tasks reward full-text passage evidence that abstract-level
retrieval cannot supply. I deliberately request a lighter field set on search than on detail
lookups to keep payloads small.

**Expected usage and users.** Approximately 5,000 requests/day in normal use, with bursts to
~30,000 on days I run a full benchmark sweep — comfortably inside a 1 req/sec budget. This key
covers my own research use only. The tool is not a hosted multi-tenant service: each user
self-deploys it to their own Cloudflare account and supplies their own credentials, so other
users' traffic never flows through this key.

**Efficiency measures already implemented.** A per-domain throttle caps Semantic Scholar at 1
request/second. Retries use exponential backoff with jitter and honor `Retry-After`. After a
request exhausts its retries on a 429, the domain enters a 60-second cooldown so a rate-limited
endpoint is never hammered. Field lists are minimized per endpoint. The benchmark resolves its 574
ground-truth corpus IDs through two batched `/paper/batch` calls and caches the mapping to disk,
so it is fetched once rather than per run; benchmark runs are resumable, so re-runs fetch only
missing queries. I do not mirror or redistribute the corpus — results are surfaced with Semantic
Scholar links and attribution. The implementation is open source and auditable at
https://github.com/upascal/paper-search-mcp.

---

## Q2. Which endpoints do you plan to use?

- `GET /graph/v1/paper/search` — relevance-ranked keyword search
- `GET /graph/v1/paper/search/bulk` — high-recall Boolean search
- `GET /graph/v1/paper/{paper_id}` — metadata lookup by S2 ID, DOI, arXiv ID, or PMID
- `GET /graph/v1/paper/{paper_id}/citations` — forward citation traversal
- `GET /graph/v1/paper/{paper_id}/references` — backward reference traversal
- `POST /graph/v1/paper/batch` — batched metadata for benchmark ground-truth ID resolution
- `POST /recommendations/v1/papers` — embedding-based recommendations from seed papers
- `GET /graph/v1/snippet/search` — full-text passage retrieval for the AstaBench literature
  understanding tasks

---

## Q3. How many requests per day do you anticipate using?

**5,000**

If the form allows free text alongside the number:

> ~5,000/day in typical use. Benchmark days reach ~30,000 when I run a full sweep of the AstaBench
> Literature Understanding tasks or the 597-query LitSearch set across all endpoints. Both figures
> stay within a 1 request/second budget, which my client already enforces with a per-domain
> throttle.

---

## Note: this key is not the same as `ASTA_TOOL_KEY`

Do **not** claim in this application that AstaBench requires a Semantic Scholar API key — it does
not, and an Ai2 reviewer would know that.

| | Semantic Scholar API key | Asta Tool Key (`ASTA_TOOL_KEY`) |
|---|---|---|
| Opens | `api.semanticscholar.org/graph/v1` directly | Asta Scientific Corpus Tool, an MCP wrapper over the S2 API at `https://asta-tools.allen.ai/mcp/v1` |
| Needed by | `paper-search-mcp` — calls the Graph API directly (`src/platforms/semantic-scholar.ts:4-5`) | the `asta-bench` harness — its README: `ASTA_TOOL_KEY` is "Used by the literature search tools" |
| Request via | this form | separate Ai2 form: https://share.hsforms.com/1L4hUh20oT3mu8iXJQMV77w3ioxm |

Both are likely needed, and they are not substitutes. Before filling out the Asta form, check
whether Asta MCP access already exists through claude.ai connectors.

AstaBench submissions also carry a "Tool usage" metadata category. Since this agent uses its own
S2-backed retrieval rather than Asta's tools, confirm which category that implies before
submitting results — it affects which leaderboard section the entry appears in.

---

## Claim provenance

Every factual claim above traces to code in this repo or a cited source.

| Claim | Source |
|---|---|
| Endpoint list and field strings | `src/platforms/semantic-scholar.ts:4-18, 82, 104, 131, 170, 208` |
| 1 req/sec S2 throttle | `src/platforms/fetch-utils.ts:7-9` (`"api.semanticscholar.org": 1000`) |
| Backoff, jitter, `Retry-After` | `src/platforms/fetch-utils.ts:71-141` |
| 60-second 429 cooldown | `src/platforms/fetch-utils.ts:56-63, 81-89, 113-115` |
| RRF fusion, k=60 | `src/rrf.ts:17, 86-105` |
| 597 LitSearch queries, 574 corpus IDs | `bench/litsearch/download.ts:5`; `bench/litsearch/.cache/id-map.json` |
| Two batched `/paper/batch` calls, disk cache | `bench/litsearch/download.ts:89` (`batchSize = 500`) |
| Recall@5 0.12 direct (n=50) | `bench/litsearch/results/run-2026-08-25-default.metrics.json` |
| Recall@5 0.64 agentic (n=49) | `bench/litsearch/results/agentic-2026-03-16-sonnet-default.metrics.json` |
| ~3.5s unauthenticated S2 spacing | `bench/litsearch/run.ts:39-64` (`unauthenticated: 3500`) |
| Per-deployment BYO key, no shared endpoint | `README.md:73`; `src/index.ts:15`; `mcp-deploy.json:14-27` |
| Four Literature Understanding tasks | AstaBench leaderboard; `allenai/asta-bench` README |

**Two caveats before sending:**

1. **Sample sizes are stated explicitly and should stay that way.** No full 597-query sweep has
   been completed. The cited figures are the largest available samples: 0.12 direct (n=50,
   `run-2026-08-25-default`) and 0.64 agentic (n=49, `agentic-2026-03-16-sonnet-default`). They
   come from different runs on different dates, so they are indicative, not a controlled A/B.
   Avoid the earlier 0.35-vs-0.74 pairing — those were a 10-query and a 19-query run respectively,
   and quoting them side by side overstates the comparison.
2. The draft states you *are preparing* an AstaBench submission. Confirm that is true — it is the
   strongest claim in the application and the easiest to verify.
