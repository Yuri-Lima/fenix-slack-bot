import { config } from '../config.js';
import { lokiInstant, lokiRange, promQuery, promRange } from './grafana.js';

// Evidence about one host over a time window, gathered from Prometheus
// (node_exporter, Phoenix health exporter) and Loki, plus the diagnosis that
// turns it into a plain-language verdict. Every query may fail on its own;
// missing evidence is reported as unknown rather than failing the analysis.

/** Seconds of context collected before an alert started. */
export const LEAD_IN_SEC = 15 * 60;
const ERROR_LINE_RE = '(?i)(error|exception|fatal|panic|killed|oom|timeout|refused|unreachable)';
const MAX_ERROR_LINES = 300;
/** Errors that explain tasks waiting without using CPU (load average up, CPU idle). */
const WAIT_CAUSE_RE = /pool exhausted|timed? ?out|connection reset|connection refused|deadlock|lock wait/i;
/** A host counts as unreachable when its last metric sample is older than this at the end of the window. */
const STALE_AFTER_SEC = 120;
/** Analysis window after the alert start; a still-firing alert is analysed right away, so this only bounds replays. */
const MAX_WINDOW_SEC = 30 * 60;

/** Kinds of alert rules Fenix knows how to explain. */
export const ALERT_KINDS = /** @type {const} */ ([
  'load',
  'memory',
  'disk',
  'health',
  'exporter',
  'machine',
  'uptime',
  'other',
]);
/** @typedef {(typeof ALERT_KINDS)[number]} AlertKind */

/**
 * Classify an alert rule by its title.
 * @param {string} title
 * @returns {AlertKind}
 */
export function alertKind(title) {
  if (/system load|cpu/i.test(title)) return 'load';
  if (/memory/i.test(title)) return 'memory';
  if (/disk|storage/i.test(title)) return 'disk';
  if (/frozen|stuck/i.test(title)) return 'exporter';
  if (/fully down|machine/i.test(title)) return 'machine';
  if (/uptime kuma/i.test(title)) return 'uptime';
  if (/health|portal|redis|database|worker/i.test(title)) return 'health';
  return 'other';
}

/**
 * Escape a value for a PromQL/LogQL double-quoted string.
 * @param {string} value
 * @returns {string}
 */
const q = (value) => value.replace(/\\/g, '\\\\').replace(/"/g, '\\"');

/**
 * Escape a host name for use inside a regex label matcher.
 * @param {string} value
 * @returns {string}
 */
const re = (value) => q(value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));

/**
 * @template T
 * @param {Promise<T>} promise
 * @returns {Promise<T | null>}
 */
const settle = (promise) => promise.catch(() => null);

/**
 * @param {import('./grafana.js').PromSeries[] | null} series
 * @returns {Array<[number, number]>}
 */
const points = (series) => (series?.[0]?.values || []).map(([t, v]) => [t, Number(v)]);

/**
 * @param {Array<[number, number]>} pts
 * @returns {{ max: number, at: number } | null}
 */
function peak(pts) {
  if (pts.length === 0) return null;
  return pts.reduce((best, [t, v]) => (v > best.max ? { max: v, at: t } : best), {
    max: Number.NEGATIVE_INFINITY,
    at: 0,
  });
}

/**
 * Average of the points whose timestamp lies in [from, to].
 * @param {Array<[number, number]>} pts
 * @param {number} from
 * @param {number} to
 * @returns {number | null}
 */
function avgIn(pts, from, to) {
  const inside = pts.filter(([t]) => t >= from && t <= to).map(([, v]) => v);
  return inside.length ? inside.reduce((a, b) => a + b, 0) / inside.length : null;
}

/**
 * Collapse a log line into a pattern so repeats group together.
 * @param {string} line
 * @returns {string}
 */
export function logPattern(line) {
  return (
    line
      // biome-ignore lint/suspicious/noControlCharactersInRegex: strips ANSI color codes, which start with ESC (\x1b)
      .replace(/\x1b\[[0-9;]*m/g, '')
      .replace(/\d{4}-\d\d-\d\d[T ][\d:.,]+Z?/g, '<time>')
      .replace(/\b[0-9a-f]{8,}\b/gi, '<id>')
      .replace(/\b\d+(\.\d+)*\b/g, '<n>')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 160)
  );
}

/**
 * @typedef {Object} HostEvidence
 * @property {string} host
 * @property {number} from - Window start (unix seconds), lead-in included
 * @property {number} start - Alert start (unix seconds)
 * @property {number} end - Alert end, or now when still firing
 * @property {number | null} cpus
 * @property {{ max: number, at: number } | null} load1
 * @property {{ user: number, system: number, iowait: number, steal: number, idle: number } | null} cpu - Average share of all CPUs during the alert (0-1)
 * @property {number | null} procsRunningMax
 * @property {number | null} procsBlockedMax
 * @property {number | null} memUsedPctMax
 * @property {{ startMb: number, endMb: number } | null} swap
 * @property {number | null} diskBusyPctMax
 * @property {Array<{ mount: string, usedPct: number, growthGbPerDay: number | null, daysToFull: number | null }>} filesystems
 * @property {{ nodeUp: boolean | null, nodeLastSeen: number | null, exporterUp: boolean | null }} reachability
 * @property {Array<{ check: string, now: number, minInWindow: number }>} healthChecks
 * @property {{ byService: Record<string, number>, errorCount: number, topErrors: Array<{ pattern: string, count: number, service: string }> } | null} logs
 */

/**
 * Gather metrics and logs for a host around an alert.
 * @param {string} host - Host name as shown in the alert (node_exporter instance, Loki host prefix)
 * @param {{ start: number, end?: number }} window - Unix seconds; end defaults to now
 * @returns {Promise<HostEvidence>}
 */
export async function collectHostEvidence(host, { start, end }) {
  const now = Math.floor(Date.now() / 1000);
  const to = Math.min(end ?? now, now, start + MAX_WINDOW_SEC);
  const from = start - LEAD_IN_SEC;
  const step = Math.max(30, Math.round((to - from) / 40));
  const H = q(host);
  const HR = re(host);
  const windowSec = Math.max(60, to - from);

  const [
    cpus,
    load,
    cpuModes,
    running,
    blocked,
    mem,
    swap,
    disk,
    fsNow,
    fsDayAgo,
    lastSample,
    lastSampleAtEnd,
    exporterUp,
    health,
    logVolume,
    errorStreams,
  ] = await Promise.all([
    settle(promQuery(`count(node_cpu_seconds_total{instance="${H}",mode="idle"})`, to)),
    settle(promRange(`node_load1{instance="${H}"}`, from, to, step)),
    settle(promRange(`sum by (mode) (rate(node_cpu_seconds_total{instance="${H}"}[2m]))`, from, to, step)),
    settle(promRange(`node_procs_running{instance="${H}"}`, from, to, step)),
    settle(promRange(`node_procs_blocked{instance="${H}"}`, from, to, step)),
    settle(
      promRange(
        `100 * (1 - node_memory_MemAvailable_bytes{instance="${H}"} / node_memory_MemTotal_bytes{instance="${H}"})`,
        from,
        to,
        step,
      ),
    ),
    settle(
      promRange(
        `(node_memory_SwapTotal_bytes{instance="${H}"} - node_memory_SwapFree_bytes{instance="${H}"}) / 1e6`,
        from,
        to,
        step,
      ),
    ),
    settle(promRange(`100 * max(rate(node_disk_io_time_seconds_total{instance="${H}"}[2m]))`, from, to, step)),
    settle(
      promQuery(
        `100 - 100 * node_filesystem_free_bytes{instance="${H}",fstype!~"tmpfs|ramfs|vfat"} / node_filesystem_size_bytes{instance="${H}",fstype!~"tmpfs|ramfs|vfat"}`,
        to,
      ),
    ),
    settle(
      promQuery(
        `(node_filesystem_size_bytes{instance="${H}",fstype!~"tmpfs|ramfs|vfat"} - node_filesystem_free_bytes{instance="${H}",fstype!~"tmpfs|ramfs|vfat"}) / 1e9`,
        to - 86400,
      ),
    ),
    settle(promRange(`timestamp(node_load1{instance="${H}"})`, from, to, step)),
    settle(promQuery(`timestamp(node_load1{instance="${H}"})`, to)),
    settle(promQuery(`up{instance="${H}-health-exporter"}`, to)),
    settle(promRange(`{__name__=~"phoenix_.*_from_py",server_name="${H}"}`, from, to, Math.min(step, 60))),
    settle(lokiInstant(`sum by (service) (count_over_time({host=~"${HR}.*"}[${windowSec}s]))`, to)),
    settle(lokiRange(`{host=~"${HR}.*"} |~ "${q(ERROR_LINE_RE)}"`, from, to, MAX_ERROR_LINES)),
  ]);

  // CPU: average share per mode while the alert was active
  let cpu = null;
  const cpuCount = cpus?.[0] ? Number(cpus[0].value[1]) : null;
  if (cpuModes?.length && cpuCount) {
    /** @param {string} mode */
    const share = (mode) => {
      const s = cpuModes.find((c) => c.metric.mode === mode);
      const v = s ? avgIn(points([s]), start, to) : null;
      return v === null ? 0 : v / cpuCount;
    };
    cpu = {
      user: share('user'),
      system: share('system'),
      iowait: share('iowait'),
      steal: share('steal'),
      idle: share('idle'),
    };
  }

  const swapPts = points(swap);
  const fsUsedYesterday = new Map((fsDayAgo || []).map((s) => [s.metric.mountpoint, Number(s.value[1])]));
  const filesystems = (fsNow || [])
    .map((s) => {
      const usedPct = Number(s.value[1]);
      return { mount: s.metric.mountpoint, usedPct, device: s.metric.device };
    })
    .filter((f, i, all) => all.findIndex((g) => g.device === f.device) === i)
    .map(({ mount, usedPct }) => ({
      mount,
      usedPct,
      growthGbPerDay: /** @type {number | null} */ (null),
      daysToFull: /** @type {number | null} */ (null),
    }));
  if (filesystems.length) {
    const sizes = await settle(
      promQuery(`node_filesystem_size_bytes{instance="${H}",fstype!~"tmpfs|ramfs|vfat"} / 1e9`, to),
    );
    for (const f of filesystems) {
      const sizeGb = Number(sizes?.find((s) => s.metric.mountpoint === f.mount)?.value[1]);
      const usedYesterdayGb = fsUsedYesterday.get(f.mount);
      if (!sizeGb || usedYesterdayGb === undefined) continue;
      const usedNowGb = (f.usedPct / 100) * sizeGb;
      const growth = usedNowGb - usedYesterdayGb;
      f.growthGbPerDay = growth;
      f.daysToFull = growth > 0.01 ? (sizeGb - usedNowGb) / growth : null;
    }
  }

  // Last time node_exporter actually delivered a sample (exact, unlike `up`)
  const sampleTimes = points(lastSample).map(([, v]) => v);
  const atEnd = lastSampleAtEnd?.[0] ? Number(lastSampleAtEnd[0].value[1]) : null;
  const nodeLastSeen = atEnd ?? (sampleTimes.length ? Math.max(...sampleTimes) : null);

  const healthChecks = (health || [])
    .filter((s) => s.values.length)
    .map((s) => {
      const vals = s.values.map(([, v]) => Number(v));
      return { check: checkName(s.metric), now: vals[vals.length - 1], minInWindow: Math.min(...vals) };
    });

  let logs = null;
  if (logVolume || errorStreams) {
    const byService = Object.fromEntries(
      (logVolume || []).map((s) => [s.metric.service || 'unknown', Math.round(Number(s.value[1]))]),
    );
    const groups = new Map();
    let errorCount = 0;
    for (const stream of errorStreams || []) {
      for (const [, line] of stream.values) {
        errorCount++;
        const pattern = logPattern(line);
        const g = groups.get(pattern) || { pattern, count: 0, service: stream.stream.service || 'unknown' };
        g.count++;
        groups.set(pattern, g);
      }
    }
    const topErrors = [...groups.values()].sort((a, b) => b.count - a.count).slice(0, 3);
    logs = { byService, errorCount, topErrors };
  }

  return {
    host,
    from,
    start,
    end: to,
    cpus: cpuCount,
    load1: peak(points(load)),
    cpu,
    procsRunningMax: peak(points(running))?.max ?? null,
    procsBlockedMax: peak(points(blocked))?.max ?? null,
    memUsedPctMax: peak(points(mem))?.max ?? null,
    swap: swapPts.length ? { startMb: swapPts[0][1], endMb: swapPts[swapPts.length - 1][1] } : null,
    diskBusyPctMax: peak(points(disk))?.max ?? null,
    filesystems,
    reachability: {
      nodeUp: nodeLastSeen === null ? null : to - nodeLastSeen <= STALE_AFTER_SEC,
      nodeLastSeen,
      exporterUp: exporterUp?.length ? Number(exporterUp[0].value[1]) === 1 : null,
    },
    healthChecks,
    logs,
  };
}

/**
 * `phoenix_worker_up_from_py` -> `worker`, `phoenix_database_healthy_from_py` -> `database health`
 * @param {Record<string, string>} metric
 * @returns {string}
 */
function checkName(metric) {
  return (metric.__name__ || '')
    .replace(/^phoenix_|_from_py$/g, '')
    .replace(/_healthy$/, ' health')
    .replace(/_up$/, '')
    .replace(/_/g, ' ');
}

const pct = (/** @type {number} */ share) => `${Math.round(share * 100)}%`;

/**
 * Plain-language verdict for an alert, from the evidence.
 * @param {AlertKind} kind
 * @param {HostEvidence} e
 * @returns {{ verdict: string, nextStep: string }}
 */
export function diagnose(kind, e) {
  const unreachable = e.reachability.nodeUp === false;
  if (unreachable) {
    return {
      verdict: `*${e.host} is unreachable:* its host metrics stopped${
        e.reachability.nodeLastSeen ? ` (last seen ${clock(e.reachability.nodeLastSeen)})` : ''
      }${e.reachability.exporterUp === false ? ' and the Phoenix health exporter is down too' : ''}. This is the whole machine or its network, not a single service.`,
      nextStep: 'Check the server in the Hetzner console (power, network, disk full) before looking at Phoenix itself.',
    };
  }

  if (kind === 'machine' && e.reachability.nodeUp) {
    return {
      verdict: `*Heartbeat missing, machine fine:* host metrics from ${e.host} keep arriving, so the server is up; only the heartbeat signal stopped.`,
      nextStep: 'Check the heartbeat agent on the server; nothing else needs attention.',
    };
  }

  if (kind === 'load' && e.load1 && e.cpus && e.cpu) {
    const ratio = e.load1.max / e.cpus;
    const busy = 1 - e.cpu.idle;
    if (e.cpu.steal > 0.2) {
      return {
        verdict: `*Hetzner host contention:* ${pct(e.cpu.steal)} of CPU time was stolen by the hypervisor while load reached ${e.load1.max.toFixed(1)} on ${e.cpus} CPUs.`,
        nextStep: 'Nothing on this server to fix; if it repeats, move it to a dedicated-vCPU plan.',
      };
    }
    if (e.cpu.iowait > 0.2 || (e.diskBusyPctMax ?? 0) > 80) {
      return {
        verdict: `*Disk-bound:* load reached ${e.load1.max.toFixed(1)} on ${e.cpus} CPUs while the CPU waited on disk ${pct(e.cpu.iowait)} of the time (disk busy up to ${Math.round(e.diskBusyPctMax ?? 0)}%).`,
        nextStep: 'Look for heavy disk work at that time: backups, database vacuum/dumps, log bursts.',
      };
    }
    if (busy < 0.5) {
      const waitingOn = e.logs?.topErrors.find((t) => WAIT_CAUSE_RE.test(t.pattern));
      return {
        verdict: `*Not real CPU pressure:* load reached ${e.load1.max.toFixed(1)} on ${e.cpus} CPUs (${Math.round(ratio * 100)}%), but the CPU was ${pct(e.cpu.idle)} idle, with no disk wait and no steal. The load average was inflated by tasks waiting without using CPU or disk${
          waitingOn
            ? `, and at the same time ${waitingOn.service} logged ${waitingOn.count} errors about ${WAIT_CAUSE_RE.exec(waitingOn.pattern)?.[0].toLowerCase()}, the likely thing they were waiting for`
            : ''
        }.`,
        nextStep: waitingOn
          ? 'Fix the waiting cause in the errors below; separately, alerting on CPU utilisation instead of load average would stop this kind of false alarm.'
          : 'The rule measures load average, which over-counts waiting tasks. Alerting on CPU utilisation instead would remove this false alarm.',
      };
    }
    return {
      verdict: `*Real CPU saturation:* the CPU was ${pct(busy)} busy (user ${pct(e.cpu.user)}, system ${pct(e.cpu.system)}) and load reached ${e.load1.max.toFixed(1)} on ${e.cpus} CPUs.`,
      nextStep: e.logs?.byService
        ? `Check what ${topService(e.logs.byService)} was doing at ${clock(e.load1.at)}; if this repeats, the server needs more CPUs.`
        : 'Find the busy process on the server; if this repeats, the server needs more CPUs.',
    };
  }

  if (kind === 'memory' && e.memUsedPctMax !== null) {
    const swapGrew = e.swap && e.swap.endMb - e.swap.startMb > 100;
    return {
      verdict: `*Memory pressure:* up to ${Math.round(e.memUsedPctMax)}% used${
        e.swap ? `, swap ${Math.round(e.swap.startMb)} → ${Math.round(e.swap.endMb)} MB` : ''
      }.${swapGrew ? ' Swap is growing, so the server is short of memory, not just caching.' : ''}`,
      nextStep: swapGrew
        ? 'Restart or limit the service using the most memory; if it repeats, give the server more RAM.'
        : 'Watch whether usage drops on its own; a one-off peak usually comes from a large import or report.',
    };
  }

  if (kind === 'disk' && e.filesystems.length) {
    const worst = [...e.filesystems].sort((a, b) => b.usedPct - a.usedPct)[0];
    const eta =
      worst.daysToFull !== null
        ? `, full in about ${Math.max(1, Math.round(worst.daysToFull))} days at the current rate`
        : '';
    return {
      verdict: `*Disk filling up:* \`${worst.mount}\` is ${Math.round(worst.usedPct)}% used${
        worst.growthGbPerDay !== null
          ? ` (${worst.growthGbPerDay >= 0 ? '+' : ''}${worst.growthGbPerDay.toFixed(1)} GB in 24 h)`
          : ''
      }${eta}.`,
      nextStep: 'Clean up old Docker images/volumes, logs and backups, or enlarge the volume.',
    };
  }

  if (kind === 'exporter') {
    if (e.reachability.nodeUp && e.reachability.exporterUp === false) {
      return {
        verdict: `*Health exporter stuck, machine fine:* host metrics from ${e.host} still arrive, but the Phoenix health exporter stopped answering.`,
        nextStep: 'Restart the health-exporter container on the server; Phoenix itself may be fine.',
      };
    }
  }

  const down = e.healthChecks.filter((c) => c.minInWindow === 0);
  if ((kind === 'health' || kind === 'exporter') && e.healthChecks.length) {
    if (down.length) {
      const stillDown = down.filter((c) => c.now === 0);
      return {
        verdict: `*Phoenix checks failing on ${e.host}:* ${down.map((c) => `\`${c.check}\``).join(', ')} went down${
          stillDown.length
            ? `, ${stillDown.length === down.length ? 'all still down' : `${stillDown.map((c) => c.check).join(', ')} still down`}`
            : ', all recovered now'
        }. Host metrics are ${e.reachability.nodeUp ? 'normal' : 'missing'}.`,
        nextStep: e.logs?.topErrors.length
          ? 'Start from the most frequent error below.'
          : 'Check the failing service’s container on the server.',
      };
    }
    return {
      verdict: `*All Phoenix checks on ${e.host} report healthy right now*; the failure was too short to show in the sampled data.`,
      nextStep: 'If it keeps flapping, look at the error lines below around the alert time.',
    };
  }

  return {
    verdict: `Collected the host data for ${e.host} around the alert; nothing stands out as the cause.`,
    nextStep: 'Open the alert rule in Grafana for the exact condition.',
  };
}

/**
 * @param {Record<string, number>} byService
 * @returns {string}
 */
function topService(byService) {
  return Object.entries(byService).sort((a, b) => b[1] - a[1])[0]?.[0] || 'the busiest service';
}

/**
 * HH:MM in the configured time zone (the one the alerts are shown in).
 * @param {number} sec
 * @returns {string}
 */
export function clock(sec) {
  return new Date(sec * 1000).toLocaleTimeString('en-GB', {
    hour: '2-digit',
    minute: '2-digit',
    timeZone: config.timeZone,
  });
}
