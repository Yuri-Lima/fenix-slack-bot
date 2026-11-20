import assert from 'node:assert';
import { describe, it, mock } from 'node:test';

// `query` answers with one text block and the result a resumed thread gets from the SDK: running totals
// that include the thread's earlier replies. `nextResult` lets a test pick the result.
const sdk = await import('@anthropic-ai/claude-agent-sdk');
const seenOptions = [];
let nextResult = {};
mock.module('@anthropic-ai/claude-agent-sdk', {
  namedExports: {
    ...sdk,
    query: ({ options }) => {
      seenOptions.push(options);
      return (async function* () {
        if (nextResult.throw) throw new Error(nextResult.throw);
        yield { type: 'assistant', message: { content: [{ type: 'text', text: 'Partial answer' }] } };
        yield { type: 'result', session_id: 'sess-9', num_turns: 3, duration_ms: 5000, ...nextResult };
      })();
    },
  },
});

const { replyBudgetMessage, runFenixAgent } = await import('../../agent/fenix.js');

// The error the SDK threw on 20 Nov when the account's spend limit was reached (Fenix's journal)
const API_LIMIT_ERROR =
  'Claude Code returned an error result: API Error: 400 You have reached your specified API usage limits. ' +
  'You will regain access on 2026-12-01 at 00:00 UTC.';
const postMessage = mock.fn(async () => ({ ok: true }));

const deps = (thread) => ({
  client: { chat: { postMessage } },
  channelId: 'C1',
  threadTs: thread,
  messageTs: thread,
  userId: 'U0OWNER',
  userName: 'Owner',
});
const tokens = (input, output, cacheRead, cacheWrite, costUSD) => ({
  inputTokens: input,
  outputTokens: output,
  cacheReadInputTokens: cacheRead,
  cacheCreationInputTokens: cacheWrite,
  costUSD,
});

describe('runFenixAgent usage of a resumed thread', () => {
  it("logs the reply's own cost and hands back the thread's new running totals", async () => {
    nextResult = {
      subtype: 'success',
      total_cost_usd: 0.5,
      modelUsage: { 'claude-x': tokens(30, 600, 4000, 900, 0.5) },
    };
    const previous = {
      models: { 'claude-x': { input: 10, output: 200, cacheRead: 1000, cacheWrite: 400, costUsd: 0.2 } },
      costUsd: 0.2,
    };
    const run = await runFenixAgent('more', 'sess-9', deps('30.0'), { threadTotals: previous });
    assert.strictEqual(run.usage.outcome, 'ok');
    assert.ok(Math.abs(run.usage.costUsd - 0.3) < 1e-9);
    assert.deepStrictEqual(
      { ...run.usage.models['claude-x'], costUsd: Math.round(run.usage.models['claude-x'].costUsd * 100) / 100 },
      { input: 20, output: 400, cacheRead: 3000, cacheWrite: 500, costUsd: 0.3 },
    );
    assert.strictEqual(run.usage.turns, 3);
    assert.strictEqual(run.threadTotals?.costUsd, 0.5);
    assert.strictEqual(run.threadTotals?.models['claude-x'].cacheRead, 4000);
  });

  it('says why when the per-reply cap stopped the answer', async () => {
    nextResult = { subtype: 'error_max_budget_usd', is_error: true, total_cost_usd: 1.02, modelUsage: {} };
    const run = await runFenixAgent('big question', undefined, deps('31.0'));
    assert.strictEqual(seenOptions.at(-1).maxBudgetUsd, 1);
    assert.strictEqual(run.usage.outcome, 'error');
    assert.strictEqual(run.usage.error, 'error_max_budget_usd');
    assert.strictEqual(run.responseText, `Partial answer\n${replyBudgetMessage(1)}`);
  });
});

describe('runFenixAgent when the Anthropic usage limit is reached', () => {
  it('replies that the credits are used up until the date, instead of a generic error, and tells the owner once', async () => {
    nextResult = { throw: API_LIMIT_ERROR };
    const first = await runFenixAgent('why?', undefined, deps('40.0'));
    assert.strictEqual(
      first.responseText,
      "I can't answer right now: Fenix's Anthropic API credits are used up until 1 December. Owner has been told.",
    );
    assert.strictEqual(first.usage.outcome, 'error');
    assert.strictEqual(first.usage.error, 'api_usage_limit');
    assert.strictEqual(first.sessionId, null);

    nextResult = { subtype: 'error_during_execution', is_error: true, errors: [API_LIMIT_ERROR], modelUsage: {} };
    const second = await runFenixAgent('again', undefined, deps('41.0'));
    assert.match(second.responseText, /credits are used up until 1 December/);
    assert.strictEqual(second.usage.error, 'api_usage_limit');

    await new Promise((r) => setImmediate(r));
    assert.strictEqual(postMessage.mock.callCount(), 1);
    assert.match(
      postMessage.mock.calls[0].arguments[0].text,
      /usage limit is reached.*until 1 December.*Claude Console/,
    );
  });

  it('still throws other errors', async () => {
    nextResult = { throw: 'API Error: 500 Internal server error' };
    await assert.rejects(runFenixAgent('x', undefined, deps('42.0')), /500/);
  });
});
