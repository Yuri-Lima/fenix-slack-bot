import { baseUrl, config } from '../config.js';
import { createTokenReader } from '../utils/tokens.js';
import { httpRequest, requireConfigured } from './http.js';

export const TC_BASE = baseUrl(config.teamcity.url);

const getToken = createTokenReader('TEAMCITY_TOKEN', '.teamcity_token');

/** Requests in flight at once; TeamCity is shared by agent tools and build analysis. */
const MAX_CONCURRENT = 4;
/** Requests allowed to wait for a slot; beyond this, new requests fail fast. */
const MAX_QUEUED = 100;
/** How long a request may wait for a slot before it is rejected. */
const QUEUE_WAIT_MS = 60_000;

let active = 0;
/** @type {Array<{ run: () => Promise<any>, resolve: (v: any) => void, reject: (e: any) => void, timer: NodeJS.Timeout }>} */
const queue = [];

function drain() {
  while (queue.length > 0 && active < MAX_CONCURRENT) {
    const job = /** @type {(typeof queue)[number]} */ (queue.shift());
    clearTimeout(job.timer);
    start(job.run).then(job.resolve, job.reject);
  }
}

/**
 * @template T
 * @param {() => Promise<T>} run
 * @returns {Promise<T>}
 */
function start(run) {
  active++;
  return run().finally(() => {
    active--;
    drain();
  });
}

/**
 * Run a TeamCity request within the concurrency limit. Waiting requests are
 * bounded in number and in time so a burst cannot pile up indefinitely.
 * @template T
 * @param {() => Promise<T>} run
 * @returns {Promise<T>}
 */
function limited(run) {
  if (active < MAX_CONCURRENT) return start(run);
  if (queue.length >= MAX_QUEUED) return Promise.reject(new Error('TeamCity is busy (request queue full)'));
  return new Promise((resolve, reject) => {
    const job = {
      run,
      resolve,
      reject,
      timer: setTimeout(() => {
        const i = queue.indexOf(job);
        if (i !== -1) queue.splice(i, 1);
        reject(new Error(`TeamCity is busy (waited ${QUEUE_WAIT_MS / 1000}s for a request slot)`));
      }, QUEUE_WAIT_MS),
    };
    queue.push(job);
  });
}

/**
 * @param {string} path - Path under the TeamCity base URL, starting with `/`
 * @param {string} accept
 * @returns {Promise<Response>}
 */
function tcRequest(path, accept) {
  return limited(async () => {
    const token = getToken();
    requireConfigured('TeamCity', { base: TC_BASE, token, configHint: 'teamcity.url' });
    return httpRequest('TeamCity', `${TC_BASE}${path}`, {
      headers: { Authorization: `Bearer ${token}`, Accept: accept },
    });
  });
}

/**
 * @param {string} path
 * @returns {Promise<any>} parsed JSON
 */
export async function tcApi(path) {
  return (await tcRequest(path, 'application/json')).json();
}

/**
 * @param {string} path
 * @returns {Promise<string>}
 */
export async function tcFetchText(path) {
  return (await tcRequest(path, 'text/plain')).text();
}

/**
 * Encode a value for use inside a TeamCity locator. Test names routinely
 * contain locator syntax (`,` `:` `(` `)`), which makes TeamCity reject the
 * request with HTTP 400 even when URL-encoded. `$base64:` (base64url) is
 * TeamCity's escape for arbitrary values.
 * @param {string} value
 * @returns {string}
 */
export function locatorValue(value) {
  return `$base64:${Buffer.from(value, 'utf-8').toString('base64url')}`;
}

/**
 * Web link to a build.
 * @param {string | undefined} buildTypeId
 * @param {number | string} buildId
 * @returns {string}
 */
export function buildUrl(buildTypeId, buildId) {
  return `${TC_BASE}/buildConfiguration/${buildTypeId}/${buildId}`;
}

// ── Change (commit) helpers ──────────────────────────────────────────────

/** @typedef {{ version?: string, username?: string, user?: { name?: string }, comment?: string, files?: { file?: Array<{ file: string }> } }} TcChange */

/**
 * @param {TcChange} change
 * @returns {string}
 */
export function commitAuthor(change) {
  return change.user?.name || change.username || 'unknown';
}

/**
 * @param {TcChange} change
 * @returns {string}
 */
export function shortSha(change) {
  return (change.version || '').slice(0, 8);
}

/**
 * First line of the commit message.
 * @param {TcChange} change
 * @returns {string}
 */
export function commitTitle(change) {
  return (change.comment || '').split('\n')[0].trim();
}

/**
 * Paths of the files a change touched.
 * @param {TcChange} change
 * @returns {string[]}
 */
export function changedFiles(change) {
  return (change.files?.file || []).map((f) => f.file);
}
