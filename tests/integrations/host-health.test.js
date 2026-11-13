import assert from 'node:assert';
import { describe, it } from 'node:test';

import {
  alertKind,
  clip,
  diagnose,
  logPattern,
  readableLogLine,
  VERDICT_STATUS,
} from '../../integrations/host-health.js';

/** Title and detail as one string, for matching. */
const verdictOf = (kind, e) => {
  const v = diagnose(kind, e);
  return `${v.title}: ${v.detail}`;
};

/** Evidence of a healthy, reachable 2-CPU host; tests override what they need. */
const base = (overrides = {}) => ({
  host: 'alpha',
  from: 0,
  start: 1000,
  end: 1360,
  cpus: 2,
  load1: { max: 1, at: 1100 },
  cpu: { user: 0.2, system: 0.05, iowait: 0, steal: 0, idle: 0.75 },
  procsRunningMax: 2,
  procsBlockedMax: 0,
  memUsedPctMax: 50,
  swap: { startMb: 100, endMb: 100 },
  diskBusyPctMax: 5,
  filesystems: [],
  reachability: { nodeUp: true, nodeLastSeen: 1350, exporterUp: true },
  healthChecks: [],
  logs: { byService: { 'phoenix-worker': 100 }, errorCount: 0, topErrors: [] },
  ...overrides,
});

describe('alertKind', () => {
  it('classifies the rule titles in use', () => {
    assert.strictEqual(alertKind('High System Load Over All CPU Cores Together'), 'load');
    assert.strictEqual(alertKind('High Memory Usage'), 'memory');
    assert.strictEqual(alertKind('High Storage Disk Usage'), 'disk');
    assert.strictEqual(alertKind('Phoenix Docker Container Might be Frozen/Stuck'), 'exporter');
    assert.strictEqual(alertKind('Phoenix Machine is Fully DOWN Health Checker'), 'machine');
    assert.strictEqual(alertKind('Uptime Kuma - Monitor Down'), 'uptime');
    assert.strictEqual(alertKind('Database Health Checker'), 'health');
  });
});

describe('diagnose', () => {
  it('calls a load spike with an idle CPU a false alarm', () => {
    const e = base({ load1: { max: 16, at: 1100 }, cpu: { user: 0.1, system: 0.05, iowait: 0, steal: 0, idle: 0.85 } });
    const v = diagnose('load', e);
    assert.strictEqual(v.status, 'false-alarm');
    assert.match(v.title, /Not real CPU pressure/);
    assert.match(v.nextStep, /CPU use instead of load average/);
  });

  it('links an idle-CPU load spike to coinciding waiting errors', () => {
    const e = base({
      load1: { max: 16, at: 1100 },
      cpu: { user: 0.1, system: 0.05, iowait: 0, steal: 0, idle: 0.85 },
      logs: {
        byService: {},
        errorCount: 3,
        topErrors: [
          {
            pattern: 'database down: Connection pool exhausted',
            sample: 'database down: Connection pool exhausted',
            count: 3,
            service: 'phoenix-system',
          },
        ],
      },
    });
    assert.match(verdictOf('load', e), /3× "pool exhausted" at the same time, the likely reason/);
  });

  it('recognises real CPU saturation, disk wait, and hypervisor steal', () => {
    const busy = base({
      load1: { max: 4, at: 1100 },
      cpu: { user: 0.85, system: 0.1, iowait: 0, steal: 0, idle: 0.05 },
    });
    assert.match(verdictOf('load', busy), /CPU saturated/);
    const disk = base({
      load1: { max: 4, at: 1100 },
      cpu: { user: 0.1, system: 0.05, iowait: 0.4, steal: 0, idle: 0.45 },
    });
    assert.match(verdictOf('load', disk), /Waiting on disk/);
    const steal = base({
      load1: { max: 4, at: 1100 },
      cpu: { user: 0.3, system: 0.05, iowait: 0, steal: 0.3, idle: 0.35 },
    });
    assert.match(verdictOf('load', steal), /Hetzner host contention/);
  });

  it('reports an unreachable machine before anything else', () => {
    const e = base({ reachability: { nodeUp: false, nodeLastSeen: 1000, exporterUp: false } });
    assert.match(verdictOf('health', e), /Server unreachable/);
    assert.match(verdictOf('health', e), /health exporter is down too/);
  });

  it('separates a stuck exporter from a dead machine', () => {
    const e = base({ reachability: { nodeUp: true, nodeLastSeen: 1350, exporterUp: false } });
    assert.match(verdictOf('exporter', e), /Health exporter stuck, server is up/);
  });

  it('blames a full database pool, not the exporter, when Phoenix logs it', () => {
    const e = base({
      reachability: { nodeUp: true, nodeLastSeen: 1350, exporterUp: false },
      logs: {
        byService: {},
        errorCount: 4,
        topErrors: [
          {
            pattern: 'x',
            sample:
              'Health Check has failed! {"database":{"status":"down","message":"Connection pool exhausted: 45 waiting"}}',
            count: 4,
            service: 'phoenix-system',
          },
        ],
      },
    });
    const v = diagnose('exporter', e);
    assert.strictEqual(v.status, 'action');
    assert.match(v.title, /Database connection pool full, server is up/);
    assert.match(v.detail, /phoenix-system logged 4× "pool exhausted"/);
    assert.match(v.nextStep, /pg_stat_activity/);
  });

  it('does not treat a missing heartbeat alone as a dead machine', () => {
    assert.match(verdictOf('machine', base()), /Heartbeat missing, server is up/);
  });

  it('names the failing Phoenix checks', () => {
    const e = base({
      healthChecks: [
        { check: 'database', now: 0, minInWindow: 0 },
        { check: 'worker', now: 1, minInWindow: 1 },
      ],
    });
    assert.match(verdictOf('health', e), /Phoenix checks failing: `database` went down and are still down/);
  });

  it('names a full database pool as the cause of failed or recovered checks', () => {
    const poolLogs = {
      byService: {},
      errorCount: 8,
      topErrors: [
        {
          pattern: 'x',
          sample: 'Health Check has failed! {"database":{"status":"down","message":"Connection pool exhausted"}}',
          count: 8,
          service: 'phoenix-system',
        },
      ],
    };
    const recovered = diagnose(
      'health',
      base({ healthChecks: [{ check: 'database', now: 1, minInWindow: 0 }], logs: poolLogs }),
    );
    assert.strictEqual(recovered.status, 'watch');
    assert.strictEqual(recovered.title, 'Database connection pool was full, recovered');
    assert.match(recovered.detail, /Likely cause: phoenix-system logged 8× "pool exhausted" at the same time\./);
    assert.match(recovered.nextStep, /^It recovered on its own\. If it repeats, look for long-running queries/);

    const failing = diagnose(
      'health',
      base({ healthChecks: [{ check: 'database', now: 0, minInWindow: 0 }], logs: poolLogs }),
    );
    assert.strictEqual(failing.status, 'action');
    assert.strictEqual(failing.title, 'Database connection pool full');
    assert.match(failing.nextStep, /^First look for long-running queries .* restart phoenix-app\./);
  });

  it('names other waiting errors without calling them a pool problem', () => {
    const e = base({
      healthChecks: [{ check: 'database', now: 1, minInWindow: 0 }],
      logs: {
        byService: {},
        errorCount: 2,
        topErrors: [{ pattern: 'x', sample: 'upstream timed out (110)', count: 2, service: 'phx-app' }],
      },
    });
    const v = diagnose('health', e);
    assert.strictEqual(v.title, 'Phoenix checks recovered');
    assert.match(v.detail, /Likely cause: phx-app logged 2× "timed out"/);
    assert.match(v.nextStep, /Start from the "timed out" errors below/);
  });

  it('flags growing swap as real memory pressure', () => {
    const e = base({ memUsedPctMax: 95, swap: { startMb: 100, endMb: 900 } });
    assert.match(verdictOf('memory', e), /Running out of memory: .*Swap is growing/);
  });

  it('estimates when a disk will be full', () => {
    const e = base({ filesystems: [{ mount: '/', usedPct: 85, growthGbPerDay: 2, daysToFull: 6 }] });
    assert.match(verdictOf('disk', e), /Disk filling up: `\/` is 85% used, \+2\.0 GB in 24 h\. Full in about 6 days/);
  });
});

const PHOENIX_HEALTH_LINE =
  '11/13/26, 3:47 P11 - [PHX] - \x1b[31merror\x1b[39m: Health Check has failed! {"admin-api":{"status":"up"},' +
  '"database":{"status":"down","message":"Connection pool exhausted: 45 waiting, 100/100 total, 0 idle","waitingCount":45}}';
const NGINX_LINE =
  '2026/11/13 17:38:24 [error] 37#37: *954 upstream timed out (110: Operation timed out) while reading response header ' +
  'from upstream, client: 192.0.2.10, server: _, request: "GET /ws HTTP/1.1", upstream: "http://172.19.0.5:3000/graphql"';

describe('readableLogLine', () => {
  it('drops the timestamp, colour codes and healthy components, keeping the failing one', () => {
    assert.strictEqual(
      readableLogLine(PHOENIX_HEALTH_LINE),
      '[PHX] - error: Health Check has failed! {"database":{"status":"down","message":"Connection pool exhausted: 45 waiting, 100/100 total, 0 idle","waitingCount":45}}',
    );
  });

  it('drops nginx timestamps, worker ids and the client address', () => {
    assert.strictEqual(
      readableLogLine(NGINX_LINE),
      '[error] upstream timed out (110: Operation timed out) while reading response header from upstream, server: _, request: "GET /ws HTTP/1.1", upstream: "http://172.19.0.5:3000/graphql"',
    );
  });
});

describe('clip', () => {
  it('keeps short text and cuts long text at a word with an ellipsis', () => {
    assert.strictEqual(clip('short', 10), 'short');
    assert.strictEqual(clip('alpha beta gamma delta', 15), 'alpha beta…');
    assert.ok(clip('x'.repeat(50), 10).length === 10);
  });
});

describe('logPattern', () => {
  it('groups lines that differ only in numbers, ids, and timestamps', () => {
    const a = logPattern('2026-11-12T07:25:01.123Z error: task 4711 failed (id 9f8e7d6c5b4a)');
    const b = logPattern('2026-11-12T07:26:59.001Z error: task 815 failed (id 0a1b2c3d4e5f)');
    assert.strictEqual(a, b);
  });
});

describe('VERDICT_STATUS', () => {
  it('gives every verdict status exactly one emoji and label', () => {
    for (const { emoji, label } of Object.values(VERDICT_STATUS)) {
      assert.match(emoji, /^:[a-z_]+:$/);
      assert.ok(label.length > 0);
    }
  });
});
