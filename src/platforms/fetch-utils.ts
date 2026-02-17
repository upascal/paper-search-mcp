/**
 * Fetch with automatic retry on 429 (rate limit) responses.
 * Uses exponential backoff, respecting Retry-After header if present.
 */
export async function fetchWithRetry(
  url: string,
  options: RequestInit = {},
  maxRetries = 3,
  baseDelay = 2000
): Promise<Response> {
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    const resp = await fetch(url, options);
    if (resp.status === 429 && attempt < maxRetries - 1) {
      const retryAfter = resp.headers.get("Retry-After");
      const delay = retryAfter
        ? parseInt(retryAfter, 10) * 1000
        : baseDelay * Math.pow(2, attempt);
      await new Promise((r) => setTimeout(r, delay));
      continue;
    }
    return resp;
  }
  throw new Error(`Request failed after ${maxRetries} retries: ${url}`);
}
