import assert from 'node:assert';
import { describe, it, mock } from 'node:test';

import {
  apiLimitReached,
  budgetNote,
  checkBudget,
  evaluateBudget,
  limitsFor,
  MIN_REPLY_USD,
  nextMonthLabel,
  notifyBudgetReached,
} from '../../utils/usage-budget.js';
import { flushUsage, recordUsage } from '../../utils/usage-store.js';

// Fixture budgets: $3 a day, $30 a month, team $10000 (test runs add up in tests/.data), $1 a reply, $2 a thread, warn at 80%;
// U0BIG has $10 a day and no monthly limit.
const defaults = { dailyUsd: 3, monthlyUsd: 30 };
const evaluate = (over = {}) =>
  evaluateBudget({
    owner: false,
    limits: defaults,
    spent: { dayUsd: 0, monthUsd: 0 },
    teamUsd: 0,
    threadCostUsd: 0,
    now: new Date('2026-11-18T10:00:00Z'),
    ...over,
  });

// tests/.data keeps the usage log between runs, so people who spend get IDs of their own each run
const run = Date.now().toString(36).toUpperCase();
const SPENT = `U0SPENT${run}`;
const NOTE = `U0NOTE${run}`;

/** One agent reply costing `costUsd`, now. */
const spend = (userId, costUsd) =>
  recordUsage({
    kind: 'agent',
    outcome: 'ok',
    userId,
    userName: userId,
    models: { 'claude-test-1': { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, costUsd } },
    costUsd,
    turns: 1,
    durationMs: 1000,
    tools: {},
  });

describe('limitsFor', () => {
  it('uses the defaults, or a person’s own entry (null turns a limit off)', () => {
    assert.deepStrictEqual(limitsFor('U0ALLOWED'), defaults);
    assert.deepStrictEqual(limitsFor('U0BIG'), { dailyUsd: 10, monthlyUsd: null });
  });

  it('applies an own entry through its until day, then the defaults again', () => {
    assert.deepStrictEqual(limitsFor('U0UNTIL', new Date('2026-11-30T23:00:00Z')), { dailyUsd: 5, monthlyUsd: 30 });
    assert.deepStrictEqual(limitsFor('U0UNTIL', new Date('2026-12-01T00:30:00Z')), defaults);
  });
});

describe('evaluateBudget', () => {
  it('never blocks an owner, but still caps the reply', () => {
    const v = evaluate({ owner: true, spent: { dayUsd: 50, monthUsd: 500 }, teamUsd: 50000, threadCostUsd: 9 });
    assert.deepStrictEqual(v, { ok: true, maxUsd: 1 });
  });

  it('caps a reply at the per-reply limit while plenty of budget is left', () => {
    assert.deepStrictEqual(evaluate(), { ok: true, maxUsd: 1 });
  });

  it('caps a reply at what is left of the day, but not below the minimum', () => {
    const left = evaluate({ spent: { dayUsd: 2.6, monthUsd: 2.6 } });
    assert.ok(left.ok && Math.abs(/** @type {number} */ (left.maxUsd) - 0.4) < 1e-9);
    const almost = evaluate({ spent: { dayUsd: 2.97, monthUsd: 2.97 } });
    assert.deepStrictEqual(almost, { ok: true, maxUsd: MIN_REPLY_USD });
  });

  it('refuses with the reason and when it resets, team first', () => {
    const team = evaluate({ teamUsd: 10000, spent: { dayUsd: 5, monthUsd: 40 } });
    assert.strictEqual(team.ok, false);
    assert.strictEqual(!team.ok && team.limit, 'team');
    assert.match(!team.ok ? team.reply : '', /team's Fenix budget for this month \(\$10000\.00\).*1 December/);

    const monthly = evaluate({ spent: { dayUsd: 5, monthUsd: 30 } });
    assert.strictEqual(!monthly.ok && monthly.limit, 'monthly');
    assert.match(!monthly.ok ? monthly.reply : '', /this month \(\$30\.00\).*1 December/);

    const daily = evaluate({ spent: { dayUsd: 3, monthUsd: 3 } });
    assert.strictEqual(!daily.ok && daily.limit, 'daily');
    assert.match(!daily.ok ? daily.reply : '', /today \(\$3\.00\).*midnight \(UTC\)/);
  });

  it('asks for a new thread once a thread has cost the thread limit', () => {
    const v = evaluate({ threadCostUsd: 2.1 });
    assert.strictEqual(!v.ok && v.limit, 'thread');
    assert.match(!v.ok ? v.reply : '', /This thread has cost \$2\.10/);
  });

  it('ignores limits that are turned off', () => {
    const v = evaluate({ limits: { dailyUsd: 10, monthlyUsd: null }, spent: { dayUsd: 5, monthUsd: 900 } });
    assert.deepStrictEqual(v, { ok: true, maxUsd: 1 });
  });
});

describe('nextMonthLabel', () => {
  it('names the first day of the next month, across a year end', () => {
    assert.strictEqual(nextMonthLabel(new Date('2026-11-18T10:00:00Z')), '1 December');
    assert.strictEqual(nextMonthLabel(new Date('2026-12-31T23:00:00Z')), '1 January');
  });
});

describe('checkBudget and budgetNote with the usage log', () => {
  it('refuses a person whose replies today reached the daily limit', async () => {
    await spend(SPENT, 3.2);
    await flushUsage();
    const v = checkBudget(SPENT);
    assert.strictEqual(!v.ok && v.limit, 'daily');
    assert.strictEqual(checkBudget('U0OWNER').ok, true);
  });

  it('shows what is left once 80% of a limit is used, and nothing for owners', async () => {
    assert.strictEqual(budgetNote(NOTE), null);
    await spend(NOTE, 2.5);
    await flushUsage();
    assert.match(/** @type {string} */ (budgetNote(NOTE)), /budget today: \$2\.50 of \$3\.00/);
    assert.match(/** @type {string} */ (budgetNote(`U0FRESH${run}`, 1.7)), /this thread: \$1\.70 of \$2\.00/);
    assert.strictEqual(budgetNote('U0OWNER', 5), null);
  });
});

describe('notifyBudgetReached', () => {
  it('tells the admin channel once per person, limit and period', async () => {
    const postMessage = mock.fn(async () => ({ ok: true }));
    const client = { chat: { postMessage } };
    const now = new Date('2026-11-18T10:00:00Z');
    const who = { userId: 'U0NOTIFY', userName: 'Dana', limit: /** @type {const} */ ('daily') };
    assert.strictEqual(await notifyBudgetReached(client, who, now), true);
    assert.strictEqual(await notifyBudgetReached(client, who, now), false);
    assert.strictEqual(await notifyBudgetReached(client, who, new Date('2026-11-19T10:00:00Z')), true);
    assert.strictEqual(postMessage.mock.callCount(), 2);
    const { channel, text } = postMessage.mock.calls[0].arguments[0];
    assert.strictEqual(channel, 'D0ADMIN');
    assert.match(text, /Dana reached their daily Fenix budget \(\$3\.00\).*reply here with `limit <@U0NOTIFY> 5\/day`/);
  });

  it('sends nothing for the thread limit', async () => {
    const postMessage = mock.fn(async () => ({ ok: true }));
    const sent = await notifyBudgetReached(
      { chat: { postMessage } },
      { userId: 'U0NOTIFY', userName: 'Dana', limit: 'thread' },
    );
    assert.strictEqual(sent, false);
    assert.strictEqual(postMessage.mock.callCount(), 0);
  });
});

describe('apiLimitReached', () => {
  it('recognises the account limit and the day access returns', () => {
    const text =
      'API Error: 400 You have reached your specified API usage limits. You will regain access on 2026-12-01 at 00:00 UTC.';
    assert.deepStrictEqual(apiLimitReached(text), { until: '1 December' });
    assert.deepStrictEqual(apiLimitReached('You have reached your specified API usage limits.'), { until: null });
    assert.strictEqual(apiLimitReached('API Error: 529 Overloaded'), null);
    assert.strictEqual(apiLimitReached(undefined), null);
  });
});
