import assert from 'node:assert';
import { describe, it, mock } from 'node:test';

import { tcApi } from '../../integrations/teamcity.js';

// Runs in its own process: the four requests below never finish, which would
// leave the module's limiter saturated for any other test in the same file.
describe('TeamCity request limiter', () => {
  it('rejects a queued request once it has waited too long for a slot', async () => {
    process.env.TEAMCITY_TOKEN = 'test-token';
    globalThis.fetch = mock.fn(() => new Promise(() => {}));
    mock.timers.enable({ apis: ['setTimeout'] });
    try {
      for (let i = 0; i < 4; i++) tcApi(`/hang/${i}`).catch(() => {});
      const queued = tcApi('/queued');
      await new Promise((r) => setImmediate(r));
      assert.strictEqual(globalThis.fetch.mock.callCount(), 4);

      mock.timers.tick(60_000);
      await assert.rejects(queued, /waited 60s for a request slot/);
    } finally {
      mock.timers.reset();
    }
  });
});
