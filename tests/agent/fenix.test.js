import assert from 'node:assert';
import { describe, it, mock } from 'node:test';

// Replace only `query` with a run that never finishes on its own: it waits
// until the AbortController in options is aborted, like the real SDK.
const sdk = await import('@anthropic-ai/claude-agent-sdk');
const seenOptions = [];
mock.module('@anthropic-ai/claude-agent-sdk', {
  namedExports: {
    ...sdk,
    query: ({ options }) => {
      seenOptions.push(options);
      return (async function* hang() {
        const signal = options?.abortController?.signal;
        await new Promise((_, reject) => {
          if (!signal) return; // never settles: the bug this test guards against
          signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })));
        });
        yield { type: 'result', session_id: 'never' };
      })();
    },
  },
});

const { AGENT_TIMEOUT_MESSAGE, THREAD_BUSY_MESSAGE, runFenixAgent, usageFromResult } = await import(
  '../../agent/fenix.js'
);

const deps = (thread) => ({
  client: {},
  channelId: 'C1',
  threadTs: thread,
  messageTs: thread,
  userId: 'U0OWNER',
  userName: 'Owner',
});

describe('runFenixAgent timeout', () => {
  it('aborts a hung run through options.abortController and frees its slot and thread lock', async () => {
    mock.timers.enable({ apis: ['setTimeout'] });
    try {
      const runs = ['1.0', '2.0', '3.0'].map((t) => runFenixAgent('hello', undefined, deps(t)));
      await new Promise((r) => setImmediate(r));
      assert.ok(seenOptions.every((o) => o.abortController instanceof AbortController));

      mock.timers.tick(120_000);
      const results = await Promise.all(runs);
      for (const r of results) {
        assert.strictEqual(r.responseText, AGENT_TIMEOUT_MESSAGE);
        assert.strictEqual(r.sessionId, null);
        assert.strictEqual(r.usage.outcome, 'timeout');
      }
    } finally {
      mock.timers.reset();
    }

    // All three slots were released: a new run on a previously locked thread
    // reaches query() instead of being rejected as busy.
    seenOptions.length = 0;
    mock.timers.enable({ apis: ['setTimeout'] });
    try {
      const again = runFenixAgent('hello', undefined, deps('1.0'));
      await new Promise((r) => setImmediate(r));
      assert.strictEqual(seenOptions.length, 1);
      mock.timers.tick(120_000);
      assert.strictEqual((await again).responseText, AGENT_TIMEOUT_MESSAGE);
    } finally {
      mock.timers.reset();
    }
  });
});

describe('runFenixAgent busy thread', () => {
  it('answers a second message in a busy thread with a notice instead of an empty reply', async () => {
    mock.timers.enable({ apis: ['setTimeout'] });
    try {
      const first = runFenixAgent('first', undefined, deps('9.0'));
      await new Promise((r) => setImmediate(r));
      const second = await runFenixAgent('second', undefined, deps('9.0'));
      assert.strictEqual(second.responseText, THREAD_BUSY_MESSAGE);
      assert.strictEqual(second.usage.outcome, 'busy');
      assert.strictEqual(second.usage.costUsd, 0);

      mock.timers.tick(120_000);
      await first;
    } finally {
      mock.timers.reset();
    }
  });
});

describe('usageFromResult', () => {
  it('maps the SDK result into per-model tokens, cost, turns and duration', () => {
    const usage = usageFromResult({
      total_cost_usd: 0.07,
      num_turns: 4,
      duration_ms: 9100,
      modelUsage: {
        'claude-sonnet-4-5': {
          inputTokens: 1200,
          outputTokens: 300,
          cacheReadInputTokens: 50_000,
          cacheCreationInputTokens: 900,
          costUSD: 0.07,
        },
      },
    });
    assert.deepStrictEqual(usage, {
      models: { 'claude-sonnet-4-5': { input: 1200, output: 300, cacheRead: 50_000, cacheWrite: 900, costUsd: 0.07 } },
      costUsd: 0.07,
      turns: 4,
      durationMs: 9100,
    });
  });
});
