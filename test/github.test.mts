// Fetching the review queue from GitHub: batching, and resilience to queries GitHub fails to run.
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {fetchQueueStates} from '../app/src/lib/github.ts';
import {prKey, type PRNode, type PRRef, type QueueQueryResult} from '../app/src/lib/status.ts';

const fixture: {refs: PRRef[]; result: QueueQueryResult} = JSON.parse(
  readFileSync(new URL('./fixtures/queue-apache-ozone.json', import.meta.url), 'utf8')
);
const nodes = new Map<number, PRNode>();
fixture.refs.forEach((ref, index) => {
  const found = fixture.result.data && fixture.result.data[`pr${index}`];
  if (found && found.pullRequest) nodes.set(ref.number, found.pullRequest);
});

const TIMEOUT = 'Something went wrong while executing your query. This may be the result of a timeout.';

/**
 * Answers GraphQL requests from the fixture. `failing` numbers make any query that includes them fail the way
 * GitHub does on timeouts, and `status` replaces the whole response.
 */
function mockGitHub(options: {failing?: number[]; status?: number; body?: unknown} = {}) {
  const queries: number[][] = [];
  globalThis.fetch = (async (_url: string, init: {body: string}) => {
    const {query} = JSON.parse(init.body);
    const numbers = Array.from(query.matchAll(/pullRequest\(number: (\d+)\)/g), (m: RegExpMatchArray) => Number(m[1]));
    queries.push(numbers);
    if (options.status) return new Response(JSON.stringify(options.body), {status: options.status});
    if (numbers.some((n) => (options.failing || []).includes(n))) {
      return Response.json({data: null, errors: [{message: TIMEOUT}]});
    }
    const data = Object.fromEntries(numbers.map((n, index) => [`pr${index}`, {pullRequest: nodes.get(n) || null}]));
    return Response.json({data});
  }) as typeof fetch;
  return queries;
}

const entry = (number: number) => ({repo: 'apache/ozone', number, addedAt: '2026-09-29T00:00:00Z'});
const entries = [11314, 11321, 10183, 11325, 10765].map(entry);

test('fetches the queue in one aliased query and computes statuses for the handle', async () => {
  const queries = mockGitHub();
  const states = await fetchQueueStates('token', entries, 'peterxcli');
  assert.deepEqual(queries, [[11314, 11321, 10183, 11325, 10765]]);
  assert.equal(states[prKey(entry(11314))].statuses[0].key, 'review_requested');
  assert.equal(states[prKey(entry(10765))].state, 'closed');
});

test('a query GitHub fails to run is split until the failing pull request is alone', async () => {
  const queries = mockGitHub({failing: [10183]});
  const states = await fetchQueueStates('token', entries, 'peterxcli');
  assert.equal(states[prKey(entry(10183))].error, TIMEOUT);
  for (const number of [11314, 11321, 11325, 10765]) {
    assert.equal(states[prKey(entry(number))].error, undefined, `#${number}`);
    assert.ok(states[prKey(entry(number))].statuses.length, `#${number}`);
  }
  // 5 -> 3 + 2 -> (2 + 1) + 2
  assert.deepEqual(queries, [
    [11314, 11321, 10183, 11325, 10765],
    [11314, 11321, 10183],
    [11314, 11321],
    [10183],
    [11325, 10765]
  ]);
});

test('rate limits and rejected tokens stop the refresh instead of splitting', async () => {
  let queries = mockGitHub({status: 403, body: {message: 'API rate limit exceeded for user ID 1.'}});
  await assert.rejects(fetchQueueStates('token', entries, 'peterxcli'), /rate limit/);
  assert.equal(queries.length, 1);

  queries = mockGitHub({status: 401, body: {message: 'Bad credentials'}});
  await assert.rejects(fetchQueueStates('token', entries, 'peterxcli'), /sign in again/);
  assert.equal(queries.length, 1);
});
