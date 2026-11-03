import { locatorValue, tcApi } from './teamcity.js';

// TeamCity is the single source of truth for pass/fail history. The local
// flaky store only logs which tests failed (build notifications carry
// failures only), so it is used to find candidate tests and to resolve
// partial names -- never to compute fail rates.

/** Fail rate from which a test counts as flaky. */
export const FLAKY_MIN_RATE = 0.15;
/** Fail rate from which a test counts as broken rather than flaky. */
export const BROKEN_MIN_RATE = 0.9;
/** Runs needed before a test is classified at all. */
export const MIN_RUNS = 3;
/** Upper bound on runs fetched per test from TeamCity. */
export const MAX_HISTORY_RUNS = 60;

/** @typedef {{ status: 'FAILURE' | 'SUCCESS', buildId: number | null, buildNumber: string, ts: number }} TestRun */

/**
 * Parse a TeamCity timestamp such as `20261029T094450+0100`.
 * @param {string | undefined} value
 * @returns {number} epoch milliseconds, or 0 when missing/unparseable
 */
export function parseTcDate(value) {
  const m = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})([+-]\d{2})(\d{2})$/.exec(value || '');
  if (!m) return 0;
  const [, y, mo, d, h, mi, s, tzh, tzm] = m;
  const ts = Date.parse(`${y}-${mo}-${d}T${h}:${mi}:${s}${tzh}:${tzm}`);
  return Number.isNaN(ts) ? 0 : ts;
}

/**
 * A test's recent pass/fail history for a build config, from TeamCity.
 * Runs are newest first; muted/ignored occurrences are not counted.
 * @param {string} testName
 * @param {string} configId
 * @param {number} count
 * @returns {Promise<{passes: number, failures: number, total: number, rate: number, runs: TestRun[]}>}
 *   rate is -1 when TeamCity could not be queried
 */
export async function getTestHistory(testName, configId, count = 10) {
  try {
    const data = await tcApi(
      `/app/rest/testOccurrences?locator=test:(name:${locatorValue(testName)}),buildType:(id:${configId}),count:${count}` +
        '&fields=testOccurrence(status,build(id,number,finishDate))',
    );
    /** @type {TestRun[]} */
    /** @type {Array<{ status: string, build?: { id?: number, number?: string, finishDate?: string } }>} */
    const occurrences = data.testOccurrence || [];
    const runs = occurrences
      .filter((o) => o.status === 'FAILURE' || o.status === 'SUCCESS')
      .map((o) => ({
        status: /** @type {'FAILURE' | 'SUCCESS'} */ (o.status),
        buildId: o.build?.id ?? null,
        buildNumber: o.build?.number || '',
        ts: parseTcDate(o.build?.finishDate),
      }));
    const failures = runs.filter((r) => r.status === 'FAILURE').length;
    const passes = runs.length - failures;
    return { passes, failures, total: runs.length, rate: runs.length > 0 ? failures / runs.length : 0, runs };
  } catch (err) {
    console.error(`getTestHistory failed for "${testName}": ${err}`);
    return { passes: -1, failures: -1, total: 0, rate: -1, runs: [] };
  }
}

/**
 * Classify a test based on its failure rate across recent runs.
 * @param {number} rate - failure rate (0-1)
 * @param {number} total - total runs checked
 * @returns {'flaky' | 'broken' | 'rare' | 'unknown'}
 */
export function classifyTest(rate, total) {
  if (rate < 0) return 'unknown';
  if (total < MIN_RUNS) return 'unknown';
  if (rate >= BROKEN_MIN_RATE) return 'broken';
  if (rate >= FLAKY_MIN_RATE) return 'flaky';
  return 'rare';
}

/** Synthetic occurrence TeamCity's Jest reporter emits when a suite's worker process died instead of running. */
export const INFRA_KILL_NAME_SUFFIX = 'Jest failed to execute suite';
/** Jest's message when the worker was killed from outside — on CI agents that is the kernel OOM killer. */
const INFRA_KILL_DETAILS_MARKER = 'terminated by another process: signal=SIGKILL';

/**
 * True when a failed test occurrence is the host killing the test process
 * (kernel OOM killer SIGKILLing a Jest worker), not a test failing. Such
 * occurrences carry no signal about the code under test: they must not be
 * blamed on commits and must stay out of the failure log.
 * @param {{ name?: string, details?: string }} occurrence
 * @returns {boolean}
 */
export function isInfraKill(occurrence) {
  if ((occurrence?.name || '').trimEnd().endsWith(INFRA_KILL_NAME_SUFFIX)) return true;
  return (occurrence?.details || '').includes(INFRA_KILL_DETAILS_MARKER);
}

/**
 * Fail rates in the last `days` vs the `days` before that.
 * @param {TestRun[]} runs
 * @param {number} days
 * @param {number} [now]
 * @returns {{ recentRate: number, olderRate: number, delta: number, recentRuns: number, olderRuns: number }}
 */
export function compareWindows(runs, days, now = Date.now()) {
  const cutoff = now - days * 86_400_000;
  const olderCutoff = cutoff - days * 86_400_000;
  const recent = runs.filter((r) => r.ts >= cutoff);
  const older = runs.filter((r) => r.ts >= olderCutoff && r.ts < cutoff);
  /** @param {TestRun[]} rs */
  const rate = (rs) => (rs.length > 0 ? rs.filter((r) => r.status === 'FAILURE').length / rs.length : 0);
  const recentRate = rate(recent);
  const olderRate = rate(older);
  return { recentRate, olderRate, delta: recentRate - olderRate, recentRuns: recent.length, olderRuns: older.length };
}
