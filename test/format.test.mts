// Reading what users paste into the dashboard, and relative times.
import test from 'node:test';
import assert from 'node:assert/strict';
import {parsePullRequest, parseRepository, timeAgo} from '../app/src/dashboard/format.ts';

test('reads pull requests from links and short forms', () => {
  const pr = {repo: 'apache/ozone', number: 11302};
  assert.deepEqual(parsePullRequest('https://github.com/apache/ozone/pull/11302'), pr);
  assert.deepEqual(parsePullRequest('  https://github.com/apache/ozone/pull/11302/files#diff-abc  '), pr);
  assert.deepEqual(parsePullRequest('github.com/apache/ozone/pull/11302?w=1'), pr);
  assert.deepEqual(parsePullRequest('apache/ozone#11302'), pr);
  assert.deepEqual(parsePullRequest('apache/ozone/pull/11302'), pr);
  assert.deepEqual(parsePullRequest('https://github.com/o-1/r.js/pull/7#discussion_r12'), {repo: 'o-1/r.js', number: 7});
});

test('rejects what is not a pull request', () => {
  for (const input of [
    '',
    'apache/ozone',
    'https://github.com/apache/ozone/issues/1',
    'https://github.com/apache/ozone/pull/0',
    'https://gitlab.com/apache/ozone/pull/1',
    'apache/../ozone#1',
    'apache/..#1'
  ]) {
    assert.equal(parsePullRequest(input), null, input);
  }
});

test('reads repositories from links and names', () => {
  assert.equal(parseRepository('apache/ozone'), 'apache/ozone');
  assert.equal(parseRepository('https://github.com/apache/ozone'), 'apache/ozone');
  assert.equal(parseRepository('https://github.com/apache/ozone/tree/master/hadoop-ozone'), 'apache/ozone');
  assert.equal(parseRepository('https://github.com/peterxcli/treehub.git'), 'peterxcli/treehub');
  assert.equal(parseRepository('github.com/apache/ozone/'), 'apache/ozone');
  assert.equal(parseRepository('apache'), null);
  assert.equal(parseRepository('-bad/name'), null);
  assert.equal(parseRepository('owner/..'), null);
});

test('formats relative times', () => {
  const now = Date.parse('2026-09-30T12:00:00Z');
  assert.equal(timeAgo('2026-09-30T11:59:30Z', now), 'just now');
  assert.equal(timeAgo('2026-09-30T11:55:00Z', now), '5 minutes ago');
  assert.equal(timeAgo('2026-09-30T11:00:00Z', now), '1 hour ago');
  assert.equal(timeAgo('2026-09-27T12:00:00Z', now), '3 days ago');
  assert.match(timeAgo('2026-01-02T12:00:00Z', now), /^on /);
  assert.equal(timeAgo(undefined, now), '');
});

test('history is grouped by local day', async () => {
  const {dayLabel, groupByDay} = await import('../app/src/dashboard/format.ts');
  const now = new Date(2026, 8, 30, 15, 0).getTime(); // Sep 30, 2026 local time
  const at = (day: number, hour: number) => new Date(2026, 8, day, hour).toISOString();
  assert.equal(dayLabel(at(30, 1), now), 'Today');
  assert.equal(dayLabel(at(29, 23), now), 'Yesterday');
  assert.match(dayLabel(at(27, 12), now), /September 27/);
  assert.doesNotMatch(dayLabel(at(27, 12), now), /2026/);
  assert.match(dayLabel(new Date(2025, 11, 31).toISOString(), now), /2025/);

  const items = [at(30, 9), at(30, 8), at(29, 20), at(20, 10)];
  const groups = groupByDay(items, (item) => item, now);
  assert.deepEqual(groups.map((g) => [g.label.replace(/.*September 20.*/, 'Sep 20'), g.items.length]),
    [['Today', 2], ['Yesterday', 1], ['Sep 20', 1]]);
});
