// Review queue status rules, checked against a real GitHub response (test/fixtures/queue-apache-ozone.json,
// queried as peterxcli for apache/ozone pull requests in different states).
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {
  buildQueueQuery,
  computeStatuses,
  needsAttention,
  prKey,
  readQueueResult,
  toPRState
} from '../app/src/lib/status.ts';
import type {PRNode, PRRef, QueueQueryResult, Status} from '../app/src/lib/status.ts';

const fixture: {refs: PRRef[]; result: QueueQueryResult} = JSON.parse(
  readFileSync(new URL('./fixtures/queue-apache-ozone.json', import.meta.url), 'utf8')
);
const nodes = readQueueResult(fixture.refs, fixture.result);
const pr = (number: number) => nodes[fixture.refs.findIndex((ref) => ref.number === number)] as PRNode;
const keys = (statuses: Status[]) => statuses.map((status) => status.key);
const me = 'peterxcli';

test('builds one aliased query for several pull requests', () => {
  const query = buildQueueQuery([{repo: 'apache/ozone', number: 1}, {repo: 'o/r.js', number: 22}]);
  assert.match(query, /pr0: repository\(owner: "apache", name: "ozone"\) {\s+pullRequest\(number: 1\)/);
  assert.match(query, /pr1: repository\(owner: "o", name: "r\.js"\) {\s+pullRequest\(number: 22\)/);
  assert.match(query, /fragment QueuePR on PullRequest/);
});

test('reports pull requests GitHub could not return', () => {
  const missing = nodes[fixture.refs.findIndex((ref) => ref.number === 99999999)];
  assert.ok('error' in missing);
  const state = toPRState({repo: 'apache/ozone', number: 99999999}, missing, {me}, '2026-09-30T00:00:00Z');
  assert.match(state.error || '', /Could not resolve/);
  assert.deepEqual(state.statuses, []);
});

test('someone else\'s pull request: review requested, new commits, replies', () => {
  const statuses = computeStatuses(pr(11314), {me});
  assert.deepEqual(keys(statuses), ['review_requested', 'new_commits', 'replies', 'reviewed', 'checks_passing', 'ready']);

  const commits = statuses.find((s) => s.key === 'new_commits')!;
  assert.equal(commits.label, '2 new commits since your review');
  assert.equal(commits.attention, true);

  const replies = statuses.find((s) => s.key === 'replies')!;
  assert.deepEqual(replies.users, ['taklwu']);
  assert.equal(replies.label, 'Replies from @taklwu');
  assert.match(replies.url || '', /^https:\/\/github\.com\/apache\/ozone\/pull\/11314#discussion_r\d+$/);

  assert.equal(statuses.find((s) => s.key === 'reviewed')!.label, 'You commented');
});

test('a review on the latest commit has no new commits', () => {
  assert.deepEqual(keys(computeStatuses(pr(11321), {me})), ['reviewed', 'checks_passing', 'ready']);
});

test('own draft: mentioned, draft, yours; no review statuses on own pull requests', () => {
  const statuses = computeStatuses(pr(10183), {me});
  assert.deepEqual(keys(statuses), ['mentioned', 'checks_passing', 'draft', 'yours']);
  assert.equal(statuses[0].at, '2026-09-24T03:59:44Z');
});

test('merged and closed pull requests', () => {
  assert.deepEqual(keys(computeStatuses(pr(11325), {me})), ['mentioned', 'reviewed', 'merged']);
  assert.equal(computeStatuses(pr(11325), {me}).find((s) => s.key === 'reviewed')!.label, 'You approved');
  assert.deepEqual(keys(computeStatuses(pr(10765), {me})), ['closed']);
});

test('the handle is compared case-insensitively', () => {
  assert.deepEqual(keys(computeStatuses(pr(11314), {me: 'PeterXCLI'})), keys(computeStatuses(pr(11314), {me})));
});

test('replies and mentions older than the last visit do not need attention', () => {
  const seen = '2026-09-29T12:00:00Z';
  const statuses = computeStatuses(pr(11314), {me, lastSeenAt: seen});
  assert.equal(statuses.find((s) => s.key === 'replies')!.attention, false);
  assert.equal(computeStatuses(pr(10183), {me, lastSeenAt: seen}).find((s) => s.key === 'mentioned')!.attention, false);
  // Still listed, since each status is independent of the others
  assert.ok(keys(statuses).includes('replies'));
});

test('activity after the last visit is reported', () => {
  const node = pr(11321);
  assert.ok(!keys(computeStatuses(node, {me, lastSeenAt: node.updatedAt})).includes('updated'));
  const statuses = computeStatuses(node, {me, lastSeenAt: '2026-09-26T10:00:00Z'});
  assert.equal(statuses.find((s) => s.key === 'updated')!.attention, true);
});

test('attention is only counted for open pull requests', () => {
  const now = '2026-09-30T00:00:00Z';
  const state = (number: number) => toPRState({repo: 'apache/ozone', number}, pr(number), {me}, now);
  assert.equal(needsAttention(state(11314)), true);
  assert.equal(needsAttention(state(11321)), false);
  // Merged with an unseen mention: done, nothing to act on
  assert.equal(needsAttention(state(11325)), false);
});

test('cache keys ignore the case of the repository', () => {
  assert.equal(prKey({repo: 'Apache/Ozone', number: 7}), prKey({repo: 'apache/ozone', number: 7}));
});
