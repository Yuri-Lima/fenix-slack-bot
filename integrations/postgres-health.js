import { config } from '../config.js';
import { promQuery } from './grafana.js';
import { clip, q } from './host-health.js';

// Postgres evidence for one server from postgres_exporter metrics in Grafana (read-only), for host_health. The
// exporter's `instance` label is the server name, the same as node_exporter's. Servers without the exporter have
// no Postgres evidence; their health answer simply has no Postgres part.

/** Above these, a Postgres value is worth a verdict. */
const PG_NOTABLE = {
  /** Share of the usable connections in use at the peak (watch, action). */
  connectionsPct: 80,
  connectionsActionPct: 90,
  /** Oldest open transaction (watch, action). */
  longTxSec: 5 * 60,
  longTxActionSec: 30 * 60,
  /** A table whose dead rows are this many and this share of its rows has a vacuum falling behind. */
  deadRows: 100_000,
  deadShare: 0.2,
  replicaLagSec: 60,
};

/** Databases every cluster has, left out of sizes. */
const SYSTEM_DATABASES = 'template0|template1|postgres';

/**
 * @typedef {Object} PostgresEvidence
 * @property {'up' | 'down' | 'exporter-down'} state - up; the exporter answers but Postgres does not; or the exporter
 *   itself does not answer (no database metrics then)
 * @property {string | null} version - e.g. "17.5"
 * @property {number | null} connectionsMax - Peak connections in the window
 * @property {number | null} connectionLimit - max_connections less the reserved ones
 * @property {number | null} idleInTxMax - Peak connections idle in a transaction
 * @property {{ seconds: number, state: string, database: string } | null} longestTx - Oldest open transaction in the window
 * @property {number | null} deadlocks - New deadlocks in the window
 * @property {number | null} exclusiveLocksMax - Peak ACCESS EXCLUSIVE locks (they block every reader)
 * @property {number | null} cacheHitPct - Share of reads served from shared buffers in the window
 * @property {Array<{ name: string, bytes: number, growthBytes: number | null }>} databases - Largest first; growth over 24 h
 * @property {{ table: string, dead: number, live: number, lastAutovacuum: number | null } | null} deadRows - Table with the most dead rows
 * @property {number | null} replicaLagSec - Only for a replica
 */

/**
 * @template T
 * @param {Promise<T>} promise
 * @returns {Promise<T | null>}
 */
const settle = (promise) => promise.catch(() => null);
/** @param {import('./grafana.js').PromSample[] | null} r */
const first = (r) => (r?.[0] ? Number(r[0].value[1]) : null);

/**
 * Postgres evidence for a server over [start, end], or null when no Postgres exporter is set up for it.
 * @param {string} host - Server name (node_exporter instance)
 * @param {{ start: number, end: number }} window - Unix seconds
 * @returns {Promise<PostgresEvidence | null>}
 */
export async function collectPostgresEvidence(host, { start, end }) {
  const H = `instance="${q(host)}"`;
  const w = `${Math.max(60, end - start)}s`;
  const [pgUp, exporterUp] = await Promise.all([
    settle(promQuery(`pg_up{${H}}`, end)),
    settle(promQuery(`up{${H},job="${q(config.grafana.postgresJob)}"}`, end)),
  ]);
  if (!pgUp?.length) return exporterUp?.length ? empty('exporter-down') : null;
  if (first(pgUp) !== 1) return empty('down');

  const [
    version,
    connections,
    limit,
    idleInTx,
    longest,
    deadlocks,
    exclusive,
    cacheHit,
    sizes,
    sizesDayAgo,
    deadTop,
    replica,
    lag,
  ] = await Promise.all([
    settle(promQuery(`max(pg_settings_server_version_num{${H}})`, end)),
    settle(promQuery(`max_over_time(sum(pg_stat_database_numbackends{${H}})[${w}:1m])`, end)),
    settle(
      promQuery(
        `max(pg_settings_max_connections{${H}}) - max(pg_settings_superuser_reserved_connections{${H}}) - ` +
          `(max(pg_settings_reserved_connections{${H}}) or vector(0))`,
        end,
      ),
    ),
    settle(promQuery(`max_over_time(sum(pg_stat_activity_count{${H},state=~"idle in transaction.*"})[${w}:1m])`, end)),
    settle(promQuery(`topk(1, max_over_time(pg_stat_activity_max_tx_duration{${H}}[${w}]))`, end)),
    settle(promQuery(`sum(increase(pg_stat_database_deadlocks{${H}}[${w}]))`, end)),
    settle(promQuery(`max_over_time(sum(pg_locks_count{${H},mode="accessexclusivelock"})[${w}:1m])`, end)),
    settle(
      promQuery(
        `sum(increase(pg_stat_database_blks_hit{${H}}[${w}])) / ` +
          `(sum(increase(pg_stat_database_blks_hit{${H}}[${w}])) + sum(increase(pg_stat_database_blks_read{${H}}[${w}])))`,
        end,
      ),
    ),
    settle(promQuery(`pg_database_size_bytes{${H},datname!~"${SYSTEM_DATABASES}"}`, end)),
    settle(promQuery(`pg_database_size_bytes{${H},datname!~"${SYSTEM_DATABASES}"}`, end - 86400)),
    settle(promQuery(`topk(1, pg_stat_user_tables_n_dead_tup{${H}})`, end)),
    settle(promQuery(`max(pg_replication_is_replica{${H}})`, end)),
    settle(promQuery(`max(pg_replication_lag_seconds{${H}})`, end)),
  ]);

  const dayAgo = new Map((sizesDayAgo || []).map((s) => [s.metric.datname, Number(s.value[1])]));
  const databases = (sizes || [])
    .map((s) => {
      const bytes = Number(s.value[1]);
      const before = dayAgo.get(s.metric.datname);
      return { name: s.metric.datname, bytes, growthBytes: before === undefined ? null : bytes - before };
    })
    .sort((a, b) => b.bytes - a.bytes);

  const longestTx = longest?.[0]
    ? {
        seconds: Number(longest[0].value[1]),
        state: longest[0].metric.state || 'unknown',
        database: longest[0].metric.datname || '',
      }
    : null;
  const hit = first(cacheHit);
  const versionNum = first(version);

  return {
    state: 'up',
    version: versionNum ? `${Math.floor(versionNum / 10000)}.${versionNum % 10000}` : null,
    connectionsMax: first(connections),
    connectionLimit: first(limit),
    idleInTxMax: first(idleInTx),
    longestTx,
    deadlocks: deadlocks?.[0] ? Math.round(Number(deadlocks[0].value[1])) : null,
    exclusiveLocksMax: first(exclusive),
    cacheHitPct: hit === null || Number.isNaN(hit) ? null : hit * 100,
    databases,
    deadRows: await deadRowsOf(H, deadTop?.[0], end),
    replicaLagSec: first(replica) === 1 ? first(lag) : null,
  };
}

/**
 * The table with the most dead rows, with its live rows and last autovacuum.
 * @param {string} H - instance matcher
 * @param {import('./grafana.js').PromSample | undefined} top
 * @param {number} end
 * @returns {Promise<PostgresEvidence['deadRows']>}
 */
async function deadRowsOf(H, top, end) {
  const dead = top ? Number(top.value[1]) : 0;
  if (!top || !dead) return null;
  const { datname, schemaname, relname } = top.metric;
  const same = `${H},datname="${q(datname)}",schemaname="${q(schemaname)}",relname="${q(relname)}"`;
  const [live, vacuumed] = await Promise.all([
    settle(promQuery(`max(pg_stat_user_tables_n_live_tup{${same}})`, end)),
    settle(promQuery(`max(pg_stat_user_tables_last_autovacuum{${same}})`, end)),
  ]);
  const lastAutovacuum = first(vacuumed);
  return {
    table: schemaname === 'public' ? relname : `${schemaname}.${relname}`,
    dead,
    live: first(live) ?? 0,
    lastAutovacuum: lastAutovacuum || null,
  };
}

/**
 * Evidence with nothing measured.
 * @param {PostgresEvidence['state']} state
 * @returns {PostgresEvidence}
 */
function empty(state) {
  return {
    state,
    version: null,
    connectionsMax: null,
    connectionLimit: null,
    idleInTxMax: null,
    longestTx: null,
    deadlocks: null,
    exclusiveLocksMax: null,
    cacheHitPct: null,
    databases: [],
    deadRows: null,
    replicaLagSec: null,
  };
}

/** @param {number} sec */
export function duration(sec) {
  if (sec < 90) return `${Math.round(sec)} s`;
  if (sec < 90 * 60) return `${Math.round(sec / 60)} min`;
  return `${(sec / 3600).toFixed(1)} h`;
}

/** @param {number} bytes */
export function size(bytes) {
  const gb = bytes / 1024 ** 3;
  return gb >= 1 ? `${gb.toFixed(2)} GB` : `${Math.round(bytes / 1024 ** 2)} MB`;
}

/**
 * Verdicts for the Postgres values that cross a threshold (none when all is well).
 * @param {string} host
 * @param {PostgresEvidence} pg
 * @param {number} now - unix seconds, for the age of the last autovacuum
 * @returns {import('./host-health.js').Verdict[]}
 */
export function postgresVerdicts(host, pg, now) {
  if (pg.state === 'down') {
    return [
      {
        status: 'action',
        title: 'Postgres not answering',
        detail: `The Postgres exporter on ${host} runs, but cannot reach the database.`,
        nextStep: "Check the database container on the server: whether it runs, its logs, and the disk it's on.",
      },
    ];
  }
  /** @type {import('./host-health.js').Verdict[]} */
  const verdicts = [];
  const { connectionsMax: used, connectionLimit: limit } = pg;
  if (used !== null && limit) {
    const share = (used / limit) * 100;
    if (share >= PG_NOTABLE.connectionsPct) {
      const idle = pg.idleInTxMax ? `, ${pg.idleInTxMax} of them idle in a transaction` : '';
      verdicts.push({
        status: share >= PG_NOTABLE.connectionsActionPct ? 'action' : 'watch',
        title: 'Postgres connections near the limit',
        detail: `Up to ${used} of ${limit} usable connections (${Math.round(share)}%)${idle}.`,
        nextStep:
          'Find which application holds them (pg_stat_activity by application_name); a pool that never returns ' +
          'connections or a burst of workers is the usual cause.',
      });
    }
  }
  if (pg.longestTx && pg.longestTx.seconds >= PG_NOTABLE.longTxSec) {
    const idle = pg.longestTx.state.startsWith('idle in transaction');
    verdicts.push({
      status: pg.longestTx.seconds >= PG_NOTABLE.longTxActionSec ? 'action' : 'watch',
      title: idle ? 'Transaction left open' : 'Long-running query',
      detail: `A transaction in \`${pg.longestTx.database}\` was open for ${duration(pg.longestTx.seconds)} (${pg.longestTx.state}).${
        idle ? ' It holds its locks and keeps vacuum from cleaning up while it waits.' : ''
      }`,
      nextStep: idle
        ? 'Find the session in pg_stat_activity (state "idle in transaction") and the code that does not commit; end it with pg_terminate_backend if it blocks others.'
        : 'Look at the query in pg_stat_activity; check it is expected (report, migration, backup) before cancelling it.',
    });
  }
  if (pg.deadlocks) {
    verdicts.push({
      status: 'watch',
      title: 'Postgres deadlocks',
      detail: `${pg.deadlocks} deadlock${pg.deadlocks === 1 ? '' : 's'} in the window; Postgres cancelled one transaction each time.`,
      nextStep: 'Search the logs for "deadlock detected" (host_logs) to see which statements collided.',
    });
  }
  const d = pg.deadRows;
  if (d && d.dead >= PG_NOTABLE.deadRows && d.dead / Math.max(1, d.dead + d.live) >= PG_NOTABLE.deadShare) {
    const vacuumed = d.lastAutovacuum
      ? `last autovacuum ${duration(now - d.lastAutovacuum)} ago`
      : 'never autovacuumed';
    verdicts.push({
      status: 'watch',
      title: 'Vacuum falling behind',
      detail: `\`${d.table}\` has ${d.dead.toLocaleString('en')} dead rows (${Math.round((d.dead / (d.dead + d.live)) * 100)}% of its rows), ${vacuumed}.`,
      nextStep:
        'Check for long-open transactions (they block cleanup) and the autovacuum settings for that table; a manual VACUUM ANALYZE clears it.',
    });
  }
  if (pg.replicaLagSec !== null && pg.replicaLagSec >= PG_NOTABLE.replicaLagSec) {
    verdicts.push({
      status: 'watch',
      title: 'Replica behind',
      detail: `This replica is ${duration(pg.replicaLagSec)} behind its primary.`,
      nextStep: 'Check the network to the primary and heavy writes there.',
    });
  }
  return verdicts;
}

/**
 * One line with the Postgres values, for the health answer.
 * @param {PostgresEvidence} pg
 * @returns {string}
 */
export function postgresLine(pg) {
  if (pg.state === 'exporter-down') return 'Postgres: the Postgres exporter is not answering, so no database metrics.';
  if (pg.state === 'down') return 'Postgres: not answering.';
  const parts = [
    pg.connectionsMax !== null &&
      `${pg.connectionsMax}${pg.connectionLimit ? ` of ${pg.connectionLimit}` : ''} connections at the peak${
        pg.idleInTxMax ? ` (${pg.idleInTxMax} idle in a transaction)` : ''
      }`,
    pg.longestTx && `longest transaction ${duration(pg.longestTx.seconds)}`,
    pg.deadlocks !== null && `${pg.deadlocks} deadlocks`,
    pg.exclusiveLocksMax ? `${pg.exclusiveLocksMax} exclusive table locks at the peak` : null,
    pg.cacheHitPct !== null && `cache hits ${pg.cacheHitPct >= 99.95 ? '100' : pg.cacheHitPct.toFixed(1)}%`,
    ...pg.databases.map(
      (db) =>
        `\`${db.name}\` ${size(db.bytes)}${
          db.growthBytes !== null
            ? ` (${db.growthBytes >= 0 ? '+' : '-'}${size(Math.abs(db.growthBytes))} in 24 h)`
            : ''
        }`,
    ),
    pg.deadRows &&
      pg.deadRows.dead >= 10_000 &&
      `most dead rows: \`${pg.deadRows.table}\` ${pg.deadRows.dead.toLocaleString('en')}`,
    pg.replicaLagSec !== null && `replica lag ${duration(pg.replicaLagSec)}`,
  ].filter(Boolean);
  return clip(`Postgres${pg.version ? ` ${pg.version}` : ''}: ${parts.join(', ')}.`, 600);
}
