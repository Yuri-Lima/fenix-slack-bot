import assert from 'node:assert';
import { beforeEach, describe, it, mock } from 'node:test';

/** PromQL expression (matched by substring) -> samples; the first match answers. */
let answers = [];
const sample = (value, metric = {}) => ({ metric, value: [0, String(value)] });
const promQuery = mock.fn(async (expr) => answers.find(([part]) => expr.includes(part))?.[1] ?? []);
mock.module('../../integrations/grafana.js', {
  namedExports: {
    promQuery,
    promRange: async () => [],
    lokiRange: async () => [],
    lokiInstant: async () => [],
    lokiLabelValues: async () => [],
  },
});
const { collectPostgresEvidence, duration, postgresLine, postgresVerdicts, size } = await import(
  '../../integrations/postgres-health.js'
);

const NOW = 1_800_000_000;
const WINDOW = { start: NOW - 1800, end: NOW };

/** Evidence of a healthy Postgres; tests override what they need. */
const healthy = (overrides = {}) => ({
  state: 'up',
  version: '17.5',
  connectionsMax: 6,
  connectionLimit: 497,
  idleInTxMax: 0,
  longestTx: { seconds: 0, state: 'active', database: 'app' },
  deadlocks: 0,
  exclusiveLocksMax: 0,
  cacheHitPct: 100,
  databases: [{ name: 'app', bytes: 2.2 * 1024 ** 3, growthBytes: 50 * 1024 ** 2 }],
  deadRows: { table: 'jobs', dead: 3231, live: 90_000, lastAutovacuum: NOW - 600 },
  replicaLagSec: null,
  ...overrides,
});

describe('collectPostgresEvidence', () => {
  beforeEach(() => {
    answers = [];
    promQuery.mock.resetCalls();
  });

  it('returns null for a server without the Postgres exporter', async () => {
    assert.strictEqual(await collectPostgresEvidence('alpha', WINDOW), null);
    assert.strictEqual(promQuery.mock.callCount(), 2);
  });

  it('tells an exporter that does not answer from a database that does not', async () => {
    answers = [['up{instance="alpha",job="postgres-exporter"}', [sample(0)]]];
    assert.strictEqual((await collectPostgresEvidence('alpha', WINDOW))?.state, 'exporter-down');
    answers = [['pg_up{', [sample(0)]]];
    assert.strictEqual((await collectPostgresEvidence('alpha', WINDOW))?.state, 'down');
  });

  it('reads the values of a running database', async () => {
    answers = [
      ['pg_up{', [sample(1)]],
      ['server_version_num', [sample(170005)]],
      ['pg_stat_database_numbackends', [sample(11)]],
      ['pg_settings_max_connections', [sample(497)]],
      ['idle in transaction', [sample(2)]],
      ['pg_stat_activity_max_tx_duration', [sample(420, { state: 'idle in transaction', datname: 'app' })]],
      ['pg_stat_database_deadlocks', [sample(2.9)]],
      ['accessexclusivelock', [sample(1)]],
      ['blks_hit', [sample(0.5)]],
      ['n_dead_tup', [sample(150_000, { datname: 'app', schemaname: 'public', relname: 'jobs' })]],
      ['n_live_tup{instance="alpha",datname="app",schemaname="public",relname="jobs"}', [sample(50_000)]],
      ['last_autovacuum', [sample(NOW - 7200)]],
      ['pg_replication_is_replica', [sample(0)]],
    ];
    const pg = await collectPostgresEvidence('alpha', WINDOW);
    assert.deepStrictEqual(
      { ...pg, databases: undefined },
      {
        state: 'up',
        version: '17.5',
        connectionsMax: 11,
        connectionLimit: 497,
        idleInTxMax: 2,
        longestTx: { seconds: 420, state: 'idle in transaction', database: 'app' },
        deadlocks: 3,
        exclusiveLocksMax: 1,
        cacheHitPct: 50,
        databases: undefined,
        deadRows: { table: 'jobs', dead: 150_000, live: 50_000, lastAutovacuum: NOW - 7200 },
        replicaLagSec: null,
      },
    );
    const exprs = promQuery.mock.calls.map((c) => c.arguments[0]);
    assert.ok(
      exprs.every((e) => e.includes('instance="alpha"') || e.startsWith('up{')),
      'every query is for this server',
    );
    assert.ok(
      exprs.some((e) => e.includes('[1800s')),
      'window-wide queries cover the 30 minutes',
    );
  });

  it('reports database sizes with their growth over 24 hours, leaving out the system databases', async () => {
    answers = [['pg_up{', [sample(1)]]];
    promQuery.mock.mockImplementation(async (expr, at) => {
      if (expr.startsWith('pg_database_size_bytes')) {
        assert.match(expr, /datname!~"template0\|template1\|postgres"/);
        return at === NOW
          ? [sample(2e9, { datname: 'app' }), sample(5e8, { datname: 'other' })]
          : [sample(1.9e9, { datname: 'app' })];
      }
      return answers.find(([part]) => expr.includes(part))?.[1] ?? [];
    });
    const pg = await collectPostgresEvidence('alpha', WINDOW);
    assert.deepStrictEqual(pg?.databases, [
      { name: 'app', bytes: 2e9, growthBytes: 1e8 },
      { name: 'other', bytes: 5e8, growthBytes: null },
    ]);
    promQuery.mock.restore();
  });
});

describe('postgresVerdicts', () => {
  it('has nothing to say about a healthy database', () => {
    assert.deepStrictEqual(postgresVerdicts('alpha', healthy(), NOW), []);
  });

  it('calls a database the exporter cannot reach a needed action', () => {
    const [v] = postgresVerdicts('alpha', { ...healthy(), state: 'down' }, NOW);
    assert.strictEqual(v.status, 'action');
    assert.strictEqual(v.title, 'Postgres not answering');
  });

  it('warns about connections near the limit, more urgently above 90%', () => {
    const watch = postgresVerdicts('alpha', healthy({ connectionsMax: 400, connectionLimit: 497 }), NOW);
    assert.deepStrictEqual(
      watch.map((v) => [v.status, v.title]),
      [['watch', 'Postgres connections near the limit']],
    );
    assert.match(watch[0].detail, /400 of 497 usable connections \(80%\)/);
    const [action] = postgresVerdicts('alpha', healthy({ connectionsMax: 470, idleInTxMax: 300 }), NOW);
    assert.strictEqual(action.status, 'action');
    assert.match(action.detail, /300 of them idle in a transaction/);
  });

  it('tells a transaction left open from a long query', () => {
    const [open] = postgresVerdicts(
      'alpha',
      healthy({ longestTx: { seconds: 2400, state: 'idle in transaction', database: 'app' } }),
      NOW,
    );
    assert.deepStrictEqual([open.status, open.title], ['action', 'Transaction left open']);
    assert.match(open.detail, /open for 40 min/);
    const [query] = postgresVerdicts(
      'alpha',
      healthy({ longestTx: { seconds: 360, state: 'active', database: 'app' } }),
      NOW,
    );
    assert.deepStrictEqual([query.status, query.title], ['watch', 'Long-running query']);
    assert.deepStrictEqual(
      postgresVerdicts('alpha', healthy({ longestTx: { seconds: 200, state: 'active', database: 'app' } }), NOW),
      [],
    );
  });

  it('reports deadlocks, a vacuum falling behind and a lagging replica', () => {
    const titles = postgresVerdicts(
      'alpha',
      healthy({
        deadlocks: 1,
        deadRows: { table: 'jobs', dead: 150_000, live: 50_000, lastAutovacuum: NOW - 7200 },
        replicaLagSec: 300,
      }),
      NOW,
    ).map((v) => `${v.title}: ${v.detail}`);
    assert.deepStrictEqual(titles, [
      'Postgres deadlocks: 1 deadlock in the window; Postgres cancelled one transaction each time.',
      'Vacuum falling behind: `jobs` has 150,000 dead rows (75% of its rows), last autovacuum 2.0 h ago.',
      'Replica behind: This replica is 5 min behind its primary.',
    ]);
  });

  it('leaves many dead rows alone when they are a small share of a big table', () => {
    const big = healthy({ deadRows: { table: 'jobs', dead: 150_000, live: 5_000_000, lastAutovacuum: null } });
    assert.deepStrictEqual(postgresVerdicts('alpha', big, NOW), []);
  });
});

describe('postgresLine', () => {
  it('sums up a healthy database in one line', () => {
    assert.strictEqual(
      postgresLine(healthy()),
      'Postgres 17.5: 6 of 497 connections at the peak, longest transaction 0 s, 0 deadlocks, cache hits 100%, ' +
        '`app` 2.20 GB (+50 MB in 24 h).',
    );
  });

  it('adds what stands out', () => {
    const line = postgresLine(
      healthy({
        idleInTxMax: 3,
        exclusiveLocksMax: 2,
        cacheHitPct: 91.25,
        deadRows: { table: 'jobs', dead: 20_000, live: 1, lastAutovacuum: null },
        replicaLagSec: 4,
      }),
    );
    assert.match(line, /\(3 idle in a transaction\)/);
    assert.match(line, /2 exclusive table locks at the peak/);
    assert.match(line, /cache hits 91\.3%/);
    assert.match(line, /most dead rows: `jobs` 20,000/);
    assert.match(line, /replica lag 4 s/);
  });

  it('says when there are no database metrics', () => {
    assert.match(postgresLine({ ...healthy(), state: 'exporter-down' }), /exporter is not answering/);
    assert.strictEqual(postgresLine({ ...healthy(), state: 'down' }), 'Postgres: not answering.');
  });
});

describe('duration and size', () => {
  it('pick a readable unit', () => {
    assert.deepStrictEqual([duration(45), duration(600), duration(9000)], ['45 s', '10 min', '2.5 h']);
    assert.deepStrictEqual([size(300 * 1024 ** 2), size(2.2 * 1024 ** 3)], ['300 MB', '2.20 GB']);
  });
});
