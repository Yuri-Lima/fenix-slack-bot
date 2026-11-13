import { config } from '../config.js';
import { compact } from '../utils/helpers.js';
import { lokiInstant, lokiLabelValues, lokiRange, promQuery, promRange } from './grafana.js';

// Evidence about one host over a time window, gathered from Prometheus
// (node_exporter, Phoenix health exporter) and Loki, plus the diagnosis that
// turns it into a plain-language verdict. Every query may fail on its own;
// missing evidence is reported as unknown rather than failing the analysis.

/** Seconds of context collected before an alert started. */
export const LEAD_IN_SEC = 15 * 60;
/** LogQL regex for lines that report a problem. */
export const ERROR_LINE_RE = '(?i)(error|exception|fatal|panic|killed|oom|timeout|refused|unreachable)';
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
export const q = (value) => value.replace(/\\/g, '\\\\').replace(/"/g, '\\"');

/**
 * Escape a host name for use inside a regex label matcher.
 * @param {string} value
 * @returns {string}
 */
export const re = (value) => q(value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));

/**
 * The configured name part that excludes a host from analysis (`grafana.ignoreHosts`, case-insensitive),
 * e.g. "test" for test servers, or null when the host is analysed.
 * @param {string} host
 * @returns {string | null}
 */
export function ignoredBy(host) {
  const name = host.toLowerCase();
  return config.grafana.ignoreHosts.find((part) => part && name.includes(String(part).toLowerCase())) ?? null;
}

/**
 * Tool answer for an excluded host: short, so the model spends no tokens on it.
 * @param {string} host
 * @returns {string}
 */
export function ignoredHostMessage(host) {
  return `${host} is not analysed: server names containing "${ignoredBy(host)}" are excluded (test servers). Tell the user.`;
}

/** Hosts that sent logs within this window can be found by name. */
const HOST_LOOKBACK_SEC = 24 * 60 * 60;
const HOSTS_TTL_MS = 10 * 60 * 1000;
/** @type {{ at: number, hosts: string[] } | null} */
let hostsCache = null;

/**
 * Every host that sent logs in the last day (Loki `host` label), cached for ten minutes.
 * @returns {Promise<string[]>}
 */
export async function logHosts() {
  if (hostsCache && Date.now() - hostsCache.at < HOSTS_TTL_MS) return hostsCache.hosts;
  const now = Math.floor(Date.now() / 1000);
  const hosts = await lokiLabelValues('host', now - HOST_LOOKBACK_SEC, now);
  hostsCache = { at: Date.now(), hosts };
  return hosts;
}

/**
 * The Loki `host` for a host named in an alert or metric: the same name, ignoring case.
 * Exact on purpose: a prefix would also pull in hosts like `<name>-staging`.
 * Falls back to the name itself when the host list cannot be read.
 * @param {string} host
 * @returns {Promise<string>}
 */
export async function lokiHostFor(host) {
  const hosts = await logHosts().catch(() => []);
  return hosts.find((h) => h.toLowerCase() === host.toLowerCase()) ?? host;
}

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

/** Longest log line kept as a sample; display code shortens it further. */
const MAX_SAMPLE_CHARS = 1000;

/**
 * A log line as people should read it: no colour codes, no leading timestamp or nginx
 * worker ids, no client IP, no secrets, and health-check JSON without the components that
 * are up, so the failing part comes first.
 * @param {string} line
 * @returns {string}
 */
export function readableLogLine(line) {
  return (
    line
      // biome-ignore lint/suspicious/noControlCharactersInRegex: strips ANSI color codes, which start with ESC (\x1b)
      .replace(/\x1b\[[0-9;]*m/g, '')
      // Leading timestamps: ISO, nginx (2026/11/13 17:38:24), Phoenix (11/13/26, 3:47 P11 -)
      .replace(/^\s*\d{4}-\d\d-\d\d[T ][\d:.,]+Z?\s*/, '')
      .replace(/^\s*\d{4}\/\d\d\/\d\d \d\d:\d\d:\d\d\s*/, '')
      .replace(/^\s*\d\d?\/\d\d?\/\d\d(\d\d)?,? \d\d?:\d\d(:\d\d)?(\s+[A-Z]\w*)?\s*-?\s*/, '')
      // nginx "37#37: *954 " worker/connection ids and the client address
      .replace(/\b\d+#\d+: (\*\d+ )?/, '')
      .replace(/,? client: [^,]+,/, ',')
      // Secrets: key=value / "key":"value" pairs, bearer tokens, passwords in URLs
      .replace(
        /\b(password|passwd|pwd|secret|token|api[_-]?key|authorization)(["']?\s*[:=]\s*["']?)(?:Bearer\s+)?[^\s"',;&]+/gi,
        '$1$2[redacted]',
      )
      .replace(/\bBearer\s+[\w.~+/-]+=*/g, 'Bearer [redacted]')
      .replace(/(\b[a-z][\w+.-]*:\/\/[^:/\s@]+:)[^@/\s]+@/gi, '$1[redacted]@')
      // Health-check JSON: drop the components that are fine
      .replace(/"[\w-]+":\{"status":"up"\},?/g, '')
      .replace(/,\}/g, '}')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, MAX_SAMPLE_CHARS)
  );
}

/**
 * Collapse a log line into a pattern so repeats group together.
 * @param {string} line
 * @returns {string}
 */
export function logPattern(line) {
  return readableLogLine(line)
    .replace(/\d{4}-\d\d-\d\d[T ][\d:.,]+Z?/g, '<time>')
    .replace(/\b[0-9a-f]{8,}\b/gi, '<id>')
    .replace(/\b\d+(\.\d+)*\b/g, '<n>')
    .slice(0, 160);
}

/**
 * Shorten text for display at a word boundary, marking the cut with "…".
 * @param {string} text
 * @param {number} max
 * @returns {string}
 */
export function clip(text, max) {
  if (text.length <= max) return text;
  const cut = text.slice(0, max - 1);
  const space = cut.lastIndexOf(' ');
  return `${space > max * 0.6 ? cut.slice(0, space) : cut}…`;
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
 * @property {{ byService: Record<string, number>, errorCount: number, topErrors: Array<{ pattern: string, sample: string, count: number, service: string }> } | null} logs
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
  const L = q(await lokiHostFor(host));
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
    settle(lokiInstant(`sum by (service) (count_over_time({host="${L}"}[${windowSec}s]))`, to)),
    settle(lokiRange(`{host="${L}"} |~ "${q(ERROR_LINE_RE)}"`, from, to, MAX_ERROR_LINES)),
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
        const sample = readableLogLine(line);
        const pattern = logPattern(sample);
        const g = groups.get(pattern) || { pattern, sample, count: 0, service: stream.stream.service || 'unknown' };
        g.sample = sample; // lines come oldest first, so this keeps the latest occurrence
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
 * How urgent a verdict is. One emoji and one bar colour per status, used the same way everywhere.
 * @type {Record<'down' | 'action' | 'watch' | 'false-alarm', { emoji: string, label: string, color: string }>}
 */
export const VERDICT_STATUS = {
  down: { emoji: ':red_circle:', label: 'Down', color: '#D63232' },
  action: { emoji: ':large_orange_circle:', label: 'Needs action', color: '#F2994A' },
  watch: { emoji: ':large_yellow_circle:', label: 'Worth a look', color: '#F2C94C' },
  'false-alarm': { emoji: ':large_green_circle:', label: 'False alarm', color: '#2EB67D' },
};

/**
 * @typedef {Object} Verdict
 * @property {keyof typeof VERDICT_STATUS} status
 * @property {string} title - A few words, e.g. "Not real CPU pressure"
 * @property {string} detail - One or two plain sentences with the key numbers
 * @property {string} nextStep
 */

/**
 * When a server last sent host metrics within the past `days`, or null if it never did
 * (an unknown name, or gone for longer).
 * @param {string} host
 * @param {number} days
 * @returns {Promise<number | null>} unix seconds
 */
export async function lastSeenWithin(host, days) {
  const res = await settle(promQuery(`max_over_time(timestamp(node_load1{instance="${q(host)}"})[${days}d:5m])`));
  return res?.[0] ? Number(res[0].value[1]) : null;
}

/** Above these, a value is worth reporting in an on-demand check (alerts already decided that for themselves). */
const NOTABLE = { loadPerCpu: 1, memUsedPct: 85, swapGrowthMb: 100, diskUsedPct: 80, diskDaysToFull: 14 };

/**
 * Which verdict kinds are worth reporting when nobody asked about a specific
 * alert, e.g. "how is web-01 doing?". An unreachable server is always notable.
 * @param {HostEvidence} e
 * @returns {AlertKind[]}
 */
export function notableKinds(e) {
  if (e.reachability.nodeUp === false) return ['health'];
  /** @type {AlertKind[]} */
  const kinds = [];
  if (e.load1 && e.cpus && e.load1.max / e.cpus > NOTABLE.loadPerCpu) kinds.push('load');
  const swapGrowth = e.swap ? e.swap.endMb - e.swap.startMb : 0;
  if ((e.memUsedPctMax ?? 0) >= NOTABLE.memUsedPct || swapGrowth > NOTABLE.swapGrowthMb) kinds.push('memory');
  if (
    e.filesystems.some(
      (f) => f.usedPct >= NOTABLE.diskUsedPct || (f.daysToFull !== null && f.daysToFull < NOTABLE.diskDaysToFull),
    )
  ) {
    kinds.push('disk');
  }
  if (e.healthChecks.some((c) => c.minInWindow === 0) || e.reachability.exporterUp === false) kinds.push('health');
  return kinds;
}

/** Where to look when Phoenix's database connection pool is full. */
const POOL_FULL_CHECK = 'look for long-running queries or locks in Postgres (pg_stat_activity)';

/**
 * The most frequent logged error that shows something waiting (pool exhausted, timeout, ...),
 * with the sentence every verdict uses for it. Matches the full sample, since a pattern can be
 * cut before the cause.
 * @param {HostEvidence} e
 * @returns {{ cause: string, poolFull: boolean, because: string } | null}
 */
function waitCause(e) {
  const waitingOn = e.logs?.topErrors.find((t) => WAIT_CAUSE_RE.test(t.sample));
  const cause = waitingOn && WAIT_CAUSE_RE.exec(waitingOn.sample)?.[0].toLowerCase();
  if (!waitingOn || !cause) return null;
  return {
    cause,
    poolFull: cause === 'pool exhausted',
    because: `${waitingOn.service} logged ${waitingOn.count}× "${cause}" at the same time`,
  };
}

/**
 * Plain-language verdict for an alert, from the evidence.
 * @param {AlertKind} kind
 * @param {HostEvidence} e
 * @returns {Verdict}
 */
export function diagnose(kind, e) {
  if (e.reachability.nodeUp === false) {
    const lastSeen = e.reachability.nodeLastSeen ? ` since ${clock(e.reachability.nodeLastSeen)}` : '';
    const exporter = e.reachability.exporterUp === false ? ' The Phoenix health exporter is down too.' : '';
    return {
      status: 'down',
      title: 'Server unreachable',
      detail: `No host metrics from ${e.host}${lastSeen}.${exporter} The whole machine or its network is down, not a single service.`,
      nextStep: 'Check the server in the Hetzner console (power, network, disk full) before looking at Phoenix.',
    };
  }

  if (kind === 'machine' && e.reachability.nodeUp) {
    return {
      status: 'watch',
      title: 'Heartbeat missing, server is up',
      detail: `Host metrics from ${e.host} keep arriving; only the heartbeat signal stopped.`,
      nextStep: 'Check the heartbeat agent on the server. Nothing else needs attention.',
    };
  }

  if (kind === 'load' && e.load1 && e.cpus && e.cpu) {
    const load = `Load ${e.load1.max.toFixed(1)} on ${e.cpus} CPUs (${Math.round((e.load1.max / e.cpus) * 100)}%)`;
    const busy = 1 - e.cpu.idle;
    if (e.cpu.steal > 0.2) {
      return {
        status: 'watch',
        title: 'Hetzner host contention',
        detail: `${load}, with ${pct(e.cpu.steal)} of CPU time taken by the hypervisor.`,
        nextStep: 'Nothing to fix on this server. If it repeats, move it to a dedicated-vCPU plan.',
      };
    }
    if (e.cpu.iowait > 0.2 || (e.diskBusyPctMax ?? 0) > 80) {
      return {
        status: 'action',
        title: 'Waiting on disk',
        detail: `${load}; the CPU waited on disk ${pct(e.cpu.iowait)} of the time (disk busy up to ${Math.round(e.diskBusyPctMax ?? 0)}%).`,
        nextStep: 'Look for heavy disk work at that time: backups, database dumps or vacuum, log bursts.',
      };
    }
    if (busy < 0.5) {
      const wait = waitCause(e);
      return {
        status: 'false-alarm',
        title: 'Not real CPU pressure',
        detail: `${load}, but the CPU was ${pct(e.cpu.idle)} idle. Tasks were waiting, not computing${
          wait ? `; ${wait.because}, the likely reason` : ''
        }.`,
        nextStep: wait
          ? `Look into the "${wait.cause}" errors below. The rule itself would be quieter if it measured CPU use instead of load average.`
          : 'Change the rule to measure CPU use instead of load average; that removes this false alarm.',
      };
    }
    return {
      status: 'action',
      title: 'CPU saturated',
      detail: `${load}; the CPU was ${pct(busy)} busy (user ${pct(e.cpu.user)}, system ${pct(e.cpu.system)}).`,
      nextStep: e.logs?.byService
        ? `Check what ${topService(e.logs.byService)} was doing at ${clock(e.load1.at)}. If it repeats, the server needs more CPUs.`
        : 'Find the busy process on the server. If it repeats, the server needs more CPUs.',
    };
  }

  if (kind === 'memory' && e.memUsedPctMax !== null) {
    const swapGrew = e.swap && e.swap.endMb - e.swap.startMb > 100;
    return {
      status: swapGrew ? 'action' : 'watch',
      title: swapGrew ? 'Running out of memory' : 'Memory peak',
      detail: `Up to ${Math.round(e.memUsedPctMax)}% memory used${
        e.swap ? `, swap ${Math.round(e.swap.startMb)} → ${Math.round(e.swap.endMb)} MB` : ''
      }.${swapGrew ? ' Swap is growing, so this is a real shortage, not caching.' : ''}`,
      nextStep: swapGrew
        ? 'Restart or limit the service using the most memory. If it repeats, add RAM.'
        : 'Check whether it drops on its own; one-off peaks usually come from a large import or report.',
    };
  }

  if (kind === 'disk' && e.filesystems.length) {
    const worst = [...e.filesystems].sort((a, b) => b.usedPct - a.usedPct)[0];
    const soon = worst.daysToFull !== null && worst.daysToFull < 7;
    const growth =
      worst.growthGbPerDay !== null
        ? `, ${worst.growthGbPerDay >= 0 ? '+' : ''}${worst.growthGbPerDay.toFixed(1)} GB in 24 h`
        : '';
    const eta = worst.daysToFull !== null ? ` Full in about ${Math.max(1, Math.round(worst.daysToFull))} days.` : '';
    return {
      status: soon ? 'action' : 'watch',
      title: 'Disk filling up',
      detail: `\`${worst.mount}\` is ${Math.round(worst.usedPct)}% used${growth}.${eta}`,
      nextStep: 'Clean up old Docker images and volumes, logs and backups, or enlarge the volume.',
    };
  }

  if (kind === 'exporter' && e.reachability.nodeUp && e.reachability.exporterUp === false) {
    // The exporter asks Phoenix for its health; when Phoenix hangs, the exporter times out with it
    const wait = waitCause(e);
    if (wait) {
      return {
        status: 'action',
        title: wait.poolFull ? 'Database connection pool full, server is up' : 'Phoenix not answering, server is up',
        detail: `Host metrics from ${e.host} still arrive, but Phoenix stopped answering health checks; ${wait.because}.`,
        nextStep: wait.poolFull
          ? `First ${POOL_FULL_CHECK}. If it does not recover, restart phoenix-app.`
          : `Look into the "${wait.cause}" errors below before restarting the health exporter; it only reports what Phoenix answers.`,
      };
    }
    return {
      status: 'watch',
      title: 'Health exporter stuck, server is up',
      detail: `Host metrics from ${e.host} still arrive, but the Phoenix health exporter stopped answering.`,
      nextStep: 'Restart the health-exporter container. Phoenix itself may be fine.',
    };
  }

  if ((kind === 'health' || kind === 'exporter') && e.healthChecks.length) {
    const down = e.healthChecks.filter((c) => c.minInWindow === 0);
    if (down.length) {
      const stillDown = down.filter((c) => c.now === 0);
      const names = down.map((c) => `\`${c.check}\``).join(', ');
      const wait = waitCause(e);
      const poolTitle = stillDown.length
        ? 'Database connection pool full'
        : 'Database connection pool was full, recovered';
      return {
        status: stillDown.length ? 'action' : 'watch',
        title: wait?.poolFull ? poolTitle : stillDown.length ? 'Phoenix checks failing' : 'Phoenix checks recovered',
        detail: `${names} went down${
          stillDown.length
            ? stillDown.length === down.length
              ? ' and are still down'
              : `; still down: ${stillDown.map((c) => `\`${c.check}\``).join(', ')}`
            : ' and recovered'
        }. The server itself is up.${wait ? ` Likely cause: ${wait.because}.` : ''}`,
        nextStep: wait?.poolFull
          ? stillDown.length
            ? `First ${POOL_FULL_CHECK}. If it does not recover, restart phoenix-app.`
            : `It recovered on its own. If it repeats, ${POOL_FULL_CHECK} around the alert time.`
          : wait
            ? `Start from the "${wait.cause}" errors below.`
            : e.logs?.topErrors.length
              ? 'Start from the most frequent error below.'
              : "Check the failing service's container on the server.",
      };
    }
    return {
      status: 'watch',
      title: 'Short blip',
      detail: `All Phoenix checks on ${e.host} are healthy; the failure was too short to show in the sampled data.`,
      nextStep: 'If it keeps flapping, look at the errors below around the alert time.',
    };
  }

  return {
    status: 'watch',
    title: 'No clear cause',
    detail: `Nothing in ${e.host}'s metrics or logs stands out around the alert.`,
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
 * HH:MM (or HH:MM:SS) in the configured time zone (the one the alerts are shown in).
 * @param {number} sec
 * @param {{ seconds?: boolean }} [options]
 * @returns {string}
 */
export function clock(sec, { seconds = false } = {}) {
  return new Date(sec * 1000).toLocaleTimeString('en-GB', {
    hour: '2-digit',
    minute: '2-digit',
    ...(seconds && { second: '2-digit' }),
    timeZone: config.timeZone,
  });
}

/**
 * Metric fields for the two-column grid. One emoji per kind of metric, always the same.
 * @param {HostEvidence} e
 * @param {AlertKind} kind
 * @returns {string[]} mrkdwn field texts
 */
export function evidenceFields(e, kind) {
  const fields = [];
  const reachable = e.reachability.nodeUp !== false;
  if (!reachable) {
    fields.push(
      `:electric_plug: *Last seen*\n${e.reachability.nodeLastSeen ? clock(e.reachability.nodeLastSeen) : 'not in this window'}`,
    );
  }
  if (reachable && e.cpu && e.cpus) {
    const extra = [
      e.cpu.iowait >= 0.05 && `disk wait ${pct(e.cpu.iowait)}`,
      e.cpu.steal >= 0.05 && `steal ${pct(e.cpu.steal)}`,
    ]
      .filter(Boolean)
      .join(' · ');
    fields.push(`:brain: *CPU*\n${pct(1 - e.cpu.idle)} busy of ${e.cpus} cores${extra ? ` · ${extra}` : ''}`);
  }
  if (reachable && e.load1) {
    fields.push(
      `:chart_with_upwards_trend: *Load*\npeak ${e.load1.max.toFixed(1)} at ${clock(e.load1.at)} · ${e.procsRunningMax ?? '?'} running`,
    );
  }
  if (reachable && e.memUsedPctMax !== null) {
    const swapDelta = e.swap ? Math.round(e.swap.endMb - e.swap.startMb) : null;
    const swap =
      swapDelta === null
        ? ''
        : ` · swap ${Math.abs(swapDelta) < 20 ? 'flat' : `${swapDelta > 0 ? '+' : ''}${swapDelta} MB`}`;
    fields.push(`:floppy_disk: *Memory*\n${Math.round(e.memUsedPctMax)}% used${swap}`);
  }
  if (reachable && (e.diskBusyPctMax !== null || e.filesystems.length)) {
    const fullest = [...e.filesystems].sort((a, b) => b.usedPct - a.usedPct)[0];
    const parts = [
      e.diskBusyPctMax !== null && `busy ${Math.round(e.diskBusyPctMax)}%`,
      fullest &&
        (kind === 'disk' || fullest.usedPct >= 80 ? `\`${fullest.mount}\` ${Math.round(fullest.usedPct)}% full` : null),
    ].filter(Boolean);
    if (parts.length) fields.push(`:minidisc: *Disk*\n${parts.join(' · ')}`);
  }
  // Health values are stale when the exporter that reports them is down
  if (e.healthChecks.length && e.reachability.exporterUp !== false) {
    const down = e.healthChecks.filter((c) => c.minInWindow === 0);
    fields.push(
      `:stethoscope: *Phoenix checks*\n${
        down.length
          ? down.map((c) => `\`${c.check}\` ${c.now === 0 ? 'down' : 'recovered'}`).join(', ')
          : `all ${e.healthChecks.length} healthy`
      }`,
    );
  } else if (e.reachability.exporterUp === false) {
    fields.push(':stethoscope: *Phoenix checks*\nexporter not answering');
  }
  if (e.logs) {
    const total = Object.values(e.logs.byService).reduce((a, b) => a + b, 0);
    fields.push(`:scroll: *Logs*\n${compact(total)} lines · ${e.logs.errorCount} errors`);
  }
  return fields;
}
