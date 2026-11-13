import assert from 'node:assert';
import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import { resolvePath } from '../../config.js';
import {
  flushUsage,
  monthKey,
  monthToDate,
  pruneOldMonths,
  readMonth,
  readRange,
  recordUsage,
  ruleBasedRun,
  totalTokens,
} from '../../utils/usage-store.js';

// Old months keep these tests away from the current month's log.
const dir = join(resolvePath('tests/.data'), 'usage');
const agentRun = (ts, costUsd = 0.05) => ({
  ts,
  kind: 'agent',
  outcome: 'ok',
  userId: 'U0OWNER',
  models: { 'claude-test-1': { input: 100, output: 50, cacheRead: 1000, cacheWrite: 10, costUsd } },
  costUsd,
  turns: 2,
  durationMs: 4000,
  tools: { teamcity_list_builds: 1 },
});

describe('usage store', () => {
  it('names monthly files by UTC month', () => {
    assert.strictEqual(monthKey(new Date('2026-11-30T23:30:00Z')), '2026-11');
    assert.strictEqual(monthKey(new Date('2026-12-01T00:30:00Z')), '2026-12');
  });

  it('appends each run to its month file and reads a range across months', async () => {
    await recordUsage(agentRun('2003-05-31T23:59:00Z'));
    await recordUsage(agentRun('2003-06-01T00:01:00Z'));
    await recordUsage({ ...ruleBasedRun('grafana', 'Disk', Date.now()), ts: '2003-06-02T10:00:00Z' });
    await flushUsage();
    assert.strictEqual(readMonth('2003-05').length, 1);
    assert.strictEqual(readMonth('2003-06').length, 2);
    const june = readRange(new Date('2003-06-01T00:00:00Z'), new Date('2003-06-30T23:59:59Z'));
    assert.deepStrictEqual(
      june.map((r) => r.kind),
      ['agent', 'grafana'],
    );
  });

  it('skips a half-written line instead of failing the whole month', () => {
    writeFileSync(join(dir, '2002-02.jsonl'), `${JSON.stringify(agentRun('2002-02-01T00:00:00Z'))}\n{"ts":"2002-02-0`);
    assert.strictEqual(readMonth('2002-02').length, 1);
  });

  it('deletes months older than the retention window', () => {
    writeFileSync(join(dir, '2001-01.jsonl'), '');
    const removed = pruneOldMonths('2026-11');
    assert.ok(removed.includes('2001-01'));
    assert.ok(!existsSync(join(dir, '2001-01.jsonl')));
  });

  it('counts every token kind and keeps month-to-date totals for agent runs only', async () => {
    assert.strictEqual(totalTokens(agentRun('2003-01-01T00:00:00Z')), 1160);
    const before = monthToDate();
    await recordUsage(agentRun(new Date().toISOString(), 0.25));
    await recordUsage(ruleBasedRun('teamcity', 'Build', Date.now()));
    const after = monthToDate();
    assert.strictEqual(after.runs, before.runs + 1);
    assert.strictEqual(after.tokens, before.tokens + 1160);
    assert.ok(Math.abs(after.costUsd - before.costUsd - 0.25) < 1e-9);
  });
});
