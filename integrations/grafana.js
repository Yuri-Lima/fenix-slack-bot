import { baseUrl, config } from '../config.js';
import { createTokenReader } from '../utils/tokens.js';
import { httpRequest, requireConfigured } from './http.js';

const GRAFANA_BASE = baseUrl(config.grafana.url);
const { prometheusUid, lokiUid } = config.grafana;

// Read-only service account (Viewer role); Fenix only ever issues GET requests.
const getToken = createTokenReader('GRAFANA_TOKEN', '.grafana_token');

/**
 * GET a Grafana API path and parse the JSON body.
 * @param {string} path - Path under the Grafana base URL, starting with `/`
 * @returns {Promise<any>}
 */
async function grafanaGet(path) {
  const token = getToken();
  requireConfigured('Grafana', { base: GRAFANA_BASE, token, configHint: 'grafana.url' });
  const res = await httpRequest('Grafana', `${GRAFANA_BASE}${path}`, {
    headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
  });
  return res.json();
}

/** @typedef {{ metric: Record<string, string>, value: [number, string] }} PromSample */
/** @typedef {{ metric: Record<string, string>, values: Array<[number, string]> }} PromSeries */

/**
 * Instant PromQL query.
 * @param {string} expr
 * @param {number} [atSec] - Evaluation time (unix seconds); defaults to now
 * @returns {Promise<PromSample[]>}
 */
export async function promQuery(expr, atSec) {
  const params = new URLSearchParams({ query: expr });
  if (atSec) params.set('time', String(atSec));
  const body = await grafanaGet(`/api/datasources/proxy/uid/${prometheusUid}/api/v1/query?${params}`);
  return body.data?.result || [];
}

/**
 * Range PromQL query.
 * @param {string} expr
 * @param {number} startSec
 * @param {number} endSec
 * @param {number} stepSec
 * @returns {Promise<PromSeries[]>}
 */
export async function promRange(expr, startSec, endSec, stepSec) {
  const params = new URLSearchParams({
    query: expr,
    start: String(startSec),
    end: String(endSec),
    step: String(stepSec),
  });
  const body = await grafanaGet(`/api/datasources/proxy/uid/${prometheusUid}/api/v1/query_range?${params}`);
  return body.data?.result || [];
}

/** @typedef {{ stream: Record<string, string>, values: Array<[string, string]> }} LokiStream */

/**
 * Loki log query over a time range. With a limit, `forward` returns the oldest lines and
 * `backward` the newest; each stream's lines come in that order.
 * @param {string} expr - LogQL selector/pipeline
 * @param {number} startSec
 * @param {number} endSec
 * @param {number} limit
 * @param {'forward' | 'backward'} [direction]
 * @returns {Promise<LokiStream[]>}
 */
export async function lokiRange(expr, startSec, endSec, limit, direction = 'forward') {
  const params = new URLSearchParams({
    query: expr,
    start: `${Math.floor(startSec)}000000000`,
    end: `${Math.floor(endSec)}000000000`,
    limit: String(limit),
    direction,
  });
  const body = await grafanaGet(`/api/datasources/proxy/uid/${lokiUid}/loki/api/v1/query_range?${params}`);
  return body.data?.result || [];
}

/**
 * Loki metric query (e.g. `sum by (service) (count_over_time(...))`) evaluated at one instant.
 * @param {string} expr
 * @param {number} atSec
 * @returns {Promise<PromSample[]>}
 */
export async function lokiInstant(expr, atSec) {
  const params = new URLSearchParams({ query: expr, time: `${Math.floor(atSec)}000000000` });
  const body = await grafanaGet(`/api/datasources/proxy/uid/${lokiUid}/loki/api/v1/query?${params}`);
  return body.data?.result || [];
}

/**
 * Values of a Loki label (e.g. every `host` that sent logs) within a time range.
 * @param {string} label
 * @param {number} startSec
 * @param {number} endSec
 * @returns {Promise<string[]>}
 */
export async function lokiLabelValues(label, startSec, endSec) {
  const params = new URLSearchParams({
    start: `${Math.floor(startSec)}000000000`,
    end: `${Math.floor(endSec)}000000000`,
  });
  const body = await grafanaGet(
    `/api/datasources/proxy/uid/${lokiUid}/loki/api/v1/label/${encodeURIComponent(label)}/values?${params}`,
  );
  return body.data || [];
}

/**
 * Link to an alert rule in Grafana.
 * @param {string} ruleUid
 * @returns {string}
 */
export function alertRuleUrl(ruleUid) {
  return `${GRAFANA_BASE}/alerting/grafana/${ruleUid}/view`;
}
