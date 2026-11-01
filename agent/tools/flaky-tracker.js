import { tool } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import {
  getFlakyTests,
  getStoredHistory,
  getStoreSummary,
  getTestTimeline,
  getWorseningTests,
  searchTests,
} from '../../utils/flaky-store.js';
import { shortTestName, textResult } from '../../utils/helpers.js';
import { EXAMPLE_CONFIG, KEY_CONFIGS_HINT, locatorValue, tcApi } from './teamcity.js';

/**
 * Check a test's recent pass/fail history for a build config.
 * @param {string} testName
 * @param {string} configId
 * @param {number} count
 * @returns {Promise<{passes: number, failures: number, total: number, rate: number}>}
 */
export async function getTestHistory(testName, configId, count = 10) {
  const stored = getStoredHistory(configId, testName);
  if (stored && stored.total >= count) {
    const recent = stored.runs.slice(-count);
    const failures = recent.filter((r) => r.status === 'FAILURE').length;
    const passes = recent.length - failures;
    return { passes, failures, total: recent.length, rate: failures / recent.length };
  }

  try {
    const data = await tcApi(
      `/app/rest/testOccurrences?locator=test:(name:${locatorValue(testName)}),buildType:(id:${configId}),count:${count}&fields=testOccurrence(status)`,
    );
    const runs = data.testOccurrence || [];
    const failures = runs.filter((r) => r.status === 'FAILURE').length;
    const passes = runs.filter((r) => r.status === 'SUCCESS').length;
    const total = runs.length;
    const rate = total > 0 ? failures / total : 0;
    return { passes, failures, total, rate };
  } catch (err) {
    console.error(`getTestHistory failed for "${testName}": ${err}`);
    return { passes: -1, failures: -1, total: 0, rate: -1 };
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
  if (total < 3) return 'unknown';
  if (rate >= 0.9) return 'broken';
  if (rate >= 0.15) return 'flaky';
  return 'rare';
}

function trendEmoji(trend) {
  if (trend === 'worsening') return ':chart_with_upwards_trend:';
  if (trend === 'improving') return ':chart_with_downwards_trend:';
  return ':left_right_arrow:';
}

export const flakyTestsTool = tool(
  'teamcity_flaky_tests',
  'Scan for flaky tests (tests that pass sometimes and fail other times). ' +
    'Uses persistent history when available, falls back to live TeamCity API. ' +
    KEY_CONFIGS_HINT.trim(),
  {
    config_id: z.string().describe(`Build configuration ID, e.g. '${EXAMPLE_CONFIG}'.`),
    days: z.number().optional().describe('Look back this many days (default 30). Uses stored history.'),
    builds: z
      .number()
      .optional()
      .describe('Number of recent builds to scan via TC API if no stored data (default 10).'),
    history: z.number().optional().describe('Number of historical runs to check per test via TC API (default 15).'),
  },
  async ({ config_id, days = 30, builds: rawBuilds = 10, history: rawHistory = 15 }) => {
    const summary = getStoreSummary(config_id);

    if (summary.buildCount >= 5) {
      const flaky = getFlakyTests(config_id, { days, minRuns: 3 });
      if (flaky.length === 0) {
        return textResult(
          `No flaky tests found in \`${config_id}\` over the last ${days} days (${summary.buildCount} builds tracked).`,
        );
      }

      const lines = [
        `**${flaky.length} flaky test(s) in \`${config_id}\`** (last ${days} days, ${summary.buildCount} builds tracked):\n`,
      ];
      for (const t of flaky.slice(0, 15)) {
        const pct = Math.round(t.failRate * 100);
        const bar =
          ':red_circle:'.repeat(Math.round(pct / 20)) + ':large_green_circle:'.repeat(5 - Math.round(pct / 20));
        lines.push(`${bar} **${pct}%** fail rate ${trendEmoji(t.trend)} \`${t.shortName}\``);
        lines.push(`  _${t.failures}F / ${t.passes}P out of ${t.total} runs_`);
      }
      if (flaky.length > 15) lines.push(`  ... and ${flaky.length - 15} more`);
      return textResult(lines.join('\n'));
    }

    const builds = Math.min(rawBuilds, 25);
    const historyCount = Math.min(rawHistory, 30);
    try {
      const safeConfigId = encodeURIComponent(config_id);
      const buildData = await tcApi(
        `/app/rest/builds?locator=count:${builds},buildType:(id:${safeConfigId}),status:FAILURE&fields=build(id,number)`,
      );
      const buildList = buildData.build || [];

      if (buildList.length === 0) {
        return textResult(`No recent failed builds found for \`${config_id}\`.`);
      }

      const testSet = new Map();
      for (const build of buildList) {
        const failData = await tcApi(
          `/app/rest/testOccurrences?locator=build:(id:${build.id}),status:FAILURE&fields=testOccurrence(name)`,
        );
        for (const t of failData.testOccurrence || []) {
          if (!testSet.has(t.name)) testSet.set(t.name, 0);
          testSet.set(t.name, testSet.get(t.name) + 1);
        }
      }

      const candidates = [...testSet.entries()]
        .filter(([, count]) => count < buildList.length)
        .sort((a, b) => b[1] - a[1]);

      if (candidates.length === 0) {
        const alwaysFailing = testSet.size;
        return textResult(
          alwaysFailing > 0
            ? `No flaky tests found. ${alwaysFailing} test(s) fail consistently across all ${buildList.length} builds.`
            : `No test failures found in the last ${buildList.length} builds.`,
        );
      }

      const toAnalyze = candidates.slice(0, 20);
      const results = [];

      for (const [testName] of toAnalyze) {
        const hist = await getTestHistory(testName, config_id, historyCount);
        const classification = classifyTest(hist.rate, hist.total);
        if (classification === 'flaky') {
          const sn = shortTestName(testName);
          const pct = Math.round(hist.rate * 100);
          results.push({ shortName: sn, pct, passes: hist.passes, failures: hist.failures, total: hist.total });
        }
      }

      results.sort((a, b) => b.pct - a.pct);

      if (results.length === 0) {
        return textResult(`No flaky tests detected in \`${config_id}\` across ${buildList.length} recent builds.`);
      }

      const lines = [
        `**${results.length} flaky test(s) in \`${config_id}\`** (last ${buildList.length} builds, ${historyCount} runs each):\n`,
      ];
      lines.push('_Note: building up persistent history. Future queries will be faster._\n');
      for (const r of results) {
        const bar =
          ':red_circle:'.repeat(Math.round(r.pct / 20)) + ':large_green_circle:'.repeat(5 - Math.round(r.pct / 20));
        lines.push(`${bar} **${r.pct}%** fail rate \`${r.shortName}\``);
        lines.push(`  _${r.failures}F / ${r.passes}P out of ${r.total} runs_`);
      }

      return textResult(lines.join('\n'));
    } catch (e) {
      return textResult(`Flaky tracker error: ${e.message}`);
    }
  },
);

export const flakyTrendsTool = tool(
  'teamcity_flaky_trends',
  'Show tests whose flakiness got worse recently. Compares fail rates between two time windows ' +
    'to surface tests that are deteriorating. Requires persistent history (builds up over time).',
  {
    config_id: z.string().describe(`Build configuration ID, e.g. '${EXAMPLE_CONFIG}'.`),
    days: z.number().optional().describe('Compare last N days vs the N days before that (default 7).'),
  },
  async ({ config_id, days = 7 }) => {
    const summary = getStoreSummary(config_id);
    if (summary.buildCount < 5) {
      return textResult(
        `Not enough stored data for \`${config_id}\` yet (${summary.buildCount} builds). ` +
          'Trends build up automatically as build notifications arrive.',
      );
    }

    const worsening = getWorseningTests(config_id, { days });
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
    if (worsening.length > 10) lines.push(`  ... and ${worsening.length - 10} more`);

    return textResult(lines.join('\n'));
  },
);

export const testTimelineTool = tool(
  'teamcity_test_timeline',
  'Show the pass/fail timeline for a specific test. Use this to answer "when did test X start failing?" ' +
    'or "what is the history of this test?". Search by partial name if unsure of the full name.',
  {
    config_id: z.string().describe(`Build configuration ID, e.g. '${EXAMPLE_CONFIG}'.`),
    test_name: z.string().describe('Full or partial test name to look up.'),
  },
  async ({ config_id, test_name }) => {
    let timeline = getTestTimeline(config_id, test_name);

    if (!timeline) {
      const matches = searchTests(config_id, test_name);
      if (matches.length === 0) {
        return textResult(
          `No stored history found for "${test_name}" in \`${config_id}\`. History builds up as build notifications arrive.`,
        );
      }
      if (matches.length === 1) {
        timeline = getTestTimeline(config_id, matches[0].name);
      } else {
        const lines = [`Multiple matches for "${test_name}":\n`];
        for (const m of matches.slice(0, 10)) {
          const pct = Math.round(m.failRate * 100);
          lines.push(`- \`${m.shortName}\` (${pct}% fail rate, ${m.total} runs)`);
        }
        lines.push('\nUse a more specific name to see the full timeline.');
        return textResult(lines.join('\n'));
      }
    }

    if (!timeline) return textResult(`No history found for "${test_name}".`);

    const pct = Math.round(timeline.failRate * 100);
    const firstDate = new Date(timeline.firstSeen).toISOString().slice(0, 10);
    const lastFailDate = timeline.lastFailed ? new Date(timeline.lastFailed).toISOString().slice(0, 10) : 'never';

    const lines = [
      `**${timeline.shortName}**`,
      `Overall fail rate: **${pct}%** across ${timeline.runs.length} recorded runs`,
      `First seen: ${firstDate} | Last failed: ${lastFailDate}\n`,
      '*Recent runs:*',
    ];

    const recent = timeline.runs.slice(-20);
    const runLine = recent.map((r) => (r.status === 'FAILURE' ? ':red_circle:' : ':large_green_circle:')).join('');
    lines.push(runLine);

    const recentDates = recent.map((r) => {
      const d = new Date(r.ts).toISOString().slice(5, 10);
      const status = r.status === 'FAILURE' ? 'F' : 'P';
      const build = r.buildNumber ? ` #${r.buildNumber}` : '';
      return `  ${d} ${status}${build}`;
    });
    lines.push(recentDates.join('\n'));

    return textResult(lines.join('\n'));
  },
);
