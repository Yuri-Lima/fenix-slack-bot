import assert from 'node:assert';
import { describe, it } from 'node:test';

import { alertKind, diagnose, logPattern } from '../../integrations/host-health.js';

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
    const { verdict, nextStep } = diagnose('load', e);
    assert.match(verdict, /Not real CPU pressure/);
    assert.match(nextStep, /CPU utilisation/);
  });

  it('links an idle-CPU load spike to coinciding waiting errors', () => {
    const e = base({
      load1: { max: 16, at: 1100 },
      cpu: { user: 0.1, system: 0.05, iowait: 0, steal: 0, idle: 0.85 },
      logs: {
        byService: {},
        errorCount: 3,
        topErrors: [{ pattern: 'database down: Connection pool exhausted', count: 3, service: 'phoenix-system' }],
      },
    });
    assert.match(diagnose('load', e).verdict, /pool exhausted, the likely thing they were waiting for/);
  });

  it('recognises real CPU saturation, disk wait, and hypervisor steal', () => {
    const busy = base({
      load1: { max: 4, at: 1100 },
      cpu: { user: 0.85, system: 0.1, iowait: 0, steal: 0, idle: 0.05 },
    });
    assert.match(diagnose('load', busy).verdict, /Real CPU saturation/);
    const disk = base({
      load1: { max: 4, at: 1100 },
      cpu: { user: 0.1, system: 0.05, iowait: 0.4, steal: 0, idle: 0.45 },
    });
    assert.match(diagnose('load', disk).verdict, /Disk-bound/);
    const steal = base({
      load1: { max: 4, at: 1100 },
      cpu: { user: 0.3, system: 0.05, iowait: 0, steal: 0.3, idle: 0.35 },
    });
    assert.match(diagnose('load', steal).verdict, /Hetzner host contention/);
  });

  it('reports an unreachable machine before anything else', () => {
    const e = base({ reachability: { nodeUp: false, nodeLastSeen: 1000, exporterUp: false } });
    assert.match(diagnose('health', e).verdict, /is unreachable/);
    assert.match(diagnose('health', e).verdict, /health exporter is down too/);
  });

  it('separates a stuck exporter from a dead machine', () => {
    const e = base({ reachability: { nodeUp: true, nodeLastSeen: 1350, exporterUp: false } });
    assert.match(diagnose('exporter', e).verdict, /Health exporter stuck, machine fine/);
  });

  it('does not treat a missing heartbeat alone as a dead machine', () => {
    assert.match(diagnose('machine', base()).verdict, /Heartbeat missing, machine fine/);
  });

  it('names the failing Phoenix checks', () => {
    const e = base({
      healthChecks: [
        { check: 'database', now: 0, minInWindow: 0 },
        { check: 'worker', now: 1, minInWindow: 1 },
      ],
    });
    assert.match(diagnose('health', e).verdict, /`database` went down, all still down/);
  });

  it('flags growing swap as real memory pressure', () => {
    const e = base({ memUsedPctMax: 95, swap: { startMb: 100, endMb: 900 } });
    assert.match(diagnose('memory', e).verdict, /Swap is growing/);
  });

  it('estimates when a disk will be full', () => {
    const e = base({ filesystems: [{ mount: '/', usedPct: 85, growthGbPerDay: 2, daysToFull: 6 }] });
    assert.match(diagnose('disk', e).verdict, /`\/` is 85% used \(\+2\.0 GB in 24 h\), full in about 6 days/);
  });
});

describe('logPattern', () => {
  it('groups lines that differ only in numbers, ids, and timestamps', () => {
    const a = logPattern('2026-11-12T07:25:01.123Z error: task 4711 failed (id 9f8e7d6c5b4a)');
    const b = logPattern('2026-11-12T07:26:59.001Z error: task 815 failed (id 0a1b2c3d4e5f)');
    assert.strictEqual(a, b);
  });
});
