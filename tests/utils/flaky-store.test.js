import assert from 'node:assert';
import { rmSync } from 'node:fs';
import { after, before, describe, it } from 'node:test';

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

describe('infra kills stay out of the failure log', () => {
  // Fresh store file per run; the module caches per config after first load.
  before(() => rmSync(new URL('../.data/flaky/Test_InfraKills.json', import.meta.url), { force: true }));
  after(flushFailureLog);

  it('skips OOM-killed workers (real incident strings), keeps real failures', () => {
    const config = 'Test_InfraKills';
    recordBuildResults(
      config,
      1,
      '1',
      [
        { name: 'order: creates an order', status: 'FAILURE' },
        { name: 'e2e: packages/api/e2e/order.e2e-spec.ts: Jest failed to execute suite', status: 'FAILURE' },
        {
          name: 'invoice: posts an invoice',
          status: 'FAILURE',
          details:
            'Jest worker was terminated by another process: signal=SIGKILL, exitCode=null. ' +
            'Operating system logs may contain more information on why this occurred.',
        },
      ],
      (n) => n,
    );
    const names = getRecentFailures(config, 30).map((t) => t.name);
    assert.deepStrictEqual(names, ['order: creates an order']);
  });
});
