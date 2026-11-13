import assert from 'node:assert';
import { describe, it } from 'node:test';
import { formatHostLogs, groupLogLines, resolveLogHost } from '../../integrations/host-logs.js';

const HOSTS = ['alpha', 'alpha-staging', 'beta', 'Gamma-01'];

/** Loki nanosecond timestamp for a unix second. */
const ns = (sec) => `${sec}000000000`;

describe('resolveLogHost', () => {
  it('prefers an exact match, ignoring case, and names the similar hosts', () => {
    assert.deepStrictEqual(resolveLogHost('ALPHA', HOSTS), { host: 'alpha', similar: ['alpha-staging'] });
  });

  it('ignores dashes and finds a host inside a longer alert name', () => {
    assert.deepStrictEqual(resolveLogHost('gamma01', HOSTS), { host: 'Gamma-01', similar: [] });
    assert.deepStrictEqual(resolveLogHost('host-E-beta', HOSTS), { host: 'beta', similar: [] });
  });

  it('lists the candidates when a partial name is ambiguous, and none when nothing matches', () => {
    assert.deepStrictEqual(resolveLogHost('alp', HOSTS), { candidates: ['alpha', 'alpha-staging'] });
    assert.deepStrictEqual(resolveLogHost('delta', HOSTS), { candidates: [] });
    assert.deepStrictEqual(resolveLogHost('--', HOSTS), { candidates: [] });
  });
});

describe('groupLogLines', () => {
  it('groups repeats per service, keeps the time span and the latest line, oldest group first', () => {
    const { read, groups } = groupLogLines([
      {
        stream: { service: 'worker' },
        values: [
          [ns(1060), 'job 42 done in 300 ms'],
          [ns(1000), 'job 41 done in 120 ms'],
          [ns(990), 'ERROR: connection refused to db:5432'],
        ],
      },
      { stream: { service: 'app' }, values: [[ns(1030), 'job 7 done in 5 ms']] },
    ]);
    assert.strictEqual(read, 4);
    assert.deepStrictEqual(
      groups.map((g) => [g.service, g.count, g.first, g.last, g.problem]),
      [
        ['worker', 1, 990, 990, true],
        ['worker', 2, 1000, 1060, false],
        ['app', 1, 1030, 1030, false],
      ],
    );
    assert.strictEqual(groups[1].sample, 'job 42 done in 300 ms');
  });
});

describe('formatHostLogs', () => {
  const logs = {
    host: 'alpha',
    start: 1000,
    end: 1300,
    byService: { worker: 1200, app: 30 },
    read: 500,
    groups: [
      { service: 'worker', sample: 'job done', count: 480, first: 1001, last: 1299, problem: false },
      { service: 'app', sample: 'upstream timed out', count: 20, first: 1100, last: 1100, problem: true },
    ],
  };

  it('states the window, totals per service and how much was read, then the timeline', () => {
    const text = formatHostLogs(logs, { problemsOnly: false });
    const [title, totals, ...timeline] = text.split('\n');
    assert.match(title, /^Logs of alpha, \d\d:\d\d–\d\d:\d\d \(UTC\), last 5 minutes:$/);
    assert.match(totals, /^1\.2k lines \(worker 1\.2k, app 30\)\. Only the newest 500 were read\. Repeats/);
    assert.match(timeline[0], /^480× \[worker\] \d\d:\d\d:\d\d–\d\d:\d\d:\d\d: job done$/);
    assert.match(timeline[1], /^20× \[app\] \d\d:\d\d:\d\d: upstream timed out$/);
  });

  it('names the filters and says when nothing matched', () => {
    const empty = { ...logs, byService: {}, read: 0, groups: [] };
    assert.strictEqual(
      formatHostLogs(empty, { service: 'app', search: 'timeout' }).split('\n')[1],
      'No matching log lines in this window.',
    );
    assert.match(
      formatHostLogs(empty, { service: 'app', search: 'timeout' }),
      /service app, lines containing "timeout"/,
    );
  });

  it('keeps problem lines when there are too many groups to show', () => {
    const many = Array.from({ length: 60 }, (_, i) => ({
      service: 'worker',
      sample: `line ${i}`,
      count: 100 - i,
      first: 1000 + i,
      last: 1000 + i,
      problem: false,
    }));
    many.push({ service: 'app', sample: 'FATAL crash', count: 1, first: 1290, last: 1290, problem: true });
    const text = formatHostLogs({ ...logs, groups: many });
    assert.match(text, /FATAL crash/);
    assert.match(text, /\(21 quieter groups without errors not shown\)$/);
  });
});
