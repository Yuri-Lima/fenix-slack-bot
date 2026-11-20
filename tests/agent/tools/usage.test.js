import assert from 'node:assert';
import { describe, it } from 'node:test';

import { createBudgetLimitsTool } from '../../../agent/tools/usage.js';
import { resetLimits } from '../../../utils/budget-limits.js';

const nameOf = async (/** @type {string} */ id) => ({ U0ALLOWED: 'Allowed Person' })[id] ?? id;

describe('budget_limits tool', () => {
  it('raises a person’s daily limit for the rest of the month', async () => {
    const t = createBudgetLimitsTool(() => 'Owner', nameOf);
    try {
      const r = await t.handler({ action: 'set', person: 'Allowed', daily_usd: 5, until: 'end of month' }, {});
      assert.strictEqual(r.isError, undefined);
      assert.match(
        r.content[0].text,
        /^Done\. Allowed Person: \$5\.00 a day, \$30\.00 a month \(set by Owner on .*until /,
      );
    } finally {
      resetLimits({ id: 'U0ALLOWED', name: 'Allowed Person' });
    }
  });

  it('reports a missing person or a bad amount as an error', async () => {
    const t = createBudgetLimitsTool(() => 'Owner', nameOf);
    assert.strictEqual((await t.handler({ action: 'set', daily_usd: 5 }, {})).isError, true);
    const bad = await t.handler({ action: 'set', person: 'Allowed', daily_usd: -1 }, {});
    assert.strictEqual(bad.isError, true);
    assert.match(bad.content[0].text, /more than \$0/);
  });
});
