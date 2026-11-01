import assert from 'node:assert';
import { afterEach, beforeEach, describe, it, mock } from 'node:test';

import { getTestHistory } from '../../../agent/tools/flaky-tracker.js';
import { locatorValue } from '../../../agent/tools/teamcity.js';

// Real-world shape: commas and colons are locator syntax, and TeamCity
// answered HTTP 400 when they were only URL-encoded.
const NAME = 'Layout overlay hide, remove, and add palette: removes a field — restores it → ok (+1)';

describe('locatorValue', () => {
  it('round-trips the value through base64url', () => {
    const encoded = locatorValue(NAME);
    assert.ok(encoded.startsWith('$base64:'));
    assert.strictEqual(Buffer.from(encoded.slice('$base64:'.length), 'base64url').toString('utf-8'), NAME);
  });

  it('contains no locator or URL syntax characters', () => {
    assert.doesNotMatch(locatorValue(NAME).slice('$base64:'.length), /[,:()&=?/+ ]/);
  });
});

describe('getTestHistory', () => {
  const originalFetch = globalThis.fetch;
  let fetchMock;

  beforeEach(() => {
    process.env.TEAMCITY_TOKEN = 'test-token';
    fetchMock = mock.fn(async () => ({
      ok: true,
      json: async () => ({ testOccurrence: [{ status: 'FAILURE' }, { status: 'SUCCESS' }, { status: 'SUCCESS' }] }),
    }));
    globalThis.fetch = fetchMock;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('sends the test name base64-encoded so TeamCity can parse the locator', async () => {
    const history = await getTestHistory(NAME, 'Unrecorded_Config', 3);
    const url = fetchMock.mock.calls[0].arguments[0];
    assert.ok(url.includes(`test:(name:${locatorValue(NAME)})`), url);
    assert.ok(!url.includes(encodeURIComponent(NAME)));
    assert.deepStrictEqual(history, { passes: 2, failures: 1, total: 3, rate: 1 / 3 });
  });
});
