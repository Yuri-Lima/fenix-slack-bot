import { tool } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import { getRecentFailures, searchTests } from '../../utils/flaky-store.js';
import { andMore, shortTestName, textResult } from '../../utils/helpers.js';
import { EXAMPLE_CONFIG, KEY_CONFIGS_HINT, locatorValue, tcApi } from './teamcity.js';

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
/** Fail-rate increase between two windows that counts as getting worse. */
const WORSENING_DELTA = 0.1;
/** Upper bound on runs fetched per test from TeamCity. */
const MAX_HISTORY_RUNS = 60;
/** Upper bound on candidate tests checked per tool call (each costs one TeamCity request). */
const MAX_CANDIDATES = 20;

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

/** @param {number} pct */
function failRateBar(pct) {
  const red = Math.round(pct / 20);
  return ':red_circle:'.repeat(red) + ':large_green_circle:'.repeat(5 - red);
}

/**
 * Names of tests that failed in the most recent failed builds of a config.
 * @param {string} configId
 * @param {number} builds
 * @returns {Promise<string[]>}
 */
async function recentlyFailedInTeamCity(configId, builds) {
  const buildData = await tcApi(
    `/app/rest/builds?locator=count:${builds},buildType:(id:${encodeURIComponent(configId)}),status:FAILURE&fields=build(id)`,
  );
  /** @type {Array<{ id: number }>} */
  const failedBuilds = buildData.build || [];
  const lists = await Promise.all(
    failedBuilds.map((b) =>
      tcApi(`/app/rest/testOccurrences?locator=build:(id:${b.id}),status:FAILURE&fields=testOccurrence(name)`),
    ),
  );
  return lists.flatMap((l) => (l.testOccurrence || []).map((/** @type {{ name: string }} */ t) => t.name));
}

export const flakyTestsTool = tool(
  'teamcity_flaky_tests',
  'Scan for flaky tests (tests that pass sometimes and fail other times). Candidates come from recent failed ' +
    'builds and the failure log; every fail rate is computed from TeamCity history. ' +
    KEY_CONFIGS_HINT.trim(),
  {
    config_id: z.string().describe(`Build configuration ID, e.g. '${EXAMPLE_CONFIG}'.`),
    days: z.number().optional().describe('Also consider tests logged as failing in the last N days (default 30).'),
    builds: z.number().optional().describe('Number of recent failed builds to scan for candidates (default 10).'),
    history: z.number().optional().describe('Number of recent runs to check per test (default 15).'),
  },
  async ({ config_id, days = 30, builds: rawBuilds = 10, history: rawHistory = 15 }) => {
    const builds = Math.min(rawBuilds, 25);
    const historyCount = Math.min(rawHistory, MAX_HISTORY_RUNS);
    try {
      const candidateCounts = new Map();
      for (const name of await recentlyFailedInTeamCity(config_id, builds)) {
        candidateCounts.set(name, (candidateCounts.get(name) || 0) + 1);
      }
      for (const { name, failures } of getRecentFailures(config_id, days)) {
        candidateCounts.set(name, (candidateCounts.get(name) || 0) + failures);
      }
      if (candidateCounts.size === 0) {
        return textResult(`No test failures found for \`${config_id}\` in recent builds or the last ${days} days.`);
      }

      const candidates = [...candidateCounts.entries()]
        .sort((a, b) => b[1] - a[1])
        .slice(0, MAX_CANDIDATES)
        .map(([name]) => name);
      const histories = await Promise.all(candidates.map((name) => getTestHistory(name, config_id, historyCount)));

      /** @type {Array<{ shortName: string, pct: number, passes: number, failures: number, total: number }>} */
      const results = [];
      let broken = 0;
      candidates.forEach((name, i) => {
        const hist = histories[i];
        const classification = classifyTest(hist.rate, hist.total);
        if (classification === 'broken') broken++;
        if (classification !== 'flaky') return;
        results.push({ shortName: shortTestName(name), pct: Math.round(hist.rate * 100), ...hist });
      });
      results.sort((a, b) => b.pct - a.pct);

      if (results.length === 0) {
        const brokenNote = broken > 0 ? ` ${broken} test(s) are failing consistently (broken, not flaky).` : '';
        return textResult(
          `No flaky tests detected among ${candidates.length} recent failures in \`${config_id}\`.${brokenNote}`,
        );
      }

      const lines = [
        `**${results.length} flaky test(s) in \`${config_id}\`** (${candidates.length} recently failing tests checked, up to ${historyCount} runs each):\n`,
      ];
      for (const r of results.slice(0, 15)) {
        lines.push(`${failRateBar(r.pct)} **${r.pct}%** fail rate \`${r.shortName}\``);
        lines.push(`  _${r.failures}F / ${r.passes}P out of ${r.total} runs_`);
      }
      const more = andMore(results.length, 15);
      if (more) lines.push(more);
      return textResult(lines.join('\n'));
    } catch (e) {
      return textResult(`Flaky tracker error: ${e.message}`, true);
    }
  },
);

export const flakyTrendsTool = tool(
  'teamcity_flaky_trends',
  'Show tests whose fail rate got worse recently, comparing the last N days with the N days before. ' +
    'Candidates come from the failure log; rates come from TeamCity history.',
  {
    config_id: z.string().describe(`Build configuration ID, e.g. '${EXAMPLE_CONFIG}'.`),
    days: z.number().optional().describe('Compare last N days vs the N days before that (default 7).'),
  },
  async ({ config_id, days = 7 }) => {
    const candidates = getRecentFailures(config_id, days * 2).slice(0, MAX_CANDIDATES);
    if (candidates.length === 0) {
      return textResult(
        `No failures logged for \`${config_id}\` in the last ${days * 2} days, so there is nothing to compare. ` +
          'The failure log fills up as build failure notifications arrive.',
      );
    }

    try {
      const histories = await Promise.all(candidates.map((c) => getTestHistory(c.name, config_id, MAX_HISTORY_RUNS)));
      const worsening = candidates
        .map((c, i) => ({ shortName: c.shortName, ...compareWindows(histories[i].runs, days) }))
        .filter((t) => t.recentRuns >= 2 && t.olderRuns >= 2 && t.delta > WORSENING_DELTA)
        .sort((a, b) => b.delta - a.delta);

      if (worsening.length === 0) {
        return textResult(`No tests got significantly worse in \`${config_id}\` over the last ${days} days.`);
      }

      const lines = [
        `**${worsening.length} test(s) getting worse in \`${config_id}\`** (last ${days}d vs prior ${days}d):\n`,
      ];
      for (const t of worsening.slice(0, 10)) {
        const oldPct = Math.round(t.olderRate * 100);
        const newPct = Math.round(t.recentRate * 100);
        const deltaPct = Math.round(t.delta * 100);
        lines.push(`:chart_with_upwards_trend: \`${t.shortName}\``);
        lines.push(`  ${oldPct}% :arrow_right: ${newPct}% (+${deltaPct}pp, ${t.recentRuns} recent runs)`);
      }
      const more = andMore(worsening.length, 10);
      if (more) lines.push(more);
      return textResult(lines.join('\n'));
    } catch (e) {
      return textResult(`Flaky trends error: ${e.message}`, true);
    }
  },
);

export const testTimelineTool = tool(
  'teamcity_test_timeline',
  'Show the pass/fail timeline for a specific test. Use this to answer "when did test X start failing?" ' +
    'or "what is the history of this test?". Partial names are matched against tests that have failed before.',
  {
    config_id: z.string().describe(`Build configuration ID, e.g. '${EXAMPLE_CONFIG}'.`),
    test_name: z.string().describe('Full or partial test name to look up.'),
  },
  async ({ config_id, test_name }) => {
    const matches = searchTests(config_id, test_name);
    const exact = matches.find((m) => m.name === test_name);
    if (!exact && matches.length > 1) {
      const lines = [`Multiple matches for "${test_name}":\n`];
      for (const m of matches.slice(0, 10)) {
        lines.push(`- \`${m.shortName}\` (${m.failures} logged failures)`);
      }
      lines.push('\nUse a more specific name to see the full timeline.');
      return textResult(lines.join('\n'));
    }
    const name = exact?.name || matches[0]?.name || test_name;

    const hist = await getTestHistory(name, config_id, 20);
    if (hist.rate < 0) return textResult(`Could not load history for "${test_name}" from TeamCity.`, true);
    if (hist.total === 0) return textResult(`No runs of "${test_name}" found in TeamCity for \`${config_id}\`.`);

    const pct = Math.round(hist.rate * 100);
    const lastFail = hist.runs.find((r) => r.status === 'FAILURE');
    const lastFailDate = lastFail?.ts ? new Date(lastFail.ts).toISOString().slice(0, 10) : 'not in these runs';
    const chronological = [...hist.runs].reverse();

    const lines = [
      `**${shortTestName(name)}**`,
      `Fail rate: **${pct}%** over the last ${hist.total} runs (${classifyTest(hist.rate, hist.total)})`,
      `Last failed: ${lastFailDate}\n`,
      '*Recent runs (oldest → newest):*',
      chronological.map((r) => (r.status === 'FAILURE' ? ':red_circle:' : ':large_green_circle:')).join(''),
      chronological
        .map((r) => {
          const d = r.ts ? new Date(r.ts).toISOString().slice(5, 10) : '--';
          const build = r.buildNumber ? ` #${r.buildNumber}` : '';
          return `  ${d} ${r.status === 'FAILURE' ? 'F' : 'P'}${build}`;
        })
        .join('\n'),
    ];
    return textResult(lines.join('\n'));
  },
);
