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
    ]),
    lokiRange: async () => [],
    lokiInstant: async () => [],
    promQuery: async () => [],
    promRange: async () => [],
  },
});
const { config, resolvePath } = await import('../../../config.js');
const { createIgnoreHostsTool, hostLogsTool } = await import('../../../agent/tools/grafana.js');
const { ignoredBy } = await import('../../../integrations/host-health.js');

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
    assert.match(r.text, /Matches 2 of 5 servers sending logs: billing-staging\.acme, shop-staging\.acme\./);
    assert.strictEqual(ignoredBy('Billing-Staging'), 'staging');

    // The other Grafana tools respect it straight away
    const logs = await hostLogsTool.handler({ host: 'shop-staging.acme' }, {});
    assert.match(logs.content[0].text, /^shop-staging\.acme is not analysed: server names containing "staging"/);
  });

  it('lists config and added parts, with who added them and what is excluded now', async () => {
    const r = await run({ action: 'list' });
    assert.match(r.text, /• "test" \(fenix\.config\.json; change it there and deploy\)/);
    assert.match(r.text, /• "staging" \(added by Owner, \d{4}-\d{2}-\d{2}\)/);
    assert.match(
      r.text,
      /Servers excluded right now \(3 of 5\): billing-staging\.acme, shop-staging\.acme, shop-test\.acme\./,
    );
  });

  it('refuses a part that would exclude every server, and malformed parts', async () => {
    const all = await run({ action: 'add', part: 'acme' });
    assert.ok(all.isError);
    assert.match(all.text, /^Not added: "acme" matches every server sending logs \(5\)/);
    assert.strictEqual(ignoredBy('crm.acme'), null, 'nothing was added');
    for (const part of ['p', 'shop prod', '-dash-first', '']) {
      const r = await run({ action: 'add', part });
      assert.ok(r.isError && /2-63 lowercase/.test(r.text), part);
    }
    assert.match((await run({ action: 'add', part: 'staging' })).text, /already excluded/);
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
