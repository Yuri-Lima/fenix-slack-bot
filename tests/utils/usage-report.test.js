import assert from 'node:assert';
import { describe, it } from 'node:test';

import {
  aggregateUsage,
  compact,
  formatUsageFooter,
  formatUsageSummary,
  money,
  parsePeriod,
  shortModel,
} from '../../utils/usage-report.js';

const run = (overrides = {}) => ({
  ts: '2026-11-10T10:00:00Z',
  kind: 'agent',
  outcome: 'ok',
  userName: 'Owner',
  where: 'dm',
  models: {
    'claude-sonnet-4-5-20250929': { input: 2000, output: 800, cacheRead: 90_000, cacheWrite: 300, costUsd: 0.04 },
  },
  costUsd: 0.04,
  turns: 3,
  durationMs: 8000,
  tools: { teamcity_list_builds: 2 },
  ...overrides,
});

describe('formatting helpers', () => {
  it('shortens model IDs and numbers', () => {
    assert.strictEqual(shortModel('claude-sonnet-4-5-20250929'), 'sonnet-4-5');
    assert.strictEqual(compact(845), '845');
    assert.strictEqual(compact(12_345), '12.3k');
    assert.strictEqual(compact(1_234_567), '1.23M');
    assert.strictEqual(money(0.004), '<$0.01');
    assert.strictEqual(money(14.2), '$14.20');
  });

  it('writes the reply footer with model, tokens, cost, steps, time and month', () => {
    assert.strictEqual(
      formatUsageFooter(run(), { tokens: 1_234_567, costUsd: 14.2 }),
      ':robot_face: sonnet-4-5  ·  2.3k in · 800 out · 90.0k cache  ·  $0.04  ·  3 steps  ·  8.0 s  ·  month: 1.23M tokens · $14.20',
    );
  });
});

describe('parsePeriod', () => {
  const now = new Date('2026-11-13T12:00:00Z');
  it('understands this month, last month, relative windows and explicit months', () => {
    assert.strictEqual(parsePeriod('', now).from.toISOString(), '2026-11-01T00:00:00.000Z');
    const last = parsePeriod('last-month', now);
    assert.strictEqual(last.label, '2026-10');
    assert.strictEqual(last.to.toISOString(), '2026-10-31T23:59:59.999Z');
    assert.strictEqual(parsePeriod('7d', now).from.toISOString(), '2026-11-06T12:00:00.000Z');
    assert.strictEqual(parsePeriod('24h', now).label, 'last 24 hours');
    assert.strictEqual(parsePeriod('2026-09', now).label, '2026-09');
    assert.strictEqual(parsePeriod('yesterday', now), null);
  });
});

describe('aggregateUsage', () => {
  const records = [
    run(),
    run({ ts: '2026-11-11T09:00:00Z', userName: 'Dev', where: 'channel', costUsd: 0.2, turns: 7 }),
    run({ outcome: 'timeout', models: {}, costUsd: 0, turns: 0 }),
    {
      ts: '2026-11-11T09:30:00Z',
      kind: 'grafana',
      outcome: 'ok',
      models: {},
      costUsd: 0,
      turns: 0,
      durationMs: 900,
      tools: {},
    },
  ];

  it('totals tokens, cost, outcomes and cache share', () => {
    const s = aggregateUsage(records, 'test');
    assert.strictEqual(s.runs, 3);
    assert.deepStrictEqual(s.outcomes, { ok: 2, timeout: 1 });
    assert.strictEqual(s.tokens.cached, 180_000);
    assert.ok(Math.abs(s.costUsd - 0.24) < 1e-9);
    assert.ok(s.cacheShare > 0.9);
    assert.deepStrictEqual(s.analyses, { grafana: 1 });
  });

  it('ranks users and replies by cost and counts tool calls', () => {
    const s = aggregateUsage(records, 'test');
    assert.strictEqual(s.byUser[0].name, 'Dev');
    assert.strictEqual(s.costliest[0].turns, 7);
    assert.deepStrictEqual(s.tools[0], { name: 'teamcity_list_builds', calls: 6 });
    assert.deepStrictEqual(s.byWhere, { dm: 2, channel: 1 });
  });

  it('summarises in a few lines for the agent tool', () => {
    const text = formatUsageSummary(aggregateUsage(records, 'test'));
    assert.match(text, /^Usage test: 3 agent replies/);
    assert.match(text, /Rule-based analyses \(0 tokens\): grafana 1/);
    assert.ok(text.length < 1500);
  });
});
