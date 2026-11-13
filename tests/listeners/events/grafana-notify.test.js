import assert from 'node:assert';
import { describe, it } from 'node:test';

import { formatGrafanaAnalysis, parseGrafanaAlert, targetHost } from '../../../listeners/events/grafana-notify.js';

// Synthetic messages with the exact structure the Grafana Slack app posts.
const G = 'https://grafana.example.com';
const startMs = Date.parse('2026-11-12T07:25:00Z');
const panes = (fromMs, to) =>
  encodeURIComponent(JSON.stringify({ a: { datasource: 'loki', queries: [], range: { from: String(fromMs), to } } }));
const logsLink = (fromMs, to = 'now') => `<${G}/explore?schemaVersion=1&amp;panes=${panes(fromMs, to)}|:mag: logs>`;
const silence = (labels) =>
  `<${G}/alerting/silence/new?alertmanager=grafana&amp;${labels.map((l) => `matcher=${encodeURIComponent(l)}`).join('&amp;')}|silence>`;

const firingLoad = {
  bot_id: 'B0GRAFANA',
  attachments: [
    {
      title: ':rotating_light: High System Load Over All CPU Cores Together — 1 firing, 1 resolved',
      title_link: `${G}/alerting/grafana/rule123/view`,
      text: [
        '*Firing (1)* · nbg1',
        `&gt; \`alpha\` · since 08:25 · ${silence(['__alert_rule_uid__=rule123', 'instance=alpha', 'job=node'])} · ${logsLink(startMs - 10 * 60_000)}`,
        '',
        '*Resolved (1)*',
        `&gt; \`beta\` · recovered 08:20 · ${logsLink(startMs - 30 * 60_000, String(startMs - 5 * 60_000))}`,
        '',
        `<${G}/alerting/grafana/rule123/view?orgId=1|Open alert rule>`,
      ].join('\n'),
    },
  ],
};

const fleet = {
  attachments: [
    {
      title: ':rotating_light: Phoenix Docker Container Might be Frozen/Stuck — 7 firing, 0 resolved',
      text: [
        '*Firing (7)*',
        '&gt; `h1`, `h2`, `h3`, `h4`, `h5`, `h6`, `h7` · since 02:05 · silence them from the alert rule',
      ].join('\n'),
    },
  ],
};

const uptime = {
  attachments: [
    {
      title: ':rotating_light: Uptime Kuma - Monitor Down — 1 firing, 0 resolved',
      text: [
        '*Firing (1)*',
        `&gt; \`10.0.0.4:3001\` · since 08:52 · ${silence(['instance=10.0.0.4:3001', 'monitor_name=gamma', 'monitor_url=https://gamma.example.com'])} · ${logsLink(startMs)}`,
      ].join('\n'),
    },
  ],
};

describe('parseGrafanaAlert', () => {
  it('reads the rule, its uid, and firing and resolved entries', () => {
    const alert = parseGrafanaAlert(firingLoad);
    assert.strictEqual(alert.rule, 'High System Load Over All CPU Cores Together');
    assert.strictEqual(alert.ruleUid, 'rule123');
    assert.deepStrictEqual(
      alert.entries.map((e) => [e.state, e.hosts, e.shownTime]),
      [
        ['firing', ['alpha'], '08:25'],
        ['resolved', ['beta'], '08:20'],
      ],
    );
  });

  it('derives exact start and end times from the logs link (10 min lead-in)', () => {
    const [firing, resolved] = parseGrafanaAlert(firingLoad).entries;
    assert.strictEqual(firing.start, startMs / 1000);
    assert.strictEqual(firing.end, null);
    assert.strictEqual(resolved.start, (startMs - 20 * 60_000) / 1000);
    assert.strictEqual(resolved.end, (startMs - 5 * 60_000) / 1000);
  });

  it('reads alert labels from the silence link', () => {
    const [firing] = parseGrafanaAlert(firingLoad).entries;
    assert.deepStrictEqual(firing.labels, { __alert_rule_uid__: 'rule123', instance: 'alpha', job: 'node' });
  });

  it('keeps every host of a fleet-wide line in one entry', () => {
    const [entry] = parseGrafanaAlert(fleet).entries;
    assert.strictEqual(entry.hosts.length, 7);
    assert.strictEqual(entry.start, null);
  });

  it('ignores messages without an attachment title', () => {
    assert.strictEqual(parseGrafanaAlert({ text: 'hello' }), null);
  });
});

describe('targetHost', () => {
  it('uses the monitored site for Uptime Kuma alerts, not the Kuma host', () => {
    assert.strictEqual(targetHost(parseGrafanaAlert(uptime).entries[0]), 'gamma');
  });

  it('strips the health-exporter suffix', () => {
    assert.strictEqual(targetHost({ hosts: ['delta-health-exporter'], labels: {} }), 'delta');
  });
});

/** All visible text of a Block Kit message, for matching. */
const render = (out) =>
  out.blocks
    .map((b) =>
      [b.text?.text, ...(b.fields || []).map((f) => f.text), ...(b.elements || []).map((el) => el.text)]
        .filter(Boolean)
        .join('\n'),
    )
    .join('\n');

describe('formatGrafanaAnalysis', () => {
  const evidence = {
    host: 'alpha',
    from: 0,
    start: startMs / 1000,
    end: startMs / 1000 + 360,
    cpus: 2,
    load1: { max: 16.1, at: startMs / 1000 },
    cpu: { user: 0.11, system: 0.04, iowait: 0, steal: 0, idle: 0.83 },
    procsRunningMax: 6,
    procsBlockedMax: 0,
    memUsedPctMax: 58,
    swap: { startMb: 190, endMb: 190 },
    diskBusyPctMax: 0,
    filesystems: [],
    reachability: { nodeUp: true, nodeLastSeen: startMs / 1000 + 300, exporterUp: true },
    healthChecks: [{ check: 'worker', now: 1, minInWindow: 1 }],
    logs: { byService: { 'phoenix-worker': 6169 }, errorCount: 0, topErrors: [] },
  };

  it('explains a firing host with verdict, evidence, repeat count, and next step', () => {
    const alert = parseGrafanaAlert(firingLoad);
    const out = formatGrafanaAnalysis(
      alert,
      [{ entry: alert.entries[0], host: 'alpha', evidence }],
      new Map([['alpha', { day: 2, week: 11 }]]),
    );
    const header = out.blocks.find((b) => b.type === 'header');
    assert.strictEqual(header.text.text, ':large_green_circle: alpha · Not real CPU pressure');
    const text = render(out);
    assert.match(text, /since 08:25 {2}· {2}:repeat: 3rd time in 24 h · 12× in 7 days/);
    assert.match(text, /:brain: \*CPU\*\n17% busy of 2 cores/);
    assert.match(text, /:point_right: \*Next step:\*/);
    assert.match(text, /`beta` recovered at 08:20 after 15 min/);
    assert.match(out.text, /alpha: Not real CPU pressure \(False alarm\)/);
  });

  it('reports a fleet-wide event as one central cause', () => {
    const out = formatGrafanaAnalysis(parseGrafanaAlert(fleet), [], new Map());
    assert.strictEqual(out.blocks[0].text.text, ':globe_with_meridians: 7 servers failing at once');
    assert.match(render(out), /one shared cause/);
  });

  it('stays silent for messages that only report recoveries', () => {
    const onlyResolved = parseGrafanaAlert({
      attachments: [
        {
          title: ':white_check_mark: Database Health Checker — 0 firing, 1 resolved',
          text: `*Resolved (1)*\n&gt; \`beta\` · recovered 08:20 · ${logsLink(startMs, String(startMs + 60_000))}`,
        },
      ],
    });
    assert.strictEqual(formatGrafanaAnalysis(onlyResolved, [], new Map()), null);
  });
});
