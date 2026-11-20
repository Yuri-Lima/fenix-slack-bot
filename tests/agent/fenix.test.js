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

const { AGENT_TIMEOUT_MESSAGE, THREAD_BUSY_MESSAGE, buildPrompt, runFenixAgent, sinceLastReply, usageFromResult } =
  await import('../../agent/fenix.js');

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

describe('buildPrompt', () => {
  const now = Date.parse('2026-11-17T17:05:00Z') / 1000;

  it('stamps the send time (test zone UTC) on a plain-text prompt', () => {
    assert.strictEqual(buildPrompt('what happened?', [], now), '[Sent Tue, 17 Nov 2026, 17:05 UTC]\nwhat happened?');
  });

  it('sends images first, then the stamped text, as one user message', async () => {
    const prompt = buildPrompt('see this', [{ name: 'a.png', mediaType: 'image/png', data: 'AAAA' }], now);
    assert.notStrictEqual(typeof prompt, 'string');
    const messages = [];
    for await (const m of /** @type {AsyncIterable<any>} */ (prompt)) messages.push(m);
    assert.strictEqual(messages.length, 1);
    const [image, text] = messages[0].message.content;
    assert.deepStrictEqual(image, { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAAA' } });
    assert.deepStrictEqual(text, { type: 'text', text: '[Sent Tue, 17 Nov 2026, 17:05 UTC]\nsee this' });
  });
});

// Running totals of a real resumed thread (usage log, 17 Nov): its first reply, then the second one,
// whose result also carried the first. Haiku did not run again, so its figures stay the same.
const opus = (input, cacheWrite, cacheRead, output, costUsd) => ({ input, output, cacheRead, cacheWrite, costUsd });
const haiku = { input: 1335, output: 358, cacheRead: 0, cacheWrite: 0, costUsd: 0.0031 };
const first = {
  models: { 'claude-opus-5-5': opus(12, 24365, 85758, 2777, 0.195), 'claude-haiku-5-5': haiku },
  costUsd: 0.1981,
};
const second = {
  models: { 'claude-opus-5-5': opus(34, 58095, 437750, 6322, 0.505), 'claude-haiku-5-5': haiku },
  costUsd: 0.5081,
};

describe('sinceLastReply', () => {
  it("logs a resumed reply with its own usage, without the thread's earlier replies", () => {
    const own = sinceLastReply(second, first);
    assert.deepStrictEqual(Object.keys(own.models), ['claude-opus-5-5']);
    const o = own.models['claude-opus-5-5'];
    assert.deepStrictEqual([o.input, o.cacheWrite, o.cacheRead, o.output], [22, 33730, 351992, 3545]);
    assert.ok(Math.abs(o.costUsd - 0.31) < 1e-9);
    assert.ok(Math.abs(own.costUsd - 0.31) < 1e-9);
  });

  it('keeps the totals of a new thread, or of totals that restarted', () => {
    assert.strictEqual(sinceLastReply(first, null), first);
    assert.strictEqual(sinceLastReply(first, second), first);
  });
});

describe('runFenixAgent budgets', () => {
  it('refuses a long thread before calling the model, and still lets an owner continue it', async () => {
    const calls = seenOptions.length;
    const thread = { models: {}, costUsd: 2.5 };
    const allowed = { ...deps('20.0'), userId: 'U0ALLOWED', userName: 'Allowed' };
    const refused = await runFenixAgent('more', 'sess-1', allowed, { threadTotals: thread });
    assert.strictEqual(refused.usage.outcome, 'budget');
    assert.strictEqual(refused.usage.error, 'budget_thread');
    assert.match(refused.responseText, /This thread has cost \$2\.50/);
    assert.strictEqual(refused.sessionId, null);
    assert.strictEqual(seenOptions.length, calls);

    mock.timers.enable({ apis: ['setTimeout'] });
    try {
      const owner = runFenixAgent('more', 'sess-2', deps('21.0'), { threadTotals: thread });
      await new Promise((r) => setImmediate(r));
      assert.strictEqual(seenOptions.length, calls + 1);
      assert.strictEqual(seenOptions.at(-1).maxBudgetUsd, 1);
      assert.strictEqual(seenOptions.at(-1).resume, 'sess-2');
      mock.timers.tick(120_000);
      await owner;
    } finally {
      mock.timers.reset();
    }
  });
});
