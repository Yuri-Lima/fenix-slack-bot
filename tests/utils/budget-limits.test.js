import assert from 'node:assert';
import { describe, it } from 'node:test';
import {
  describeLimits,
  findPerson,
  listLimits,
  notFoundText,
  parseUntil,
  resetLimits,
  setLimits,
} from '../../utils/budget-limits.js';
import { budgetOverrides } from '../../utils/budget-overrides-store.js';
import { limitSource, limitsFor } from '../../utils/usage-budget.js';

// Fixture: defaults $3 a day and $30 a month; allowedUserIds U0ALLOWED; perUser U0BIG ($10 a day, no monthly
// limit) and U0UNTIL ($5 a day through 2026-11-30). tests/.data keeps the overrides store between runs, so
// people whose limits are set get IDs of their own each run.
const run = Date.now().toString(36).toUpperCase();
const NAMES = { U0ALLOWED: 'Allowed Person', U0BIG: 'Big Spender', U0UNTIL: 'Until Person', U0OWNER: 'Owner' };
const nameOf = async (/** @type {string} */ id) => NAMES[id] ?? id;
const now = new Date('2026-11-20T10:00:00Z');

describe('parseUntil', () => {
  it('reads a day or the end of this month, and refuses past or impossible days', () => {
    assert.strictEqual(parseUntil('end of month', now), '2026-11-30');
    assert.strictEqual(parseUntil('This month', now), '2026-11-30');
    assert.strictEqual(parseUntil('end of the month', new Date('2026-12-05T10:00:00Z')), '2026-12-31');
    assert.strictEqual(parseUntil('2026-11-20', now), '2026-11-20');
    assert.strictEqual(parseUntil('2026-11-19', now), null);
    assert.strictEqual(parseUntil('2026-02-30', now), null);
    assert.strictEqual(parseUntil('next week', now), null);
  });
});

describe('findPerson', () => {
  it('takes a mention or an ID, or one name on the access list', async () => {
    assert.deepStrictEqual(await findPerson('<@U0ZZZZZZ9>', nameOf), { id: 'U0ZZZZZZ9', name: 'U0ZZZZZZ9' });
    assert.deepStrictEqual(await findPerson('<@U0BIG123|big>', nameOf), { id: 'U0BIG123', name: 'U0BIG123' });
    assert.deepStrictEqual(await findPerson('big', nameOf), { id: 'U0BIG', name: 'Big Spender' });
    assert.deepStrictEqual(await findPerson('@Until Person', nameOf), { id: 'U0UNTIL', name: 'Until Person' });
  });

  it('lists the matches when a name is ambiguous or unknown, and never offers owners', async () => {
    const several = await findPerson('person', nameOf);
    assert.deepStrictEqual('candidates' in several && several.candidates.sort(), ['Allowed Person', 'Until Person']);
    const none = await findPerson('owner', nameOf);
    assert.deepStrictEqual(none, { candidates: [] });
    assert.match(await notFoundText('nobody', [], nameOf), /I don't know anyone called "nobody".*Big Spender/);
  });
});

describe('setLimits and resetLimits', () => {
  it('sets a temporary daily limit that wins over the config entry and the defaults, then adds a monthly one', () => {
    const person = { id: `U0LIM${run}`, name: 'Dana' };
    const first = setLimits(person, { dailyUsd: 5, until: 'end of month' }, 'Owner', now);
    assert.strictEqual(first.ok, true);
    assert.match(
      first.text,
      /^Done\. Dana: \$5\.00 a day, \$30\.00 a month \(set by Owner on 20 Nov; until 30 Nov, then \$3\.00 a day, \$30\.00 a month\)\. Used \$0\.00 today/,
    );
    assert.match(first.text, /Not on the access list/);

    const second = setLimits(person, { monthlyUsd: 50 }, 'Owner', now);
    assert.strictEqual(second.ok, true);
    const stored = budgetOverrides()[person.id];
    assert.deepStrictEqual(
      { dailyUsd: stored.dailyUsd, monthlyUsd: stored.monthlyUsd, until: stored.until },
      { dailyUsd: 5, monthlyUsd: 50, until: '2026-11-30' },
    );
    assert.deepStrictEqual(limitsFor(person.id, now), { dailyUsd: 5, monthlyUsd: 50 });
    assert.deepStrictEqual(limitsFor(person.id, new Date('2026-12-01T10:00:00Z')), { dailyUsd: 3, monthlyUsd: 30 });

    assert.match(resetLimits(person, now).text, /^Reset\. Dana: \$3\.00 a day, \$30\.00 a month \(default\)/);
    assert.strictEqual(resetLimits(person, now).ok, false);
  });

  it('lets a limit set by asking override a config entry field by field', () => {
    const person = { id: 'U0BIG', name: 'Big Spender' };
    try {
      setLimits(person, { monthlyUsd: 80 }, 'Owner', now);
      assert.deepStrictEqual(limitsFor('U0BIG', now), { dailyUsd: 10, monthlyUsd: 80 });
      assert.strictEqual(limitSource('U0BIG', now).source, 'asked');
    } finally {
      resetLimits(person, now);
    }
    assert.strictEqual(limitSource('U0BIG', now).source, 'config');
    assert.match(resetLimits(person, now).text, /come from fenix\.config\.json/);
  });

  it('refuses owners, missing or out-of-range amounts, and bad days', () => {
    const person = { id: `U0BAD${run}`, name: 'Dana' };
    assert.match(setLimits({ id: 'U0OWNER', name: 'Owner' }, { dailyUsd: 5 }, 'Owner', now).text, /owners have no/);
    assert.match(setLimits(person, {}, 'Owner', now).text, /Give a daily and\/or a monthly limit/);
    assert.match(setLimits(person, { dailyUsd: 0 }, 'Owner', now).text, /more than \$0 and at most \$1000\.00/);
    assert.match(setLimits(person, { dailyUsd: 5000 }, 'Owner', now).text, /at most/);
    assert.match(setLimits(person, { dailyUsd: 5, until: 'yesterday' }, 'Owner', now).text, /not a day from today/);
    assert.strictEqual(budgetOverrides()[person.id], undefined);
  });
});

describe('describeLimits and listLimits', () => {
  it("shows a config entry's end and what follows, and lists everyone after the defaults", async () => {
    assert.match(
      describeLimits({ id: 'U0UNTIL', name: 'Until Person' }, now),
      /\$5\.00 a day, \$30\.00 a month \(from fenix\.config\.json; until 30 Nov, then \$3\.00 a day, \$30\.00 a month\)/,
    );
    const list = await listLimits(nameOf, now);
    const [header, ...lines] = list.split('\n');
    assert.match(header, /^Defaults: \$3\.00 a day, \$30\.00 a month per person; team \$10000\.00 a month/);
    assert.ok(
      lines.some((l) => l.startsWith('• Big Spender: $10.00 a day, no monthly limit (from fenix.config.json)')),
    );
    assert.ok(!lines.some((l) => l.includes('Owner:')));
  });
});
