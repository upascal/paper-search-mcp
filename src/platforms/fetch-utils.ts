/**
 * Per-domain rate limiter: enforces minimum delay between requests to the same API.
 * Prevents hammering APIs even when multiple tools fire in parallel.
 */
const lastRequestTime = new Map<string, number>();

const DOMAIN_THROTTLE_MS: Record<string, number> = {
  "api.semanticscholar.org": 1000,
  "export.arxiv.org": 3000,
  "eutils.ncbi.nlm.nih.gov": 334,
};

function getDomain(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return "";
  }
}

async function throttle(url: string): Promise<void> {
  const domain = getDomain(url);
  const minInterval = DOMAIN_THROTTLE_MS[domain];
  if (!minInterval) return;

  const last = lastRequestTime.get(domain) ?? 0;
  const elapsed = Date.now() - last;
  if (elapsed < minInterval) {
    await new Promise((r) => setTimeout(r, minInterval - elapsed));
  }
  lastRequestTime.set(domain, Date.now());
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
 * - The whole call has a total time budget; when exceeded, the last
 *   error response is returned instead of sleeping on
 *
 * Follows Semantic Scholar's rate-limit guidance:
 * - Exponential backoff + jitter is mandatory for 429s
 * - 5xx errors (scaling issues) should also use backoff
 * - Minimum 1s floor between any retries
 */
const ATTEMPT_TIMEOUT_MS = 10_000;
const TOTAL_BUDGET_MS = 25_000;

export async function fetchWithRetry(
  url: string,
  options: RequestInit = {},
  maxRetries = 3,
  baseDelay = 1000,
  maxDelay = 8_000
): Promise<Response> {
  const start = Date.now();
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    await throttle(url);
    let resp: Response | null = null;
    try {
      resp = await fetch(url, {
        ...options,
        signal: AbortSignal.timeout(ATTEMPT_TIMEOUT_MS),
      });
    } catch (err) {
      // Timeout or network error — retry if attempts remain, else rethrow
      if (attempt >= maxRetries - 1) throw err;
    }

    const retryable =
      (resp === null || resp.status === 429 || resp.status >= 500) &&
      attempt < maxRetries - 1;

    if (!retryable) {
      if (resp) return resp;
      break;
    }

    const retryAfter = resp?.headers.get("Retry-After");
    const computed = retryAfter
      ? parseInt(retryAfter, 10) * 1000
      : baseDelay * Math.pow(2, attempt);
    const capped = Math.min(computed, maxDelay);
    // Multiplicative jitter (0.5–1.5×) to spread out competing clients
    const jitter = 0.5 + Math.random();
    const delay = Math.max(1000, capped * jitter);
    if (Date.now() - start + delay > TOTAL_BUDGET_MS) {
      // Out of budget: return the error response rather than sleeping on
      if (resp) return resp;
      throw new Error(`Request timed out after ${attempt + 1} attempts: ${url}`);
    }
    await new Promise((r) => setTimeout(r, delay));
  }
  throw new Error(`Request failed after ${maxRetries} retries: ${url}`);
}
