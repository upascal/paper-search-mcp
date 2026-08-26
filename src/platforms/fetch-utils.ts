/**
 * Per-domain rate limiter: enforces minimum delay between requests to the same API.
 * Prevents hammering APIs even when multiple tools fire in parallel.
 *
 * Concurrent callers reserve spaced departure slots synchronously (before any
 * await), so a burst of N requests serializes into N spaced departures instead
 * of all reading the same timestamp, sleeping identically, and firing at once.
 */
const nextSlot = new Map<string, number>();

// Authenticated vs unauthenticated intervals. Unauthenticated Semantic Scholar
// shares one global anonymous pool with aggressive limits — space requests the
// way the bench does (3.5s) to survive it. With a key: 1 req/s.
const DOMAIN_THROTTLE_MS: Record<string, { auth: number; unauth: number }> = {
  "api.semanticscholar.org": { auth: 1100, unauth: 3500 },
  "export.arxiv.org": { auth: 3000, unauth: 3000 },
  "eutils.ncbi.nlm.nih.gov": { auth: 334, unauth: 334 },
};

function getDomain(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return "";
  }
}

/** Does the outgoing request carry an API key (x-api-key header)? */
function hasApiKey(options: RequestInit): boolean {
  const h = options.headers;
  if (!h) return false;
  if (h instanceof Headers) return h.has("x-api-key");
  if (Array.isArray(h)) return h.some(([k]) => k.toLowerCase() === "x-api-key");
  return Object.keys(h).some((k) => k.toLowerCase() === "x-api-key");
}

async function throttle(url: string, authed: boolean): Promise<void> {
  const domain = getDomain(url);
  const intervals = DOMAIN_THROTTLE_MS[domain];
  if (!intervals) return;
  const minInterval = authed ? intervals.auth : intervals.unauth;

  // Reserve the slot before sleeping — the synchronous read-modify-write is
  // what keeps concurrent callers from firing simultaneously.
  const now = Date.now();
  const slot = Math.max(now, nextSlot.get(domain) ?? 0);
  nextSlot.set(domain, slot + minInterval);
  if (slot > now) {
    await new Promise((r) => setTimeout(r, slot - now));
  }
}

/**
 * Fetch with automatic retry on 429 (rate limit) and 5xx (server error) responses.
 * Uses exponential backoff with multiplicative jitter (0.5–1.5×),
 * respecting Retry-After header if present.
 *
 * Includes per-domain request throttling to avoid triggering rate limits.
 *
 * Hard bounds — an unresponsive upstream or an aggressive Retry-After header
 * must never stall a tool call indefinitely:
 * - Every attempt carries a 10s AbortSignal timeout
 * - Backoff delays are capped (Retry-After is honored but never uncapped)
 * - The whole call has a total time budget (throttle-queue wait included);
 *   when exceeded, the last error response is returned instead of sleeping on
 *
 * Follows Semantic Scholar's rate-limit guidance:
 * - Exponential backoff + jitter is mandatory for 429s
 * - 5xx errors (scaling issues) should also use backoff
 * - Minimum 1s floor between any retries
 *
 * Retry defaults are domain-aware: unauthenticated Semantic Scholar retries
 * more patiently (5 attempts, 2s base delay) than everything else (3 / 1s).
 * Centralized here so every S2 call site gets the same profile.
 */
const ATTEMPT_TIMEOUT_MS = 10_000;
const TOTAL_BUDGET_MS = 25_000;

/**
 * Rate-limit cooldown: after a request exhausts its retries on 429, skip the
 * domain entirely for a window. One hot-limited platform (e.g. unauthenticated
 * Semantic Scholar) must not add its full retry latency to every search.
 * Isolate-level state, same lifetime as the throttle map.
 */
const RATE_LIMIT_COOLDOWN_MS = 60_000;
// With a dedicated API key, a 429 is a blip (bucket boundary, edge-node
// propagation), not a hot shared pool — a 60s blackout would amplify one
// flaky response into ~20 skipped requests. Cool down briefly instead.
const AUTH_RATE_LIMIT_COOLDOWN_MS = 15_000;
const cooldownUntil = new Map<string, number>();

function startCooldown(domain: string, authed: boolean): void {
  const ms = authed ? AUTH_RATE_LIMIT_COOLDOWN_MS : RATE_LIMIT_COOLDOWN_MS;
  cooldownUntil.set(domain, Date.now() + ms);
}

function assertNotCooling(domain: string): void {
  const coolingUntil = cooldownUntil.get(domain) ?? 0;
  if (Date.now() < coolingUntil) {
    const secs = Math.ceil((coolingUntil - Date.now()) / 1000);
    // Message deliberately contains "429" — callers treat that as the
    // rate-limited marker (warnings, test skip conditions).
    throw new Error(
      `${domain} skipped: in cooldown after 429 rate limit (${secs}s remaining)`
    );
  }
}

// ---------------------------------------------------------------------------
// Response cache (in-memory, isolate lifetime)
// ---------------------------------------------------------------------------
// Paper metadata is effectively immutable and search results tolerate an hour
// of staleness — re-fetching them spends rate-limit budget for nothing.
// Agents retry and re-pivot on the same papers constantly; benchmark replays
// hit identical URLs across runs. Keyed on method+URL+body so the S2 batch
// and recommendations POSTs cache too. A hit is served BEFORE the cooldown
// check, deliberately: cached data keeps flowing while a domain is
// rate-limited. Entry+size capped; insertion-order (oldest-first) eviction.

const HOUR_MS = 3_600_000;
const CACHE_MAX_ENTRIES = 200;
const CACHE_MAX_BODY_BYTES = 256 * 1024;
const responseCache = new Map<string, { expires: number; status: number; body: string }>();

/** TTL by URL class: id lookups are stable, graphs drift slowly, searches shift. */
function cacheTtl(url: string): number {
  const LONG = 24 * HOUR_MS;   // immutable-ish: paper metadata by id, venue records
  const MEDIUM = 6 * HOUR_MS;  // slow drift: citation graphs, recommendations
  const SHORT = HOUR_MS;       // searches

  if (/semanticscholar\.org\/graph\/v1\/paper\/batch/.test(url)) return LONG;
  if (/semanticscholar\.org\/graph\/v1\/paper\/[^/?]+\/(citations|references)\?/.test(url)) return MEDIUM;
  // (?!search) — /paper/search must not classify as a paper-id detail lookup
  if (/semanticscholar\.org\/graph\/v1\/paper\/(?!search[/?])[^/?]+\?/.test(url)) return LONG;
  if (/semanticscholar\.org\/recommendations\//.test(url)) return MEDIUM;
  if (/openalex\.org\/works\/[^?]+/.test(url)) return LONG;
  if (/openalex\.org\/(sources|topics)\?/.test(url)) return LONG;
  if (/[?&]filter=(doi|ids\.openalex)(:|%3A)/.test(url)) return LONG;
  if (/[?&]filter=cites(:|%3A)/.test(url)) return MEDIUM;
  if (/api\.crossref\.org\/works\//.test(url)) return LONG;
  return SHORT;
}

function cachePut(key: string, url: string, status: number, body: string): void {
  if (body.length > CACHE_MAX_BODY_BYTES) return;
  if (responseCache.size >= CACHE_MAX_ENTRIES) {
    let evict = Math.ceil(CACHE_MAX_ENTRIES / 10);
    for (const k of responseCache.keys()) {
      responseCache.delete(k);
      if (--evict <= 0) break;
    }
  }
  responseCache.delete(key); // refresh insertion order on overwrite
  responseCache.set(key, { expires: Date.now() + cacheTtl(url), status, body });
}

function logFetch(domain: string, status: number | string, ms: number, attempt: number): void {
  console.log(
    JSON.stringify({ evt: "upstream_fetch", domain, status, ms, attempt })
  );
}

export async function fetchWithRetry(
  url: string,
  options: RequestInit = {},
  maxRetries?: number,
  baseDelay?: number,
  maxDelay = 8_000
): Promise<Response> {
  const start = Date.now();
  const domain = getDomain(url);
  const authed = hasApiKey(options);

  // Unauthenticated S2 has aggressive rate limits (~100 req/5 min);
  // retry more patiently with higher base delay when no API key is present
  const patient = domain === "api.semanticscholar.org" && !authed;
  const retries = maxRetries ?? (patient ? 5 : 3);
  const firstDelay = baseDelay ?? (patient ? 2000 : 1000);

  const method = (options.method ?? "GET").toUpperCase();
  const cacheKey = `${method} ${url} ${typeof options.body === "string" ? options.body : ""}`;
  const hit = responseCache.get(cacheKey);
  if (hit && Date.now() < hit.expires) {
    logFetch(domain, "cache", 0, 0);
    return new Response(hit.body, { status: hit.status });
  }

  assertNotCooling(domain);

  for (let attempt = 0; attempt < retries; attempt++) {
    await throttle(url, authed);
    // A sibling request may have hit a 429 while we waited in the queue —
    // don't pile onto a domain that is already cooling down.
    assertNotCooling(domain);
    const attemptStart = Date.now();
    let resp: Response | null = null;
    try {
      resp = await fetch(url, {
        ...options,
        signal: AbortSignal.timeout(ATTEMPT_TIMEOUT_MS),
      });
      logFetch(domain, resp.status, Date.now() - attemptStart, attempt);
    } catch (err) {
      logFetch(domain, "timeout/error", Date.now() - attemptStart, attempt);
      // Timeout or network error — retry if attempts remain, else rethrow
      if (attempt >= retries - 1) throw err;
    }

    const retryable =
      (resp === null || resp.status === 429 || resp.status >= 500) &&
      attempt < retries - 1;

    if (!retryable) {
      if (resp) {
        if (resp.status === 429) {
          startCooldown(domain, authed);
          return resp;
        }
        if (resp.ok) {
          // Read once, cache, and hand the caller a reconstructed response
          const body = await resp.text();
          cachePut(cacheKey, url, resp.status, body);
          return new Response(body, { status: resp.status, headers: resp.headers });
        }
        return resp;
      }
      break;
    }

    const retryAfter = resp?.headers.get("Retry-After");
    const computed = retryAfter
      ? parseInt(retryAfter, 10) * 1000
      : firstDelay * Math.pow(2, attempt);
    const capped = Math.min(computed, maxDelay);
    // Multiplicative jitter (0.5–1.5×) to spread out competing clients
    const jitter = 0.5 + Math.random();
    const delay = Math.max(1000, capped * jitter);
    if (Date.now() - start + delay > TOTAL_BUDGET_MS) {
      // Out of budget: return the error response rather than sleeping on
      if (resp) {
        if (resp.status === 429) {
          startCooldown(domain, authed);
        }
        return resp;
      }
      throw new Error(`Request timed out after ${attempt + 1} attempts: ${url}`);
    }
    await new Promise((r) => setTimeout(r, delay));
  }
  throw new Error(`Request failed after ${retries} retries: ${url}`);
}
