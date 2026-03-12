# Paper Search MCP Improvement Plan

## Current State
- 6 platforms: Semantic Scholar, CrossRef, arXiv, PubMed, bioRxiv, medRxiv
- Default enabled: semantic_scholar, crossref, arxiv
- No query intelligence — raw queries passed directly to each API
- CrossRef uses generic `query` param (noisy), no journal-scoped searching exposed as a first-class feature
- No date-range filtering on unified `search_papers`
- No concept of "daily digest" or "recent articles from specific journals"

## Improvements (4 Changes)

---

### 1. Add OpenAlex as a new platform

**Why:** OpenAlex indexes 250M+ works with excellent filtering — by journal/source ID, date ranges, topics, citation count, and open access status. It's free (100K credits/day with a free API key) and fills a gap: structured filtering that CrossRef does poorly.

**Implementation:**
- Create `src/platforms/openalex.ts` following the existing `PlatformSource` pattern
- **Search endpoint:** `GET https://api.openalex.org/works`
- **Params to expose:**
  - `query` → maps to `?search=`
  - `max_results` → maps to `?per_page=` (max 100)
  - `source` (optional) → journal/source name. Two-step: first resolve via `/sources?search=NAME` to get OpenAlex source ID, then filter with `primary_location.source.id:ID`
  - `from_date` / `to_date` (optional) → maps to `from_publication_date` / `to_publication_date` filters
  - `sort` (optional) → `relevance_score`, `cited_by_count`, `publication_date` (default: `relevance_score:desc`)
  - `topic` (optional) → resolve topic ID via `/topics?search=NAME`, filter with `topics.id:ID`
  - `open_access` (optional boolean) → filter `is_oa:true`
- **getById:** `GET https://api.openalex.org/works/doi:{doi}` or by OpenAlex ID
- **API key:** `OPENALEX_API_KEY` env var (optional but recommended — set via `api_key` query param or `Authorization: Bearer` header; free key gives 100K credits/day vs 100 without)
- **Response mapping:** Map OpenAlex work object to `Paper` interface:
  - `paper_id` = OpenAlex ID (e.g. `W2741809807`)
  - `title` = `display_name`
  - `authors` = `authorships[].author.display_name`
  - `abstract` = reconstruct from `abstract_inverted_index` (OpenAlex stores abstracts as inverted indexes)
  - `doi` = strip prefix from `doi` field (comes as `https://doi.org/10.xxx`)
  - `url` = `doi` or `id` URL
  - `pdf_url` = `open_access.oa_url` or `best_oa_location.pdf_url`
  - `published_date` = `publication_date`
  - `citations` = `cited_by_count`
  - `categories` = `topics[].display_name`
  - `keywords` = `keywords[].display_name`
  - `extra` = `{ journal: primary_location.source.display_name, volume, issue, type }`

- Register in `registry.ts`, add schema in `index.ts`

---

### 2. Improve CrossRef to reduce noise

**Why:** CrossRef's generic `query` param matches against all metadata fields, returning a lot of irrelevant results. Using field-specific queries and smarter defaults will drastically improve relevance.

**Changes to `crossref.ts` and its schema in `index.ts`:**

a) **Add `query_title` and `query_author` params** — These map to CrossRef's `query.title` and `query.author` field-specific query parameters, which are far more precise than the generic `query`.

b) **Add `journal_issn` param** — Maps to `filter=issn:XXXX-XXXX`. This enables searching within a specific journal. Much more useful than the raw `filter` string.

c) **Add `from_date` / `to_date` params** — Maps to `filter=from-pub-date:YYYY-MM-DD,to-pub-date:YYYY-MM-DD`. Currently users have to know the CrossRef filter syntax.

d) **Add `type` param** with enum — Expose `filter=type:journal-article` (or `book-chapter`, `proceedings-article`, etc.) as a first-class param instead of requiring filter syntax knowledge.

e) **Default to `type:journal-article` when no filter/type is specified** — This alone will eliminate most noise (datasets, components, reports, etc.)

f) **Use `select` param for efficiency** — Only request fields we actually map to `Paper`, reducing response size and improving speed.

---

### 3. Add a `search_journal` convenience tool

**Why:** For the daily digest use case — searching specific journals like "Critical AI" (ISSN: 2834-703X) or "Big Data & Society" (ISSN: 2053-9517) for recent articles — there's no streamlined way to do this today.

**Implementation:** A new top-level tool (not a platform) registered in `index.ts`:

```
Tool: search_journal
Params:
  - journal: string (journal name OR ISSN)
  - query: string (optional — search terms within the journal)
  - days: number (default: 7, how many days back to search)
  - max_results: number (default: 20)
  - platforms: string[] (default: ["openalex", "crossref"] — which backends to query)
```

**Logic:**
1. If `journal` looks like an ISSN (regex `^\d{4}-\d{3}[\dXx]$`), use it directly
2. Otherwise, resolve it: query OpenAlex `/sources?search=NAME` to get the ISSN
3. Search both OpenAlex (using `primary_location.source.id` filter) and CrossRef (using `issn` filter) in parallel
4. Merge and deduplicate results by DOI
5. Sort by publication date descending

This directly enables: "Give me all articles from Critical AI in the last 7 days"

---

### 4. Add a `search_recent` convenience tool for daily digest

**Why:** For a daily digest workflow, you want to search across multiple sources for recent articles on a topic, sorted by date, optionally scoped to specific journals.

```
Tool: search_recent
Params:
  - query: string (search terms)
  - days: number (default: 1, how far back)
  - journals: string[] (optional — list of journal names or ISSNs to scope to)
  - max_results: number (default: 20)
  - sort: "date" | "citations" (default: "date")
```

**Logic:**
1. Searches OpenAlex, CrossRef, and Semantic Scholar in parallel with date filters
2. If `journals` provided, adds journal/ISSN filters to OpenAlex and CrossRef queries
3. Merges, deduplicates by DOI, sorts by date
4. Returns a clean digest-ready result set

---

## What About Consensus?

After research, Consensus is **not recommended** for integration because:
- API access costs $0.10/call and requires an application/approval
- MCP returns only 3 results per query (20 for enterprise)
- It's a proprietary black-box — you can't control the search/ranking
- OpenAlex + improved CrossRef will provide better coverage and control for free

If you want to use Consensus separately as a complementary MCP (it has its own MCP server at https://docs.consensus.app/docs/mcp), you can install it alongside this one. But integrating it into this codebase isn't worthwhile given the cost and limitations.

---

## Summary of Files to Create/Modify

| File | Action |
|------|--------|
| `src/platforms/openalex.ts` | **Create** — new OpenAlex platform |
| `src/platforms/crossref.ts` | **Modify** — add field-specific queries, smart defaults |
| `src/registry.ts` | **Modify** — register OpenAlex |
| `src/index.ts` | **Modify** — add OpenAlex schema, search_journal tool, search_recent tool, update CrossRef schema |
| `src/platforms/types.ts` | No changes needed (existing interface is sufficient) |
| `wrangler.jsonc` | **Modify** — add OPENALEX_API_KEY binding if needed |
| `tests/integration/openalex.test.ts` | **Create** — integration tests |

## Specific Journal ISSNs for Your Use Case

| Journal | ISSN | Notes |
|---------|------|-------|
| Critical AI | 2834-703X | Duke University Press, online-only, 2 issues/year |
| Big Data & Society | 2053-9517 | SAGE, open access, Q1 ranked, IF 6.23 |
