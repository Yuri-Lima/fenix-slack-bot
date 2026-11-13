import { config } from '../config.js';
import { compact } from '../utils/helpers.js';
import { lokiInstant, lokiRange } from './grafana.js';
import { clip, clock, ERROR_LINE_RE, logPattern, q, re, readableLogLine } from './host-health.js';

// Recent logs of one server from Loki, condensed for the agent: the host name a person
// typed is resolved to a Loki `host`, repeated lines are grouped, and the result is a
// short timeline instead of raw log output.

/** Longest window someone can ask for. */
export const MAX_LOG_MINUTES = 180;
/** Newest lines read from Loki per request; the per-service totals cover the whole window. */
const MAX_LINES = 500;
/** Line groups shown to the agent; problem lines are kept first when there are more. */
const MAX_GROUPS = 40;
/** Characters per shown line. */
const MAX_LINE_CHARS = 250;
const PROBLEM_RE = new RegExp(ERROR_LINE_RE.replace('(?i)', ''), 'i');

/** Lower-case letters and digits only, so "WEB-01", "web01" and "host-E-web-01" can be compared. */
const norm = (/** @type {string} */ s) => s.toLowerCase().replace(/[^a-z0-9]/g, '');

/**
 * Match the name a person typed to a Loki host: an exact match (ignoring case) wins;
 * otherwise a single host whose name contains it, or is contained in it, is used.
 * @param {string} name
 * @param {string[]} hosts
 * @returns {{ host: string, similar: string[] } | { candidates: string[] }}
 */
export function resolveLogHost(name, hosts) {
  const wanted = norm(name);
  if (!wanted) return { candidates: [] };
  const related = hosts.filter((h) => {
    const n = norm(h);
    return n && (n.includes(wanted) || wanted.includes(n));
  });
  const exact = hosts.find((h) => norm(h) === wanted);
  if (exact) return { host: exact, similar: related.filter((h) => h !== exact) };
  if (related.length === 1) return { host: related[0], similar: [] };
  return { candidates: related };
}

/**
 * @typedef {Object} LogGroup
 * @property {string} service
 * @property {string} sample - Latest occurrence, readable
 * @property {number} count
 * @property {number} first - Unix seconds
 * @property {number} last - Unix seconds
 * @property {boolean} problem - Looks like an error, timeout, kill, ...
 */

/**
 * @typedef {Object} HostLogs
 * @property {string} host
 * @property {number} start
 * @property {number} end
 * @property {Record<string, number>} byService - Lines per service in the whole window
 * @property {number} read - Lines read and grouped (the newest, up to MAX_LINES)
 * @property {LogGroup[]} groups - Oldest first
 */

/**
 * Group log lines that differ only in numbers, ids and times.
 * @param {import('./grafana.js').LokiStream[]} streams
 * @returns {{ read: number, groups: LogGroup[] }}
 */
export function groupLogLines(streams) {
  /** @type {Map<string, LogGroup>} */
  const groups = new Map();
  let read = 0;
  for (const stream of streams) {
    const service = stream.stream.service || 'unknown';
    for (const [ns, line] of stream.values) {
      read++;
      const at = Number(ns) / 1e9;
      const sample = readableLogLine(line);
      const key = `${service}\n${logPattern(sample)}`;
      const g = groups.get(key);
      if (!g) {
        groups.set(key, { service, sample, count: 1, first: at, last: at, problem: PROBLEM_RE.test(sample) });
        continue;
      }
      g.count++;
      if (at < g.first) g.first = at;
      if (at >= g.last) {
        g.last = at;
        g.sample = sample;
      }
    }
  }
  return { read, groups: [...groups.values()].sort((a, b) => a.first - b.first) };
}

/**
 * Read one host's logs for the last `minutes`.
 * @param {string} host - Exact Loki host
 * @param {{ minutes: number, service?: string, search?: string, problemsOnly?: boolean }} options
 * @returns {Promise<HostLogs>}
 */
export async function readHostLogs(host, { minutes, service, search, problemsOnly = false }) {
  const end = Math.floor(Date.now() / 1000);
  const start = end - minutes * 60;
  const selector = `{host="${q(host)}"${service ? `, service="${q(service)}"` : ''}}`;
  const filters = [problemsOnly ? ` |~ "${q(ERROR_LINE_RE)}"` : '', search ? ` |~ "(?i)${re(search)}"` : ''].join('');
  const expr = `${selector}${filters}`;
  const [volume, streams] = await Promise.all([
    lokiInstant(`sum by (service) (count_over_time(${expr} [${minutes}m]))`, end),
    lokiRange(expr, start, end, MAX_LINES, 'backward'),
  ]);
  const byService = Object.fromEntries(
    volume.map((s) => [s.metric.service || 'unknown', Math.round(Number(s.value[1]))]),
  );
  return { host, start, end, byService, ...groupLogLines(streams) };
}

/**
 * The logs as compact text for the agent: totals, then one line per group in time order.
 * @param {HostLogs} logs
 * @param {{ service?: string, search?: string, problemsOnly?: boolean }} [filters]
 * @returns {string}
 */
export function formatHostLogs(logs, { service, search, problemsOnly } = {}) {
  const minutes = Math.round((logs.end - logs.start) / 60);
  const what = [
    service && `service ${service}`,
    problemsOnly && 'problem lines only',
    search && `lines containing "${search}"`,
  ].filter(Boolean);
  const total = Object.values(logs.byService).reduce((a, b) => a + b, 0);
  const lines = [
    `Logs of ${logs.host}, ${clock(logs.start)}–${clock(logs.end)} (${config.timeZone}), last ${minutes} minutes${
      what.length ? `, ${what.join(', ')}` : ''
    }:`,
  ];
  if (total === 0 && logs.read === 0) {
    lines.push('No matching log lines in this window.');
    return lines.join('\n');
  }
  const perService = Object.entries(logs.byService)
    .sort((a, b) => b[1] - a[1])
    .map(([s, n]) => `${s} ${compact(n)}`)
    .join(', ');
  lines.push(
    `${compact(total)} lines (${perService}).${
      total > logs.read ? ` Only the newest ${compact(logs.read)} were read.` : ''
    } Repeats are grouped as "count× [service] first–last: latest line".`,
  );

  let shown = logs.groups;
  if (shown.length > MAX_GROUPS) {
    const ranked = [...shown].sort((a, b) => Number(b.problem) - Number(a.problem) || b.count - a.count);
    const keep = new Set(ranked.slice(0, MAX_GROUPS));
    shown = shown.filter((g) => keep.has(g));
  }
  for (const g of shown) {
    const when =
      g.count > 1 && g.last - g.first >= 1
        ? `${clock(g.first, { seconds: true })}–${clock(g.last, { seconds: true })}`
        : clock(g.first, { seconds: true });
    lines.push(`${g.count}× [${g.service}] ${when}: ${clip(g.sample, MAX_LINE_CHARS)}`);
  }
  const hidden = logs.groups.length - shown.length;
  if (hidden > 0) lines.push(`(${hidden} quieter groups without errors not shown)`);
  return lines.join('\n');
}
