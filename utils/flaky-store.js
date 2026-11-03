import { mkdirSync, readFileSync } from 'node:fs';
import { rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { config, resolvePath } from '../config.js';
import { isInfraKill } from '../integrations/test-history.js';

// Failure log per build configuration. TeamCity only notifies Slack about
// failed builds, so this records which tests failed and when -- it is not a
// pass/fail history. Fail rates always come from TeamCity
// (integrations/test-history.js getTestHistory).

const DATA_DIR = join(resolvePath(config.dataDir), 'flaky');
const MAX_RUNS_PER_TEST = 60;
const MAX_BUILDS = 300;

mkdirSync(DATA_DIR, { recursive: true });

/** @typedef {{ buildId: number, status: 'FAILURE' | 'SUCCESS', ts: number, buildNumber?: string }} TestRun */
/** @typedef {{ name: string, shortName: string, runs: TestRun[], lastSeen: number, lastFailed: number }} TestEntry */
/** @typedef {{ configId: string, tests: Record<string, TestEntry>, builds: Record<string, { ts: number, failedTests: string[] }> }} StoreData */

/** @type {Map<string, StoreData>} */
const cache = new Map();

function filePath(configId) {
  const safe = configId.replace(/[^a-zA-Z0-9_-]/g, '_');
  return join(DATA_DIR, `${safe}.json`);
}

/** @returns {StoreData} */
function load(configId) {
  if (cache.has(configId)) return cache.get(configId);
  const fp = filePath(configId);
  try {
    const raw = readFileSync(fp, 'utf-8');
    const data = JSON.parse(raw);
    cache.set(configId, data);
    return data;
  } catch {
    const empty = { configId, tests: {}, builds: {} };
    cache.set(configId, empty);
    return empty;
  }
}

/** @type {Map<string, Promise<void>>} last pending write per config */
const pendingWrites = new Map();

/**
 * Persist a config's log without blocking the event loop. Writes for the same
 * config are chained so they land in order, and each goes to a temp file that
 * is renamed into place, so a crash never leaves a half-written file.
 * @param {string} configId
 * @returns {Promise<void>}
 */
function save(configId) {
  const data = cache.get(configId);
  if (!data) return Promise.resolve();
  const target = filePath(configId);
  const previous = pendingWrites.get(configId) || Promise.resolve();
  const write = previous
    .then(async () => {
      const tmp = `${target}.tmp`;
      await writeFile(tmp, JSON.stringify(data), 'utf-8');
      await rename(tmp, target);
    })
    .catch((e) => console.error(`Failure log write failed for ${configId}: ${e}`));
  pendingWrites.set(configId, write);
  return write;
}

/**
 * Resolves once every write started so far has finished (for shutdown and tests).
 * @returns {Promise<void>}
 */
export async function flushFailureLog() {
  await Promise.all(pendingWrites.values());
}

function testKey(name) {
  let h = 0;
  for (let i = 0; i < name.length; i++) {
    h = ((h << 5) - h + name.charCodeAt(i)) | 0;
  }
  return `t${(h >>> 0).toString(36)}`;
}

/**
 * Keep the newest MAX_BUILDS builds, and drop tests that have not appeared in
 * any of them, so renamed or deleted tests do not accumulate forever.
 * @param {StoreData} data
 * @returns {void}
 */
function pruneBuilds(data) {
  const ids = Object.keys(data.builds);
  if (ids.length <= MAX_BUILDS) return;
  const sorted = ids.sort((a, b) => data.builds[a].ts - data.builds[b].ts);
  const toRemove = sorted.slice(0, ids.length - MAX_BUILDS);
  for (const id of toRemove) delete data.builds[id];

  const kept = new Set(Object.keys(data.builds));
  for (const [key, entry] of Object.entries(data.tests)) {
    if (!entry.runs.some((r) => kept.has(String(r.buildId)))) delete data.tests[key];
  }
}

/**
 * Record test results from a completed build. Infra kills (host OOM
 * SIGKILLing a test worker, see isInfraKill) are skipped: they say nothing
 * about the test and would poison the flaky-rate stats.
 * @param {string} configId
 * @param {number} buildId
 * @param {string} buildNumber
 * @param {Array<{ name: string, status: 'FAILURE' | 'SUCCESS', details?: string }>} testResults
 * @param {(name: string) => string} shortNameFn
 */
export function recordBuildResults(configId, buildId, buildNumber, testResults, shortNameFn) {
  const data = load(configId);
  const ts = Date.now();
  const bidStr = String(buildId);

  if (data.builds[bidStr]) return;

  const failedKeys = [];

  for (const { name, status, details } of testResults) {
    if (isInfraKill({ name, details })) continue;
    const key = testKey(name);
    if (!data.tests[key]) {
      data.tests[key] = { name, shortName: shortNameFn(name), runs: [], lastSeen: 0, lastFailed: 0 };
    }
    const entry = data.tests[key];
    entry.runs.push({ buildId, status, ts, buildNumber });
    if (entry.runs.length > MAX_RUNS_PER_TEST) {
      entry.runs = entry.runs.slice(-MAX_RUNS_PER_TEST);
    }
    entry.lastSeen = ts;
    if (status === 'FAILURE') {
      entry.lastFailed = ts;
      failedKeys.push(key);
    }
  }

  data.builds[bidStr] = { ts, failedTests: failedKeys };
  pruneBuilds(data);
  void save(configId);
}

/**
 * Tests with logged failures in the last `days`, most failures first.
 * @param {string} configId
 * @param {number} days
 * @returns {Array<{ name: string, shortName: string, failures: number, lastFailed: number }>}
 */
export function getRecentFailures(configId, days) {
  const data = load(configId);
  const cutoff = Date.now() - days * 86_400_000;
  const results = [];
  for (const entry of Object.values(data.tests)) {
    const failures = entry.runs.filter((r) => r.status === 'FAILURE' && r.ts >= cutoff).length;
    if (failures > 0)
      results.push({ name: entry.name, shortName: entry.shortName, failures, lastFailed: entry.lastFailed });
  }
  results.sort((a, b) => b.failures - a.failures);
  return results;
}

/**
 * Search logged tests by partial name match.
 * @param {string} configId
 * @param {string} query
 * @returns {Array<{ name: string, shortName: string, failures: number, lastFailed: number }>}
 */
export function searchTests(configId, query) {
  const data = load(configId);
  const q = query.toLowerCase();
  const results = [];

  for (const entry of Object.values(data.tests)) {
    if (!entry.name.toLowerCase().includes(q) && !entry.shortName.toLowerCase().includes(q)) continue;
    results.push({
      name: entry.name,
      shortName: entry.shortName,
      failures: entry.runs.filter((r) => r.status === 'FAILURE').length,
      lastFailed: entry.lastFailed,
    });
  }

  results.sort((a, b) => b.failures - a.failures);
  return results.slice(0, 20);
}
