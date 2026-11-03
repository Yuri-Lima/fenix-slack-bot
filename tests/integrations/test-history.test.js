import assert from 'node:assert';
import { after, afterEach, beforeEach, describe, it, mock } from 'node:test';

import {
  BROKEN_MIN_RATE,
  classifyTest,
  compareWindows,
  FLAKY_MIN_RATE,
  getTestHistory,
  isInfraKill,
  MIN_RUNS,
  parseTcDate,
} from '../../integrations/test-history.js';
import { flushFailureLog, recordBuildResults } from '../../utils/flaky-store.js';

const DAY = 86_400_000;

describe('classifyTest', () => {
  it('uses one set of thresholds, with the broken bound inclusive', () => {
    assert.strictEqual(classifyTest(BROKEN_MIN_RATE, 10), 'broken');
    assert.strictEqual(classifyTest(BROKEN_MIN_RATE - 0.01, 10), 'flaky');
    assert.strictEqual(classifyTest(FLAKY_MIN_RATE, 10), 'flaky');
    assert.strictEqual(classifyTest(FLAKY_MIN_RATE - 0.01, 10), 'rare');
  });

  it('refuses to classify with too few runs or a failed lookup', () => {
    assert.strictEqual(classifyTest(0.5, MIN_RUNS - 1), 'unknown');
    assert.strictEqual(classifyTest(-1, 10), 'unknown');
  });
});

// Real strings from a backend-e2e incident where the kernel OOM killer
// SIGKILLed Jest workers on the agents for ~15 builds in a row.
describe('isInfraKill', () => {
  it('flags the suite-level kill TeamCity reports as a test occurrence, by name', () => {
    assert.ok(isInfraKill({ name: 'e2e: packages/api/e2e/order.e2e-spec.ts: Jest failed to execute suite' }));
  });

  it("flags a killed worker by Jest's SIGKILL message in the details", () => {
    assert.ok(
      isInfraKill({
        name: 'OrderResolver (e2e): creates an order',
        details:
          'Jest worker was terminated by another process: signal=SIGKILL, exitCode=null. ' +
          'Operating system logs may contain more information on why this occurred.',
      }),
    );
  });

  it('leaves real test failures alone', () => {
    assert.ok(!isInfraKill({ name: 'OrderResolver (e2e): creates an order' }));
    assert.ok(
      !isInfraKill({
        name: 'OrderResolver (e2e): creates an order',
        details: 'expect(received).toEqual(expected) ... at order.e2e-spec.ts:120',
      }),
    );
    assert.ok(!isInfraKill({ name: '' }));
    assert.ok(!isInfraKill({}));
  });
});

describe('parseTcDate', () => {
  it('parses TeamCity timestamps with their offset', () => {
    assert.strictEqual(parseTcDate('20261029T094450+0100'), Date.parse('2026-10-29T08:44:50Z'));
  });

  it('returns 0 for missing or malformed values', () => {
    assert.strictEqual(parseTcDate(undefined), 0);
    assert.strictEqual(parseTcDate('yesterday'), 0);
  });
});

describe('compareWindows', () => {
  it('compares the last N days with the N days before', () => {
    const now = Date.parse('2026-11-01T12:00:00Z');
    const run = (status, daysAgo) => ({ status, buildId: 1, buildNumber: '1', ts: now - daysAgo * DAY });
    const runs = [run('FAILURE', 1), run('FAILURE', 2), run('SUCCESS', 3), run('SUCCESS', 9), run('SUCCESS', 10)];
    const w = compareWindows(runs, 7, now);
    assert.strictEqual(w.recentRuns, 3);
    assert.strictEqual(w.olderRuns, 2);
    assert.strictEqual(w.recentRate, 2 / 3);
    assert.strictEqual(w.olderRate, 0);
  });
});

describe('getTestHistory', () => {
  const CONFIG = 'Test_FailureLogOnly';
  const NAME = 'suite › logged as failing in every notification';
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    process.env.TEAMCITY_TOKEN = 'test-token';
    globalThis.fetch = mock.fn(async () => ({
      ok: true,
      json: async () => ({
        testOccurrence: [
          { status: 'FAILURE', build: { id: 3, number: '3', finishDate: '20261031T100000+0000' } },
          { status: 'SUCCESS', build: { id: 2, number: '2', finishDate: '20261030T100000+0000' } },
          { status: 'UNKNOWN', build: { id: 2, number: '2', finishDate: '20261030T100000+0000' } },
          { status: 'SUCCESS', build: { id: 1, number: '1', finishDate: '20261029T100000+0000' } },
        ],
      }),
    }));
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  after(async () => {
    await flushFailureLog();
  });

  it('takes fail rates from TeamCity even when the failure log has many failures', async () => {
    // The failure log only ever sees failures; it used to be trusted once it
    // held 10 runs, which made every logged test 100% "broken".
    for (let i = 1; i <= 12; i++) {
      recordBuildResults(CONFIG, 1000 + i, String(i), [{ name: NAME, status: 'FAILURE' }], (n) => n);
    }
    const hist = await getTestHistory(NAME, CONFIG, 10);
    assert.strictEqual(globalThis.fetch.mock.callCount(), 1);
    assert.strictEqual(hist.total, 3);
    assert.strictEqual(hist.rate, 1 / 3);
    assert.strictEqual(classifyTest(hist.rate, hist.total), 'flaky');
  });

  it('returns runs newest first with parsed timestamps, skipping muted runs', async () => {
    const hist = await getTestHistory(NAME, CONFIG, 10);
    assert.deepStrictEqual(
      hist.runs.map((r) => r.buildNumber),
      ['3', '2', '1'],
    );
    assert.strictEqual(hist.runs[0].ts, Date.parse('2026-10-31T10:00:00Z'));
  });
});
