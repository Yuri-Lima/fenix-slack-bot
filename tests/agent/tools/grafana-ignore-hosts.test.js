import assert from 'node:assert';
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { after, before, describe, it, mock } from 'node:test';

// Grafana knows these servers (the fixture config already excludes "test")
mock.module('../../../integrations/grafana.js', {
  namedExports: {
    lokiLabelValues: mock.fn(async () => [
      'shop-prod.acme',
      'shop-staging.acme',
      'billing-staging.acme',
      'shop-test.acme',
      'crm.acme',
      'alpha.acme',
      'demo-alpha.acme',
    ]),
    lokiRange: async () => [],
    lokiInstant: async () => [],
    promQuery: async () => [],
    promRange: async () => [],
  },
});
const { config, resolvePath } = await import('../../../config.js');
const { createIgnoreHostsTool, hostLogsTool, ignoreEnd } = await import('../../../agent/tools/grafana.js');
const { endLabel, ignoredBy } = await import('../../../integrations/host-health.js');
const { addIgnorePart, addedIgnoreParts, removeIgnorePart } = await import('../../../utils/ignore-hosts-store.js');

const STORE = join(resolvePath(config.dataDir), 'grafana-ignore-hosts.json');
const tool = createIgnoreHostsTool(() => 'Owner');
/** @param {object} args */
const run = async (args) => {
  const r = await tool.handler(args, {});
  return { text: r.content[0].text, isError: Boolean(r.isError) };
};

describe('grafana_ignore_hosts', () => {
  before(() => rmSync(STORE, { force: true }));
  after(() => rmSync(STORE, { force: true }));

  it('adds a name part, shows which servers it now excludes, and applies it at once', async () => {
    assert.strictEqual(ignoredBy('billing-staging'), null);
    const r = await run({ action: 'add', part: '  Staging ' });
    assert.ok(!r.isError, r.text);
    assert.match(r.text, /^Added "staging"/);
    assert.match(r.text, /Matches 2 of 7 servers sending logs: billing-staging\.acme, shop-staging\.acme\./);
    assert.strictEqual(ignoredBy('Billing-Staging'), 'staging');

    // The other Grafana tools respect it straight away
    const logs = await hostLogsTool.handler({ host: 'shop-staging.acme' }, {});
    assert.match(logs.content[0].text, /^shop-staging\.acme is not analysed: server names containing "staging"/);
  });

  it('lists config and added parts, with who added them and what is excluded now', async () => {
    const r = await run({ action: 'list' });
    assert.match(r.text, /• "test" \(fenix\.config\.json; change it there and deploy\)/);
    assert.match(r.text, /• "staging" \(added by Owner, \d{4}-\d{2}-\d{2}; until removed\)/);
    assert.match(
      r.text,
      /Servers excluded right now \(3 of 7\): billing-staging\.acme, shop-staging\.acme, shop-test\.acme\./,
    );
  });

  it('refuses a part that would exclude every server, and malformed parts', async () => {
    const all = await run({ action: 'add', part: 'acme' });
    assert.ok(all.isError);
    assert.match(all.text, /^Not added: "acme" matches every server sending logs \(7\)/);
    assert.strictEqual(ignoredBy('crm.acme'), null, 'nothing was added');
    for (const part of ['p', 'shop prod', '-dash-first', '']) {
      const r = await run({ action: 'add', part });
      assert.ok(r.isError && /2-63 lowercase/.test(r.text), part);
    }
    assert.match((await run({ action: 'add', part: 'test' })).text, /already excluded in fenix\.config\.json/);
  });

  it('removes added parts, but points config parts to fenix.config.json', async () => {
    assert.match((await run({ action: 'remove', part: 'staging' })).text, /^Removed "staging"/);
    assert.strictEqual(ignoredBy('shop-staging.acme'), null);
    const fromConfig = await run({ action: 'remove', part: 'test' });
    assert.ok(fromConfig.isError);
    assert.match(fromConfig.text, /comes from fenix\.config\.json/);
    assert.ok((await run({ action: 'remove', part: 'nothing-here' })).isError);
  });
});

// Fixture time zone: UTC
const NOW = new Date('2026-11-23T10:30:00Z');

describe('ignoreEnd', () => {
  it('reads durations, "always", and no end at all', () => {
    const at = (/** @type {object} */ spec) => {
      const r = ignoreEnd(spec, NOW);
      return 'until' in r ? r.until?.toISOString() : r.error;
    };
    assert.strictEqual(at({ duration: '4h' }), '2026-11-23T14:30:00.000Z');
    assert.strictEqual(at({ duration: '1d' }), '2026-11-24T10:30:00.000Z');
    assert.strictEqual(at({ duration: '2W' }), '2026-12-07T10:30:00.000Z');
    assert.strictEqual(at({ duration: '1mo' }), '2026-12-23T10:30:00.000Z');
    assert.strictEqual(at({ duration: 'always' }), undefined);
    assert.strictEqual(at({}), undefined);
  });

  it('reads a day as through its end, or an exact local time', () => {
    const today = ignoreEnd({ until: '2026-11-23' }, NOW);
    assert.ok('until' in today && today.until?.toISOString() === '2026-11-24T00:00:00.000Z');
    const time = ignoreEnd({ until: '2026-11-23 18:00' }, NOW);
    assert.ok('until' in time && time.until?.toISOString() === '2026-11-23T18:00:00.000Z');
  });

  it('refuses both at once, unknown formats and ends that already passed', () => {
    const error = (/** @type {object} */ spec) => {
      const r = ignoreEnd(spec, NOW);
      return 'error' in r ? r.error : '';
    };
    assert.match(error({ duration: '1d', until: '2026-11-24' }), /not both/);
    assert.match(error({ duration: '0h' }), /not a duration/);
    assert.match(error({ duration: 'a week' }), /not a duration/);
    assert.match(error({ until: 'tomorrow' }), /not a day/);
    assert.match(error({ until: '2026-11-22' }), /the end of Sun 22 Nov \(UTC\) has already passed/);
  });
});

describe('endLabel', () => {
  it('names midnight as the end of the day before', () => {
    assert.strictEqual(endLabel(new Date('2026-11-24T00:00:00Z')), 'the end of Mon 23 Nov (UTC)');
    assert.strictEqual(endLabel(new Date('2026-11-24T18:05:00Z')), 'Tue 24 Nov 18:05 (UTC)');
  });
});

describe('grafana_ignore_hosts with an end', () => {
  before(() => rmSync(STORE, { force: true }));
  after(() => rmSync(STORE, { force: true }));

  it('adds a part for a while, says when it ends, and lists the end', async () => {
    const r = await run({ action: 'add', part: 'billing', duration: '2h' });
    assert.ok(!r.isError, r.text);
    assert.match(r.text, /^Added "billing": .*, until \w{3} \d+ \w{3} \d\d:\d\d \(UTC\), then they are analysed again/);
    assert.strictEqual(ignoredBy('billing-staging.acme'), 'billing');
    const logs = await hostLogsTool.handler({ host: 'billing-staging.acme' }, {});
    assert.match(
      logs.content[0].text,
      /excluded from analysis until \w{3} \d+ \w{3} \d\d:\d\d \(UTC\)\. Tell the user\./,
    );
    assert.match((await run({ action: 'list' })).text, /• "billing" \(added by Owner, [\d-]+; until \w{3} /);
  });

  it('changes the end when the part is added again', async () => {
    const r = await run({ action: 'add', part: 'billing', duration: 'always' });
    assert.strictEqual(
      r.text,
      '"billing" stays excluded (every server whose name contains it), now until someone removes it.',
    );
    assert.strictEqual(addedIgnoreParts().find((a) => a.part === 'billing')?.until, null);
    assert.ok((await run({ action: 'add', part: 'billing', duration: 'soon' })).isError);
  });

  it('stops applying on its own once the end has passed, and drops it on the next save', () => {
    const hourAgo = new Date(Date.now() - 3600_000);
    addIgnorePart('shop-prod', 'Owner', { until: new Date(Date.now() - 1000), now: hourAgo });
    assert.strictEqual(ignoredBy('shop-prod.acme'), null);
    assert.ok(addedIgnoreParts(hourAgo).some((a) => a.part === 'shop-prod'));
    addIgnorePart('crm', 'Owner');
    assert.deepStrictEqual(
      addedIgnoreParts(hourAgo).map((a) => a.part),
      ['billing', 'crm'],
    );
  });
});

describe('grafana_ignore_hosts with an exact name', () => {
  before(() => {
    for (const a of addedIgnoreParts()) removeIgnorePart(a.part); // the store caches what earlier tests added
    rmSync(STORE, { force: true });
  });
  after(() => rmSync(STORE, { force: true }));

  it('excludes only the server with exactly that name, and says which similar ones stay analysed', async () => {
    const r = await run({ action: 'add', part: 'Alpha.acme', exact: true, until: '2099-01-01' });
    assert.ok(!r.isError, r.text);
    assert.match(r.text, /^Added "alpha\.acme": .*the server with exactly this name, until the end of/);
    assert.match(r.text, /Matches alpha\.acme\. Still analysed: demo-alpha\.acme\.$/);
    assert.strictEqual(ignoredBy('ALPHA.acme'), 'alpha.acme');
    assert.strictEqual(ignoredBy('alpha.acme-health-exporter'), 'alpha.acme', 'alerts name the exporter');
    assert.strictEqual(ignoredBy('demo-alpha.acme'), null);
    assert.strictEqual(ignoredBy('alpha.acme2'), null);

    const logs = await hostLogsTool.handler({ host: 'alpha.acme' }, {});
    assert.match(logs.content[0].text, /^alpha\.acme is not analysed: this server is excluded from analysis until /);
    const list = await run({ action: 'list' });
    assert.match(list.text, /• "alpha\.acme" \(exact name; added by Owner/);
    assert.match(list.text, /Servers excluded right now \(2 of 7\): alpha\.acme, shop-test\.acme\./);
  });

  it('turns an exact name into a part when added again without exact, and removes it either way', async () => {
    const r = await run({ action: 'add', part: 'alpha.acme' });
    assert.match(r.text, /stays excluded \(every server whose name contains it\), now until someone removes it/);
    assert.strictEqual(ignoredBy('demo-alpha.acme'), 'alpha.acme');
    assert.match((await run({ action: 'remove', part: 'alpha.acme' })).text, /^Removed/);
    assert.strictEqual(ignoredBy('alpha.acme'), null);
  });

  it('allows an exact name that no server sends logs under yet', async () => {
    const r = await run({ action: 'add', part: 'new-box', exact: true });
    assert.match(r.text, /No server sending logs right now has exactly this name; it applies if one appears\./);
  });
});
