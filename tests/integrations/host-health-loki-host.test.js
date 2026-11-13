import assert from 'node:assert';
import { describe, it, mock } from 'node:test';

// Loki knows these hosts; `alpha-staging` must never be read for `alpha`
const lokiLabelValues = mock.fn(async () => ['alpha', 'alpha-staging', 'Beta']);
const lokiRange = mock.fn(async () => []);
const lokiInstant = mock.fn(async () => []);
mock.module('../../integrations/grafana.js', {
  namedExports: { lokiLabelValues, lokiRange, lokiInstant, promQuery: async () => [], promRange: async () => [] },
});
const { collectHostEvidence, lokiHostFor } = await import('../../integrations/host-health.js');

describe('lokiHostFor', () => {
  it('matches the exact host, ignoring case, and falls back to the name given', async () => {
    assert.strictEqual(await lokiHostFor('alpha'), 'alpha');
    assert.strictEqual(await lokiHostFor('beta'), 'Beta');
    assert.strictEqual(await lokiHostFor('gamma'), 'gamma');
    assert.strictEqual(lokiLabelValues.mock.callCount(), 1, 'host list is cached');
  });
});

describe('collectHostEvidence log queries', () => {
  it('selects the one Loki host by exact name, not every host with that prefix', async () => {
    await collectHostEvidence('ALPHA', { start: Math.floor(Date.now() / 1000) - 600 });
    const queries = [...lokiRange.mock.calls, ...lokiInstant.mock.calls].map((c) => c.arguments[0]);
    assert.strictEqual(queries.length, 2);
    for (const q of queries) {
      assert.match(q, /\{host="alpha"\}/);
      assert.ok(!q.includes('=~'), q);
    }
  });
});
