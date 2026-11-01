import assert from 'node:assert';
import { after, describe, it } from 'node:test';

import { flushFailureLog, getRecentFailures, recordBuildResults } from '../../utils/flaky-store.js';

describe('failure log pruning', () => {
  after(flushFailureLog);

  it('drops tests that no longer appear in any kept build', () => {
    const config = 'Test_Pruning';
    const keepName = (n) => n;
    recordBuildResults(config, 1, '1', [{ name: 'renamed-away', status: 'FAILURE' }], keepName);
    for (let b = 2; b <= 301; b++) {
      recordBuildResults(config, b, String(b), [{ name: 'still-failing', status: 'FAILURE' }], keepName);
    }
    const names = getRecentFailures(config, 30).map((t) => t.name);
    assert.deepStrictEqual(names, ['still-failing']);
  });
});
