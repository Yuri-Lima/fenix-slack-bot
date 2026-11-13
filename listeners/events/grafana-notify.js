import { config } from '../../config.js';
import { alertKind, clock, collectHostEvidence, diagnose, VERDICT_STATUS } from '../../integrations/host-health.js';
import { andMore } from '../../utils/helpers.js';
import { recordUsage, ruleBasedRun } from '../../utils/usage-store.js';

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
/** @param {number} n */
const compact = (n) => (n >= 1000 ? `${(n / 1000).toFixed(n >= 10_000 ? 0 : 1)}k` : String(n));

/**
 * Metric fields for the two-column grid. One emoji per kind of metric, always the same.
 * @param {import('../../integrations/host-health.js').HostEvidence} e
 * @param {import('../../integrations/host-health.js').AlertKind} kind
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

/** @typedef {import('@slack/types').KnownBlock} Block */

/** @param {string} text */
const context = (text) => /** @type {Block} */ ({ type: 'context', elements: [{ type: 'mrkdwn', text }] });
/** @param {string} text */
const section = (text) => /** @type {Block} */ ({ type: 'section', text: { type: 'mrkdwn', text } });

/** Bar colour for cards without a verdict (fleet-wide events, missing data). */
const NEUTRAL_COLOR = '#6E7681';

/** @typedef {{ color: string, blocks: Block[] }} Card */

/**
 * Build the analysis for one Grafana notification: one card per finding, each a
 * Slack attachment whose left bar shows the verdict status, plus a plain-text
 * fallback for notifications.
 * @param {ParsedAlert} alert
 * @param {Array<{ entry: AlertEntry, host: string, evidence: import('../../integrations/host-health.js').HostEvidence | null }>} analysed
 * @param {Map<string, { day: number, week: number }>} history
 * @param {{ elapsedMs?: number }} [run] - How long the analysis took, for the footer
 * @returns {{ text: string, attachments: Card[] } | null}
 */
export function formatGrafanaAnalysis(alert, analysed, history, run = {}) {
  const kind = alertKind(alert.rule);
  /** @type {Card[]} */
  const cards = [];
  /** @param {string} color */
  const newCard = (color) => {
    /** @type {Block[]} */
    const blocks = [];
    cards.push({ color, blocks });
    return blocks;
  };
  /** @type {string[]} */
  const summary = [];

  for (const entry of alert.entries.filter((e) => e.hosts.length >= FLEET_EVENT_MIN_HOSTS)) {
    const firing = entry.state === 'firing';
    const shown = entry.hosts
      .slice(0, 6)
      .map((h) => `\`${h}\``)
      .join(', ');
    const more = entry.hosts.length > 6 ? ` and ${entry.hosts.length - 6} more` : '';
    const title = `${entry.hosts.length} servers ${firing ? 'failing' : 'recovered'} at once`;
    const blocks = newCard(NEUTRAL_COLOR);
    blocks.push(
      { type: 'header', text: { type: 'plain_text', text: `:globe_with_meridians: ${title}`, emoji: true } },
      context(`*${alert.rule}*${entry.shownTime ? `  ·  :clock3: ${entry.shownTime}` : ''}`),
      section(
        firing
          ? `So many servers at the same moment points to *one shared cause*: the network, the monitoring stack, or a shared dependency.\n${shown}${more}`
          : `They recovered together, which confirms one shared cause.\n${shown}${more}`,
      ),
    );
    if (firing)
      blocks.push(section(':point_right: *Next step:* Check the shared cause first, not the individual servers.'));
    summary.push(`🌐 ${title}`);
  }

  for (const { entry, host, evidence } of analysed) {
    const seen = history.get(entry.hosts[0]);
    const repeat =
      seen && seen.week > 0
        ? `:repeat: ${ordinal(seen.day + 1)} time in 24 h · ${seen.week + 1}× in ${HISTORY_DAYS} days`
        : ':new: first time this week';
    const meta = `*${alert.rule}*  ·  :clock3: since ${entry.shownTime ?? '?'}  ·  ${repeat}`;
    if (!evidence) {
      newCard(NEUTRAL_COLOR).push(
        { type: 'header', text: { type: 'plain_text', text: `:grey_question: ${host} · no data`, emoji: true } },
        context(meta),
        section('Could not load metrics for this server from Grafana.'),
      );
      summary.push(`${host}: no data`);
      continue;
    }

    const v = diagnose(kind, evidence);
    const status = VERDICT_STATUS[v.status];
    const blocks = newCard(status.color);
    blocks.push(
      {
        type: 'header',
        text: { type: 'plain_text', text: `${status.emoji} ${host} · ${v.title}`.slice(0, 150), emoji: true },
      },
      context(meta),
      section(v.detail),
    );
    const fields = evidenceFields(evidence, kind);
    if (fields.length) {
      blocks.push({ type: 'section', fields: fields.slice(0, 10).map((text) => ({ type: 'mrkdwn', text })) });
    }
    const errors = evidence.logs?.topErrors.slice(0, 2) || [];
    if (errors.length) {
      blocks.push(
        section(
          `:warning: *Top errors*\n${errors.map((t) => `> ${t.count}× _${t.service}_  \`${t.pattern.replace(/`/g, "'").slice(0, 120)}\``).join('\n')}`,
        ),
      );
    }
    blocks.push(section(`:point_right: *Next step:* ${v.nextStep}`));
    summary.push(`${host}: ${v.title} (${status.label})`);
  }

  const notAnalysed = alert.entries.filter(
    (e) => e.state === 'firing' && e.hosts.length < FLEET_EVENT_MIN_HOSTS && !analysed.some((a) => a.entry === e),
  );
  // Trailing notes and the footer go at the bottom of the last card
  const last = cards.length ? cards[cards.length - 1].blocks : null;
  if (notAnalysed.length && last) {
    last.push(context(`Also firing: ${notAnalysed.map((e) => `\`${e.hosts[0]}\``).join(', ')}`));
  }

  // Recoveries are only worth a line next to something that is still firing
  const resolved = alert.entries.filter((e) => e.state === 'resolved' && e.hosts.length < FLEET_EVENT_MIN_HOSTS);
  if (resolved.length && last) {
    const lines = resolved.slice(0, 10).map((e) => {
      const mins = e.start && e.end ? Math.max(1, Math.round((e.end - e.start) / 60)) : null;
      return `:white_check_mark: \`${e.hosts[0]}\` recovered${e.shownTime ? ` at ${e.shownTime}` : ''}${mins ? ` after ${mins} min` : ''}`;
    });
    const more = andMore(resolved.length, 10, '');
    last.push(context([...lines, ...(more ? [more] : [])].join('\n')));
  }

  if (!last) return null;
  const took = run.elapsedMs !== undefined ? ` · ${(run.elapsedMs / 1000).toFixed(1)} s` : '';
  last.push(context(`:gear: Rule-based analysis of Grafana metrics and logs · no AI model, 0 tokens${took}`));
  return { text: `${alert.rule}: ${summary.join('; ')}`, attachments: cards };
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

  const startedAt = Date.now();
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

    const analysis = formatGrafanaAnalysis(alert, analysed, history, { elapsedMs: Date.now() - startedAt });
    if (!analysis) return;
    const { text, attachments } = analysis;

    if (replyMode === 'thread') {
      await client.chat.postMessage({
        channel: message.channel,
        thread_ts: message.ts,
        text,
        attachments,
        unfurl_links: false,
      });
    } else if (config.adminDmChannel) {
      const link = await client.chat
        .getPermalink({ channel: message.channel, message_ts: message.ts })
        .then((r) => r.permalink)
        .catch(() => null);
      const preview = context(`:eyes: Preview for <${link || '#'}|this Grafana alert>. Not posted in the channel.`);
      await client.chat.postMessage({
        channel: config.adminDmChannel,
        text,
        blocks: [preview],
        attachments,
        unfurl_links: false,
      });
    }
    void recordUsage(ruleBasedRun('grafana', alert.rule, startedAt));
  } catch (e) {
    logger.error(`Grafana alert analysis failed for "${alert.rule}": ${e}`);
  }
}
