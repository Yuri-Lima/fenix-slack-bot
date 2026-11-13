import { config } from '../../config.js';
import { alertKind, clock, collectHostEvidence, diagnose } from '../../integrations/host-health.js';
import { andMore } from '../../utils/helpers.js';

// Explains Grafana alerts posted by the Grafana Slack app. Each firing host gets
// an evidence-based verdict; resolved hosts get their duration; many hosts at
// once are reported as one fleet-wide event. replyMode 'dm' sends the analysis
// to the admin DM (preview), 'thread' replies under the alert.

/** Grafana's logs links start this long before the alert (verified on real alerts). */
const LOGS_LINK_LEAD_SEC = 10 * 60;
/** One line naming at least this many hosts is a fleet-wide event, not N separate problems. */
const FLEET_EVENT_MIN_HOSTS = 5;
/** Firing hosts analysed per message; the rest are listed. */
const MAX_ANALYSED_HOSTS = 3;
const HISTORY_DAYS = 7;

/**
 * @typedef {Object} AlertEntry
 * @property {'firing' | 'resolved'} state
 * @property {string[]} hosts
 * @property {string | null} shownTime - HH:MM as shown in the message
 * @property {number | null} start - Alert start, unix seconds (from the logs link)
 * @property {number | null} end - Recovery time for resolved entries, unix seconds
 * @property {Record<string, string>} labels - Alert labels from the silence link
 */

/**
 * @typedef {Object} ParsedAlert
 * @property {string} rule
 * @property {string | null} ruleUid
 * @property {string | null} ruleUrl
 * @property {AlertEntry[]} entries
 */

/** @param {string} s */
const decode = (s) => s.replace(/&gt;/g, '>').replace(/&lt;/g, '<').replace(/&amp;/g, '&');

/**
 * Time range of a Grafana Explore link, in unix seconds.
 * @param {string} url
 * @returns {{ from: number, to: number | null } | null}
 */
function exploreRange(url) {
  try {
    const panes = JSON.parse(new URL(url).searchParams.get('panes') || '{}');
    const range = Object.values(panes)[0]?.range;
    if (!range || !/^\d+$/.test(range.from)) return null;
    return { from: Number(range.from) / 1000, to: /^\d+$/.test(range.to) ? Number(range.to) / 1000 : null };
  } catch {
    return null;
  }
}

/**
 * Parse an alert notification from the Grafana Slack app.
 * @param {{ attachments?: Array<{ title?: string, title_link?: string, text?: string }> }} message
 * @returns {ParsedAlert | null}
 */
export function parseGrafanaAlert(message) {
  const att = message.attachments?.[0];
  if (!att?.title) return null;
  const rule = att.title.replace(/^:[a-z_]+:\s*/, '').replace(/\s+—\s+\d+ firing, \d+ resolved\s*$/, '');
  const ruleUid = /\/alerting\/grafana\/([^/]+)\/view/.exec(att.title_link || '')?.[1] || null;

  /** @type {AlertEntry[]} */
  const entries = [];
  /** @type {'firing' | 'resolved' | null} */
  let section = null;
  for (const raw of decode(att.text || '').split('\n')) {
    const line = raw.trim();
    if (/^\*Firing \(\d+\)\*/.test(line)) section = 'firing';
    else if (/^\*Resolved \(\d+\)\*/.test(line)) section = 'resolved';
    if (!section || !line.startsWith('>')) continue;

    const hosts = [...line.matchAll(/`([^`]+)`/g)].map((m) => m[1]);
    if (hosts.length === 0) continue;
    const shownTime = /· (?:since|recovered) (\d\d:\d\d)/.exec(line)?.[1] || null;
    const logsUrl = /<(https?:[^|>]*\/explore\?[^|>]*)\|/.exec(line)?.[1];
    const range = logsUrl ? exploreRange(logsUrl) : null;
    const silenceUrl = /<(https?:[^|>]*\/alerting\/silence\/new\?[^|>]*)\|/.exec(line)?.[1];
    /** @type {Record<string, string>} */
    const labels = {};
    if (silenceUrl) {
      for (const m of new URL(silenceUrl).searchParams.getAll('matcher')) {
        const i = m.indexOf('=');
        if (i > 0) labels[m.slice(0, i)] = m.slice(i + 1);
      }
    }
    entries.push({
      state: section,
      hosts: [...new Set(hosts)],
      shownTime,
      start: range ? range.from + LOGS_LINK_LEAD_SEC : null,
      end: section === 'resolved' ? (range?.to ?? null) : null,
      labels,
    });
  }
  return { rule, ruleUid, ruleUrl: att.title_link || null, entries };
}

/**
 * The server an alert entry is about (Uptime Kuma alerts name the monitor, not the Kuma host).
 * @param {AlertEntry} entry
 * @returns {string}
 */
export function targetHost(entry) {
  return entry.labels.monitor_name || entry.labels.server_name || entry.hosts[0].replace(/-health-exporter$/, '');
}

/**
 * How often the same rule fired for a host recently, from the channel history.
 * @param {import('@slack/web-api').WebClient} client
 * @param {string} channel
 * @param {string} rule
 * @param {string[]} hosts
 * @param {string} beforeTs - Count only alerts before this message
 * @returns {Promise<Map<string, { day: number, week: number }>>}
 */
async function recentFirings(client, channel, rule, hosts, beforeTs) {
  const counts = new Map(hosts.map((h) => [h, { day: 0, week: 0 }]));
  const now = Number(beforeTs);
  /** @type {string | undefined} */
  let cursor;
  let pages = 0;
  do {
    const page = await client.conversations.history({
      channel,
      latest: beforeTs,
      oldest: String(now - HISTORY_DAYS * 86400),
      limit: 200,
      cursor,
    });
    for (const m of page.messages || []) {
      if (m.bot_id !== config.grafana.botId) continue;
      const parsed = parseGrafanaAlert(/** @type {any} */ (m));
      if (parsed?.rule !== rule) continue;
      for (const e of parsed.entries) {
        if (e.state !== 'firing') continue;
        for (const h of e.hosts) {
          const c = counts.get(h);
          if (!c) continue;
          c.week++;
          if (now - Number(m.ts) < 86400) c.day++;
        }
      }
    }
    cursor = page.response_metadata?.next_cursor || undefined;
  } while (cursor && ++pages < 10);
  return counts;
}

/** @param {number} n */
const ordinal = (n) => {
  const suffixes = ['th', 'st', 'nd', 'rd'];
  const v = n % 100;
  return `${n}${suffixes[(v - 20) % 10] || suffixes[v] || suffixes[0]}`;
};
/** @param {number} share */
const pct = (share) => `${Math.round(share * 100)}%`;

/**
 * Evidence bullets for one host.
 * @param {import('../../integrations/host-health.js').HostEvidence} e
 * @param {import('../../integrations/host-health.js').AlertKind} kind
 * @returns {string[]}
 */
export function evidenceLines(e, kind) {
  const lines = [];
  const reachable = e.reachability.nodeUp !== false;
  if (reachable && e.cpu && e.cpus) {
    lines.push(
      `• CPU (${e.cpus} cores): user ${pct(e.cpu.user)} · system ${pct(e.cpu.system)} · disk wait ${pct(e.cpu.iowait)} · steal ${pct(e.cpu.steal)} · idle ${pct(e.cpu.idle)}`,
    );
  }
  if (reachable && e.load1) {
    lines.push(
      `• Load: peak ${e.load1.max.toFixed(1)} at ${clock(e.load1.at)} · processes up to ${e.procsRunningMax ?? '?'} running, ${e.procsBlockedMax ?? '?'} blocked`,
    );
  }
  if (reachable && e.memUsedPctMax !== null) {
    const swap = e.swap ? ` · swap ${Math.round(e.swap.startMb)} → ${Math.round(e.swap.endMb)} MB` : '';
    lines.push(
      `• Memory: up to ${Math.round(e.memUsedPctMax)}% used${swap} · disk busy up to ${Math.round(e.diskBusyPctMax ?? 0)}%`,
    );
  }
  const fullish = e.filesystems.filter((f) => kind === 'disk' || f.usedPct >= 80);
  for (const f of fullish.slice(0, 3)) {
    const growth =
      f.growthGbPerDay !== null ? `, ${f.growthGbPerDay >= 0 ? '+' : ''}${f.growthGbPerDay.toFixed(1)} GB/24 h` : '';
    lines.push(`• Disk \`${f.mount}\`: ${Math.round(f.usedPct)}% used${growth}`);
  }
  // Health values are stale when the exporter that reports them is down
  if (e.healthChecks.length && e.reachability.exporterUp !== false) {
    const down = e.healthChecks.filter((c) => c.minInWindow === 0);
    lines.push(
      down.length
        ? `• Phoenix checks: ${down.map((c) => `\`${c.check}\` ${c.now === 0 ? 'down' : 'recovered'}`).join(', ')}`
        : `• Phoenix checks: all ${e.healthChecks.length} healthy`,
    );
  }
  if (e.logs) {
    const total = Object.values(e.logs.byService).reduce((a, b) => a + b, 0);
    const services = Object.entries(e.logs.byService)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 3)
      .map(([s, n]) => `${s} ${n.toLocaleString('en')}`)
      .join(', ');
    lines.push(
      `• Logs: ${total.toLocaleString('en')} lines${services ? ` (${services})` : ''} · ${e.logs.errorCount} error lines`,
    );
    for (const t of e.logs.topErrors.slice(0, 2)) {
      lines.push(`   ↳ ${t.count}× _${t.service}_: \`${t.pattern.replace(/`/g, "'")}\``);
    }
  }
  return lines;
}

/**
 * Build the analysis message for one Grafana notification.
 * @param {ParsedAlert} alert
 * @param {Array<{ entry: AlertEntry, host: string, evidence: import('../../integrations/host-health.js').HostEvidence | null }>} analysed
 * @param {Map<string, { day: number, week: number }>} history
 * @returns {string | null}
 */
export function formatGrafanaAnalysis(alert, analysed, history) {
  const kind = alertKind(alert.rule);
  const lines = [`:mag: *${alert.rule}*`];

  for (const entry of alert.entries.filter((e) => e.hosts.length >= FLEET_EVENT_MIN_HOSTS)) {
    const shown = entry.hosts
      .slice(0, 6)
      .map((h) => `\`${h}\``)
      .join(', ');
    lines.push(
      '',
      `:globe_with_meridians: *${entry.hosts.length} hosts ${entry.state === 'firing' ? 'started' : 'recovered'} at once${entry.shownTime ? ` at ${entry.shownTime}` : ''}* (${shown}${entry.hosts.length > 6 ? `, +${entry.hosts.length - 6}` : ''}).`,
      entry.state === 'firing'
        ? 'So many servers failing together points to one central cause (network, the monitoring stack or a shared dependency), not separate server problems. Check that first.'
        : 'They recovered together, which confirms one shared cause.',
    );
  }

  for (const { entry, host, evidence } of analysed) {
    const seen = history.get(entry.hosts[0]);
    const repeat =
      seen && seen.week > 0
        ? ` · ${ordinal(seen.day + 1)} time in 24 h, ${seen.week + 1}× in ${HISTORY_DAYS} days`
        : ' · first time this week';
    lines.push('', `*${host}* · since ${entry.shownTime ?? '?'}${repeat}`);
    if (!evidence) {
      lines.push('_Could not load metrics for this host from Grafana._');
      continue;
    }
    const { verdict, nextStep } = diagnose(kind, evidence);
    lines.push(verdict, ...evidenceLines(evidence, kind), `*Next step:* ${nextStep}`);
  }

  const notAnalysed = alert.entries.filter(
    (e) => e.state === 'firing' && e.hosts.length < FLEET_EVENT_MIN_HOSTS && !analysed.some((a) => a.entry === e),
  );
  if (notAnalysed.length) {
    lines.push('', `Also firing: ${notAnalysed.map((e) => `\`${e.hosts[0]}\``).join(', ')}`);
  }

  // Recoveries are only worth a line next to something that is still firing
  const resolved = alert.entries.filter((e) => e.state === 'resolved' && e.hosts.length < FLEET_EVENT_MIN_HOSTS);
  if (resolved.length && lines.length > 1) {
    lines.push('');
    for (const e of resolved.slice(0, 10)) {
      const mins = e.start && e.end ? Math.max(1, Math.round((e.end - e.start) / 60)) : null;
      lines.push(
        `:white_check_mark: \`${e.hosts[0]}\` recovered${e.shownTime ? ` at ${e.shownTime}` : ''}${mins ? ` after ${mins} min` : ''}`,
      );
    }
    const more = andMore(resolved.length, 10);
    if (more) lines.push(more);
  }

  return lines.length > 1 ? lines.join('\n') : null;
}

/**
 * Analyse a Grafana alert message and post the explanation.
 * @param {import('@slack/bolt').AllMiddlewareArgs & import('@slack/bolt').SlackEventMiddlewareArgs<'message'>} args
 * @returns {Promise<void>}
 */
export async function handleGrafanaNotify({ client, event, logger }) {
  const { botId, replyMode } = config.grafana;
  const message = /** @type {any} */ (event);
  if (!botId || message.bot_id !== botId || replyMode === 'off') return;

  const alert = parseGrafanaAlert(message);
  if (!alert || alert.entries.length === 0) return;

  try {
    const firing = alert.entries
      .filter((e) => e.state === 'firing' && e.hosts.length < FLEET_EVENT_MIN_HOSTS)
      .slice(0, MAX_ANALYSED_HOSTS);
    const analysed = await Promise.all(
      firing.map(async (entry) => {
        const host = targetHost(entry);
        const evidence = await collectHostEvidence(host, {
          start: entry.start ?? Number(message.ts),
        }).catch((/** @type {any} */ e) => {
          logger.warn(`Grafana analysis: no evidence for ${host}: ${e.message}`);
          return null;
        });
        return { entry, host, evidence };
      }),
    );
    const history = await recentFirings(
      client,
      message.channel,
      alert.rule,
      firing.map((e) => e.hosts[0]),
      message.ts,
    ).catch(() => new Map());

    const text = formatGrafanaAnalysis(alert, analysed, history);
    if (!text) return;

    if (replyMode === 'thread') {
      await client.chat.postMessage({ channel: message.channel, thread_ts: message.ts, text, unfurl_links: false });
    } else if (config.adminDmChannel) {
      const link = await client.chat
        .getPermalink({ channel: message.channel, message_ts: message.ts })
        .then((r) => r.permalink)
        .catch(() => null);
      const header = `_Preview of the analysis for <${link || '#'}|this Grafana alert>. Not posted in the channel._\n`;
      await client.chat.postMessage({ channel: config.adminDmChannel, text: header + text, unfurl_links: false });
    }
  } catch (e) {
    logger.error(`Grafana alert analysis failed for "${alert.rule}": ${e}`);
  }
}
