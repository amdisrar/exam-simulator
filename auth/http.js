// Outbound HTTP helper for the OAuth flow.
//
// Google's endpoints occasionally fail or hang from networks with flaky egress
// (corporate DNS, intermittent routing). A single failed request currently
// aborts the whole sign-in, so token and key requests are retried a couple of
// times with a hard timeout.

const DEFAULT_TIMEOUT_MS = 8000;
const DEFAULT_ATTEMPTS = 3;
const RETRY_STATUSES = new Set([408, 425, 429, 500, 502, 503, 504]);

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

/**
 * fetch() with a timeout and bounded retries.
 *
 * Retries transport errors and transient 5xx/429 responses; any other response
 * (including 4xx such as invalid_grant) is returned to the caller untouched so
 * it can be reported accurately.
 */
export async function fetchWithRetry(url, options = {}, {
  attempts = DEFAULT_ATTEMPTS,
  timeoutMs = DEFAULT_TIMEOUT_MS
} = {}) {
  let lastError = null;

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const response = await fetch(url, { ...options, signal: AbortSignal.timeout(timeoutMs) });
      if (RETRY_STATUSES.has(response.status) && attempt < attempts) {
        await delay(150 * attempt);
        continue;
      }
      return response;
    } catch (error) {
      lastError = error;
      if (attempt < attempts) {
        await delay(150 * attempt);
        continue;
      }
    }
  }

  const host = (() => {
    try {
      return new URL(url).host;
    } catch {
      return "remote host";
    }
  })();
  const cause = lastError?.cause?.code || lastError?.cause?.message;
  const wrapped = new Error(
    `Could not reach ${host}${cause ? ` (${cause})` : ""} after ${attempts} attempts`
  );
  wrapped.cause = lastError;
  throw wrapped;
}
