/** Timeout for every outbound API request (TeamCity, GitLab, YouTrack). */
export const FETCH_TIMEOUT_MS = 15_000;

/**
 * Throw a uniform "not configured" error when a service's base URL or token is
 * missing, so every integration reports configuration problems the same way.
 * @param {string} service - Display name, e.g. 'TeamCity'
 * @param {{ base: string | null, token: string | null, configHint: string }} parts
 * @returns {void}
 */
export function requireConfigured(service, { base, token, configHint }) {
  if (!base) throw new Error(`${service} not configured (${configHint} in fenix.config.json)`);
  if (!token) throw new Error(`${service} authentication not configured`);
}

/**
 * `fetch` with the shared timeout and a uniform error for non-2xx responses.
 * @param {string} service - Display name used in error messages
 * @param {string | URL} url
 * @param {RequestInit & { timeoutMs?: number }} [init]
 * @returns {Promise<Response>}
 */
export async function httpRequest(service, url, init = {}) {
  const { timeoutMs = FETCH_TIMEOUT_MS, ...rest } = init;
  const res = await fetch(url, { ...rest, signal: AbortSignal.timeout(timeoutMs) });
  if (!res.ok) {
    const err = /** @type {Error & { status?: number }} */ (new Error(`${service} API error (HTTP ${res.status})`));
    err.status = res.status;
    throw err;
  }
  return res;
}
