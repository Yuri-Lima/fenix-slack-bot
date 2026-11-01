import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const DATA_DIR = join(import.meta.dirname, '..', 'data', 'flaky');
const MAX_RUNS_PER_TEST = 60;
const MAX_BUILDS = 300;

if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true });

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

function save(configId) {
  const data = cache.get(configId);
  if (!data) return;
  writeFileSync(filePath(configId), JSON.stringify(data), 'utf-8');
}

function testKey(name) {
  let h = 0;
  for (let i = 0; i < name.length; i++) {
    h = ((h << 5) - h + name.charCodeAt(i)) | 0;
  }
  return `t${(h >>> 0).toString(36)}`;
}

function pruneBuilds(data) {
  const ids = Object.keys(data.builds);
  if (ids.length <= MAX_BUILDS) return;
  const sorted = ids.sort((a, b) => data.builds[a].ts - data.builds[b].ts);
  const toRemove = sorted.slice(0, ids.length - MAX_BUILDS);
  for (const id of toRemove) delete data.builds[id];
}

/**
 * Record test results from a completed build.
 * @param {string} configId
 * @param {number} buildId
 * @param {string} buildNumber
 * @param {Array<{ name: string, status: 'FAILURE' | 'SUCCESS' }>} testResults
 * @param {(name: string) => string} shortNameFn
 */
export function recordBuildResults(configId, buildId, buildNumber, testResults, shortNameFn) {
  const data = load(configId);
  const ts = Date.now();
  const bidStr = String(buildId);

  if (data.builds[bidStr]) return;

  const failedKeys = [];

  for (const { name, status } of testResults) {
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
  save(configId);
}

/**
 * Get a test's stored history for a config.
 * @param {string} configId
 * @param {string} testName
 * @returns {{ runs: TestRun[], failRate: number, total: number } | null}
 */
export function getStoredHistory(configId, testName) {
  const data = load(configId);
  const key = testKey(testName);
  const entry = data.tests[key];
  if (!entry || entry.runs.length === 0) return null;
  const failures = entry.runs.filter((r) => r.status === 'FAILURE').length;
  return { runs: entry.runs, failRate: failures / entry.runs.length, total: entry.runs.length };
}

/**
 * Get all flaky tests for a config (fail rate between 15-90%).
 * @param {string} configId
 * @param {{ days?: number, minRuns?: number }} [opts]
 * @returns {Array<{ name: string, shortName: string, failRate: number, total: number, failures: number, passes: number, lastFailed: number, trend: 'worsening' | 'improving' | 'stable' }>}
 */
export function getFlakyTests(configId, opts = {}) {
  const { days = 30, minRuns = 3 } = opts;
  const data = load(configId);
  const cutoff = Date.now() - days * 86_400_000;
  const results = [];

  for (const entry of Object.values(data.tests)) {
    const recent = entry.runs.filter((r) => r.ts >= cutoff);
    if (recent.length < minRuns) continue;

    const failures = recent.filter((r) => r.status === 'FAILURE').length;
    const passes = recent.length - failures;
    const failRate = failures / recent.length;

    if (failRate < 0.15 || failRate > 0.9) continue;

    const trend = computeTrend(recent);
    results.push({
      name: entry.name,
      shortName: entry.shortName,
      failRate,
      total: recent.length,
      failures,
      passes,
      lastFailed: entry.lastFailed,
      trend,
    });
  }

  results.sort((a, b) => b.failRate - a.failRate);
  return results;
}

/**
 * Compare a test's recent fail rate to its older fail rate.
 * @param {TestRun[]} runs
 * @returns {'worsening' | 'improving' | 'stable'}
 */
function computeTrend(runs) {
  if (runs.length < 6) return 'stable';
  const mid = Math.floor(runs.length / 2);
  const older = runs.slice(0, mid);
  const newer = runs.slice(mid);
  const olderRate = older.filter((r) => r.status === 'FAILURE').length / older.length;
  const newerRate = newer.filter((r) => r.status === 'FAILURE').length / newer.length;
  const diff = newerRate - olderRate;
  if (diff > 0.15) return 'worsening';
  if (diff < -0.15) return 'improving';
  return 'stable';
}

/**
 * Get tests whose fail rate increased recently.
 * @param {string} configId
 * @param {{ days?: number }} [opts]
 */
export function getWorseningTests(configId, opts = {}) {
  const { days = 7 } = opts;
  const data = load(configId);
  const cutoff = Date.now() - days * 86_400_000;
  const olderCutoff = cutoff - days * 86_400_000;
  const results = [];

  for (const entry of Object.values(data.tests)) {
    const recent = entry.runs.filter((r) => r.ts >= cutoff);
    const older = entry.runs.filter((r) => r.ts >= olderCutoff && r.ts < cutoff);
    if (recent.length < 2 || older.length < 2) continue;

    const recentRate = recent.filter((r) => r.status === 'FAILURE').length / recent.length;
    const olderRate = older.filter((r) => r.status === 'FAILURE').length / older.length;
    const delta = recentRate - olderRate;

    if (delta > 0.1) {
      results.push({
        name: entry.name,
        shortName: entry.shortName,
        recentRate,
        olderRate,
        delta,
        recentRuns: recent.length,
      });
    }
  }

  results.sort((a, b) => b.delta - a.delta);
  return results;
}

/**
 * Get the full timeline for a specific test.
 * @param {string} configId
 * @param {string} testName
 * @returns {{ name: string, shortName: string, runs: TestRun[], firstSeen: number, lastFailed: number, failRate: number } | null}
 */
export function getTestTimeline(configId, testName) {
  const data = load(configId);
  const key = testKey(testName);
  const entry = data.tests[key];
  if (!entry || entry.runs.length === 0) return null;

  const failures = entry.runs.filter((r) => r.status === 'FAILURE').length;
  return {
    name: entry.name,
    shortName: entry.shortName,
    runs: entry.runs,
    firstSeen: entry.runs[0].ts,
    lastFailed: entry.lastFailed,
    failRate: failures / entry.runs.length,
  };
}

/**
 * Search tests by partial name match.
 * @param {string} configId
 * @param {string} query
 * @returns {Array<{ name: string, shortName: string, failRate: number, total: number, lastFailed: number }>}
 */
export function searchTests(configId, query) {
  const data = load(configId);
  const q = query.toLowerCase();
  const results = [];

  for (const entry of Object.values(data.tests)) {
    if (!entry.name.toLowerCase().includes(q) && !entry.shortName.toLowerCase().includes(q)) continue;
    const failures = entry.runs.filter((r) => r.status === 'FAILURE').length;
    results.push({
      name: entry.name,
      shortName: entry.shortName,
      failRate: entry.runs.length > 0 ? failures / entry.runs.length : 0,
      total: entry.runs.length,
      lastFailed: entry.lastFailed,
    });
  }

  results.sort((a, b) => b.failRate - a.failRate);
  return results.slice(0, 20);
}

/** Get summary stats for a config. */
export function getStoreSummary(configId) {
  const data = load(configId);
  const testCount = Object.keys(data.tests).length;
  const buildCount = Object.keys(data.builds).length;
  const timestamps = Object.values(data.builds).map((b) => b.ts);
  const oldest = timestamps.length > 0 ? Math.min(...timestamps) : 0;
  const newest = timestamps.length > 0 ? Math.max(...timestamps) : 0;
  return { testCount, buildCount, oldest, newest };
}
