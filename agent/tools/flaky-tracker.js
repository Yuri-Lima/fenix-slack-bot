import { tool } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import { tcApi } from '../../integrations/teamcity.js';
import { classifyTest, compareWindows, getTestHistory, MAX_HISTORY_RUNS } from '../../integrations/test-history.js';
import { getRecentFailures, searchTests } from '../../utils/flaky-store.js';
import { andMore, shortTestName, textResult } from '../../utils/helpers.js';
import { EXAMPLE_CONFIG, KEY_CONFIGS_HINT } from './teamcity.js';

/** Fail-rate increase between two windows that counts as getting worse. */
const WORSENING_DELTA = 0.1;
/** Upper bound on candidate tests checked per tool call (each costs one TeamCity request). */
const MAX_CANDIDATES = 20;

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
