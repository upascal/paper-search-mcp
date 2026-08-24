/**
 * Fetch with automatic retry on 429 (rate limit) responses.
 * Uses exponential backoff with jitter, respecting Retry-After header if present.
 *
 * Every attempt carries a hard timeout, backoff delays are capped, and the
 * whole call has a total time budget — an unresponsive upstream or an
 * aggressive Retry-After header must never stall a tool call indefinitely.
 */
const ATTEMPT_TIMEOUT_MS = 10_000;
const MAX_BACKOFF_MS = 8_000;
const TOTAL_BUDGET_MS = 25_000;

export async function fetchWithRetry(
  url: string,
  options: RequestInit = {},
  maxRetries = 3,
  baseDelay = 3000
): Promise<Response> {
  const start = Date.now();
  for (let attempt = 0; attempt < maxRetries; attempt++) {
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
    if (resp && !(resp.status === 429 && attempt < maxRetries - 1)) {
      return resp;
    }
    const retryAfter = resp?.headers.get("Retry-After");
    const base = retryAfter
      ? parseInt(retryAfter, 10) * 1000
      : baseDelay * Math.pow(2, attempt);
    // Cap the backoff and add 0-30% random jitter to prevent thundering herd
    const capped = Math.min(base, MAX_BACKOFF_MS);
    const delay = capped + capped * Math.random() * 0.3;
    if (Date.now() - start + delay > TOTAL_BUDGET_MS) {
      // Out of budget: return the rate-limited response rather than sleeping on
      if (resp) return resp;
      throw new Error(`Request timed out after ${attempt + 1} attempts: ${url}`);
    }
    await new Promise((r) => setTimeout(r, delay));
  }
  throw new Error(`Request failed after ${maxRetries} retries: ${url}`);
}
