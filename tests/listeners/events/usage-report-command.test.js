import assert from 'node:assert';
import { describe, it } from 'node:test';

import { parseReportCommand } from '../../../listeners/events/usage-report-command.js';
import { buildUsageReportBlocks } from '../../../listeners/views/usage-report-builder.js';
import { aggregateUsage } from '../../../utils/usage-report.js';

describe('parseReportCommand', () => {
  it('accepts report and usage with an optional period', () => {
    assert.strictEqual(parseReportCommand('report'), '');
    assert.strictEqual(parseReportCommand('Usage 7d'), '7d');
    assert.strictEqual(parseReportCommand('report last-month!'), 'last-month');
  });

  it('leaves ordinary questions to the agent', () => {
    assert.strictEqual(parseReportCommand('report the build failures from today'), null);
    assert.strictEqual(parseReportCommand('what does the usage of DocumentService look like?'), null);
  });
});

describe('buildUsageReportBlocks', () => {
  it('shows totals, breakdowns and a zero-token note', () => {
    const stats = aggregateUsage(
      [
        {
          ts: '2026-11-10T10:00:00Z',
          kind: 'agent',
          outcome: 'ok',
          userName: 'Owner',
          where: 'dm',
          models: {
            'claude-sonnet-4-5-20250929': { input: 2000, output: 800, cacheRead: 0, cacheWrite: 0, costUsd: 0.04 },
          },
          costUsd: 0.04,
          turns: 3,
          durationMs: 8000,
          tools: { youtrack_search: 1 },
        },
      ],
      'this month',
    );
    const blocks = buildUsageReportBlocks(stats);
    assert.strictEqual(blocks[0].text.text, ':bar_chart: Fenix usage · this month');
    const text = JSON.stringify(blocks);
    for (const part of [
      'Agent replies',
      'By model',
      'sonnet-4-5',
      'By user',
      'By day',
      'youtrack_search',
      '0 AI tokens',
    ]) {
      assert.ok(text.includes(part), part);
    }
  });

  it('says so when nothing was recorded', () => {
    const blocks = buildUsageReportBlocks(aggregateUsage([], 'last 24 hours'));
    assert.match(blocks[1].text.text, /No usage recorded/);
  });
});
