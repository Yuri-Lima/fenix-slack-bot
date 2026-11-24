import assert from 'node:assert';
import { readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { after, before, describe, it, mock } from 'node:test';

// The bill (Usage and Cost API) and the usage log are faked: each test sets what they return
/** @type {{ days: Record<string, number>, refreshedAt: string | null }} */
let bill = { days: {}, refreshedAt: null };
/** @type {Array<{ ts: string, kind: string, costUsd: number }>} */
let records = [];
/** @type {Map<string, { monthUsd: number, dayUsd: number }>} */
let spend = new Map();
const billedCostByDay = mock.fn(async () => bill);

mock.module('../../integrations/anthropic-billing.js', {
  namedExports: { billingConfigured: () => true, billedCostByDay },
});
mock.module('../../utils/usage-store.js', {
  namedExports: {
    readRange: (/** @type {Date} */ from, /** @type {Date} */ to) =>
      records.filter((r) => r.ts >= from.toISOString() && r.ts <= to.toISOString()),
    spendByUser: () => new Map([...spend].map(([id, u]) => [id, { ...u }])),
    localDay: (/** @type {Date} */ d) => d.toISOString().slice(0, 10),
    monthKey: (/** @type {Date} */ d) => d.toISOString().slice(0, 7),
    totalTokens: () => 0,
  },
});

const { config, resolvePath } = await import('../../config.js');
const { billedBetween, calibration, syncBilling } = await import('../../utils/billing.js');
const { billedSpend, checkBudget } = await import('../../utils/usage-budget.js');
const { compareWithBill } = await import('../../utils/usage-report.js');

const STORE = join(resolvePath(config.dataDir), 'usage', 'billed.json');
const NOW = new Date('2026-11-23T15:00:00Z');
/** One agent reply's estimated cost on a day. */
const run = (/** @type {string} */ day, /** @type {number} */ costUsd, kind = 'agent') => ({
  ts: `${day}T12:00:00.000Z`,
  kind,
  costUsd,
});
/** The 7 complete days before 23 Nov, billed and estimated at the given amounts per day. */
const week = (/** @type {number} */ billed, /** @type {number} */ estimated) => {
  const days = ['16', '17', '18', '19', '20', '21', '22'].map((d) => `2026-11-${d}`);
  bill = { days: Object.fromEntries(days.map((d) => [d, billed])), refreshedAt: '2026-11-23T09:30:00Z' };
  records = days.map((d) => run(d, estimated));
};

describe('billing calibration', () => {
  before(() => rmSync(STORE, { force: true }));
  after(() => rmSync(STORE, { force: true }));

  it('fetches this month and the calibration window, and saves the bill', async () => {
    week(2, 1);
    await syncBilling(NOW);
    const [from, to] = /** @type {any} */ (billedCostByDay.mock.calls[0]).arguments;
    assert.strictEqual(from.toISOString(), '2026-11-01T00:00:00.000Z', 'month start (earlier than 7 days back)');
    assert.strictEqual(to, NOW);
    const saved = JSON.parse(readFileSync(STORE, 'utf-8'));
    assert.strictEqual(saved.refreshedAt, '2026-11-23T09:30:00Z');
    assert.strictEqual(saved.days['2026-11-22'], 2);
    assert.strictEqual(billedBetween('2026-11-16', '2026-11-22'), 14);
  });

  it('reaches into the previous month early in a month', async () => {
    await syncBilling(new Date('2026-12-03T08:00:00Z'));
    const [from] = /** @type {any} */ (billedCostByDay.mock.calls.at(-1)).arguments;
    assert.strictEqual(from.toISOString(), '2026-11-26T00:00:00.000Z');
  });

  it('compares the bill with the estimates over the last 7 complete billed days, leaving out MCP calls', async () => {
    week(3, 2);
    records.push(run('2026-11-20', 50, 'mcp'), run('2026-11-23', 50)); // not Fenix's tokens; not yet billed
    await syncBilling(NOW);
    const c = calibration();
    assert.strictEqual(c.factor, 1.5);
    assert.deepStrictEqual([c.billedUsd, c.estimatedUsd], [21, 14]);
    assert.deepStrictEqual([c.from, c.to], ['2026-11-16T00:00:00.000Z', '2026-11-23T00:00:00.000Z']);
  });

  it('stays at 1 with too little to compare, and within 0.25-4 whatever the bill says', async () => {
    week(1, 0.1);
    await syncBilling(NOW);
    assert.strictEqual(calibration().factor, 1, 'estimates under $1 in the window');
    week(100, 1);
    await syncBilling(NOW);
    assert.strictEqual(calibration().factor, 4);
    week(0.01, 1);
    await syncBilling(NOW);
    assert.strictEqual(calibration().factor, 0.25);
  });

  it('turns estimated spend into billed dollars for the budgets, and the reply cap back into estimates', async () => {
    week(3, 2); // ×1.5
    await syncBilling(NOW);
    spend = new Map([['U0CAL', { monthUsd: 10, dayUsd: 1.9 }]]);
    const billed = billedSpend().spend.get('U0CAL');
    assert.ok(billed && billed.monthUsd === 15 && Math.abs(billed.dayUsd - 2.85) < 1e-9, JSON.stringify(billed));
    // $3 a day: $0.15 left in billed dollars, so the SDK may spend $0.10 of its own estimate
    const v = checkBudget('U0CAL');
    assert.ok(v.ok && Math.abs(/** @type {number} */ (v.maxUsd) - 0.1) < 1e-9, JSON.stringify(v));
    spend = new Map([['U0CAL', { monthUsd: 10, dayUsd: 2 }]]); // $3.00 billed: refused
    assert.strictEqual(checkBudget('U0CAL').ok, false);
  });

  it('puts the bill next to the estimate for the full days a report covers', () => {
    const b = compareWithBill(records, new Date('2026-11-01T00:00:00Z'), NOW);
    assert.deepStrictEqual(b && [b.billedUsd, b.estimatedUsd, b.through, b.factor], [
      21,
      14,
      '2026-11-23T00:00:00.000Z',
      1.5,
    ]);
    assert.strictEqual(compareWithBill(records, new Date('2026-11-23T10:00:00Z'), NOW), null, 'no full billed day');
  });
});
