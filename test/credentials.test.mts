// Explanations of refused requests (401, 403 and telling 404s) for the credential popups.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  describeRequest,
  describeToken,
  explainCredentialProblem,
  readSession,
  sessionNeedsRefresh,
  tokenFingerprint,
  type CredentialInfo,
  type ResponseInfo
} from '../app/src/lib/credentials.ts';

const NOW = Date.parse('2026-09-30T12:00:00Z');
const CLASSIC = 'ghp_' + 'a'.repeat(32) + 'Ab12';
const FINE_GRAINED = 'github_pat_' + 'b'.repeat(70) + 'Cd34';
const OAUTH = 'gho_' + 'c'.repeat(32) + 'Ef56';

const github = (status: number, extra: Partial<ResponseInfo> = {}): ResponseInfo => ({
  service: 'github',
  status,
  method: 'GET',
  url: 'https://api.github.com/repos/apache/ozone/pulls/11302/files?per_page=100&_=1790000000000',
  ...extra
});
const settings = (token: string, extra: Partial<CredentialInfo> = {}): CredentialInfo => ({source: 'settings', token, ...extra});
const signedIn: CredentialInfo = {source: 'signin', token: OAUTH, login: 'peterxcli'};
const none: CredentialInfo = {source: 'none'};
const explain = (response: ResponseInfo, credential: CredentialInfo) => explainCredentialProblem(response, credential, NOW)!;
const detail = (problem: {details: Array<{label: string; value: string}>}, label: string) =>
  (problem.details.find((d) => d.label === label) || {value: undefined}).value;
const actions = (problem: {actions: Array<{label: string; action?: string; href?: string}>}) =>
  problem.actions.map((a) => a.action || a.href);

function jwt(claims: Record<string, unknown>): string {
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
  return `${encode({alg: 'HS256', typ: 'JWT'})}.${encode(claims)}.signature`;
}

test('tokens are described by their prefix, never shown whole', () => {
  assert.deepEqual(describeToken(CLASSIC), {kind: 'classic', label: 'Personal access token (classic)', masked: 'ghp_…Ab12'});
  assert.equal(describeToken(FINE_GRAINED).kind, 'fine_grained');
  assert.equal(describeToken(FINE_GRAINED).masked, 'github_pat_…Cd34');
  assert.equal(describeToken(OAUTH).label, 'OAuth token');
  assert.deepEqual(describeToken('some-other-token-a1b2'), {kind: 'unknown', label: 'Token', masked: '…a1b2'});
});

test('fingerprints are short and stable', async () => {
  assert.equal((await tokenFingerprint(CLASSIC)).length, 16);
  assert.equal(await tokenFingerprint(CLASSIC), await tokenFingerprint(CLASSIC));
  assert.notEqual(await tokenFingerprint(CLASSIC), await tokenFingerprint(OAUTH));
});

test('requests are named after what they were for', () => {
  assert.equal(describeRequest('GET', 'https://api.github.com/repos/apache/ozone/pulls/11302/files'),
    'Loading the changes of apache/ozone#11302');
  assert.equal(describeRequest('POST', 'https://api.github.com/repos/apache/ozone/pulls/11302/comments'),
    'Adding a comment to apache/ozone#11302');
  assert.equal(describeRequest('GET', 'https://api.github.com/repos/apache/ozone/git/trees/master?recursive=1'),
    'Loading the code tree of apache/ozone');
  assert.equal(describeRequest('GET', 'https://api.github.com/repos/apache/ozone'), 'Loading apache/ozone');
  assert.equal(describeRequest('POST', 'https://api.github.com/graphql'), 'Querying GitHub');
});

test('401: a token from the settings is no longer accepted, with when it last worked', () => {
  const problem = explain(github(401, {message: 'Bad credentials'}),
    settings(FINE_GRAINED, {lastAccepted: {at: '2026-09-30T09:00:00Z'}}));
  assert.equal(problem.kind, 'token_rejected');
  assert.match(problem.summary, /Fine-grained tokens always expire/);
  assert.match(detail(problem, 'Token')!, /^Fine-grained personal access token github_pat_…Cd34, entered in TreeHub settings$/);
  assert.match(detail(problem, 'Last accepted')!, /3 hours ago/);
  assert.equal(detail(problem, 'GitHub says'), 'Bad credentials');
  assert.equal(detail(problem, 'Request'), 'Loading the changes of apache/ozone#11302 ' +
    '(GET /repos/apache/ozone/pulls/11302/files?per_page=100)');
  assert.deepEqual(actions(problem), ['settings', 'https://github.com/settings/personal-access-tokens',
    'https://github.com/settings/tokens/new?scopes=repo&description=TreeHub%20browser%20extension']);
});

test('401: the token from signing in was revoked, sign in again', () => {
  const problem = explain(github(401, {message: 'Bad credentials'}), signedIn);
  assert.equal(problem.kind, 'token_rejected');
  assert.match(problem.summary, /signed in as @peterxcli.*authorization was revoked/);
  assert.deepEqual(actions(problem), ['signIn']);
});

test('401 or 404 without a token: sign in', () => {
  assert.equal(explain(github(401), none).kind, 'token_required');
  const problem = explain(github(404, {url: 'https://api.github.com/repos/acme/private'}), none);
  assert.equal(problem.kind, 'token_required');
  assert.deepEqual(actions(problem), ['signIn', 'settings']);
});

test('403: rate limit, with the reset time and a hint to sign in without a token', () => {
  const headers = {'x-ratelimit-remaining': '0', 'x-ratelimit-limit': '60', 'x-ratelimit-reset': String(NOW / 1000 + 720),
    'x-ratelimit-resource': 'core'};
  const anonymous = explain(github(403, {headers, message: 'API rate limit exceeded for 1.2.3.4.'}), none);
  assert.equal(anonymous.kind, 'rate_limited');
  assert.match(anonymous.summary, /60 requests per hour/);
  assert.equal(detail(anonymous, 'Limit'), '60 requests per hour (core), all used');
  assert.match(detail(anonymous, 'Resets')!, /in 12 minutes/);
  assert.deepEqual(actions(anonymous), ['signIn', 'settings']);

  const withToken = explain(github(403, {headers: {...headers, 'x-ratelimit-limit': '5000'}}), signedIn);
  assert.equal(withToken.kind, 'rate_limited');
  assert.deepEqual(withToken.actions, []);
  // The same problem later keeps its key: it is shown once
  assert.equal(explainCredentialProblem(github(403, {headers}), none, NOW + 60000)!.key, anonymous.key);
});

test('403: secondary rate limit says when to try again', () => {
  const problem = explain(github(403, {message: 'You have exceeded a secondary rate limit.', headers: {'retry-after': '60'}}), signedIn);
  assert.equal(problem.kind, 'secondary_rate_limited');
  assert.match(detail(problem, 'Try again')!, /in 1 minute/);
});

test('403: SAML single sign-on links to the authorization of the organization', () => {
  const url = 'https://github.com/orgs/acme/sso?authorization_request=A1B2';
  const problem = explain(github(403, {headers: {'x-github-sso': `required; url=${url}`}}), settings(CLASSIC));
  assert.equal(problem.kind, 'sso_required');
  assert.match(problem.summary, /The acme organization requires SAML single sign-on/);
  assert.equal(problem.actions[0].href, url);
  assert.equal(problem.actions[0].label, 'Authorize for acme');
});

test('403: organizations restricting OAuth apps', () => {
  const message = 'Although you appear to have the correct authorization credentials, the `acme` organization has ' +
    'enabled OAuth App access restrictions, meaning that data access to third-parties is limited.';
  const problem = explain(github(403, {message}), signedIn);
  assert.equal(problem.kind, 'oauth_app_restricted');
  assert.match(problem.summary, /The acme organization limits the apps/);
  assert.match(problem.actions[0].href!, /settings\/connections\/applications\//);
});

test('missing scope: needs repo, the token only has public_repo', () => {
  const headers = {'x-accepted-oauth-scopes': 'repo', 'x-oauth-scopes': 'public_repo, read:org'};
  const problem = explain(github(404, {url: 'https://api.github.com/repos/acme/private', headers}), settings(CLASSIC));
  assert.equal(problem.kind, 'missing_scope');
  assert.match(problem.summary, /needs a token with the repo scope for this, and this token only has public_repo, read:org/);
  assert.equal(detail(problem, 'Token scopes'), 'public_repo, read:org');
  assert.equal(detail(problem, 'Needs'), 'repo');

  // repo includes public_repo: not a scope problem
  const enough = {'x-accepted-oauth-scopes': 'public_repo', 'x-oauth-scopes': 'repo'};
  assert.equal(explain(github(404, {url: 'https://api.github.com/repos/acme/private', headers: enough}), settings(CLASSIC)).kind,
    'no_access');
});

test('no access to the repository, per kind of token', () => {
  const fine = explain(github(403, {message: 'Resource not accessible by personal access token'}), settings(FINE_GRAINED));
  assert.equal(fine.kind, 'no_access');
  assert.match(fine.summary, /repository access and permissions/);

  const oauth = explain(github(404, {url: 'https://api.github.com/repos/acme/private'}), signedIn);
  assert.equal(oauth.kind, 'no_access');
  assert.match(oauth.summary, /restrict OAuth apps/);
  // One popup per repository
  assert.notEqual(explain(github(404, {url: 'https://api.github.com/repos/acme/other'}), signedIn).key, oauth.key);
});

test('other 403s show what GitHub says', () => {
  const problem = explain(github(403, {method: 'POST', url: 'https://api.github.com/repos/acme/app/pulls/1/comments',
    message: 'Repository was archived so is read-only.'}), signedIn);
  assert.equal(problem.kind, 'forbidden');
  assert.equal(detail(problem, 'GitHub says'), 'Repository was archived so is read-only.');
  assert.match(detail(problem, 'Request')!, /^Adding a comment to acme\/app#1/);
});

test('TreeHub sessions: expiry read from the token, revocation and deleted accounts', () => {
  const treehub = (message: string): ResponseInfo => ({service: 'treehub', status: 401, method: 'GET',
    url: 'https://treehub-api.peterxcli.workers.dev/api/queue', message});
  const expired = jwt({sub: 'peterxcli', iat: NOW / 1000 - 31 * 86400, exp: NOW / 1000 - 86400});
  assert.deepEqual(readSession(expired), {issuedAt: new Date(NOW - 31 * 86400000).toISOString(),
    expiresAt: new Date(NOW - 86400000).toISOString()});

  const problem = explain(treehub('invalid or expired session'), {source: 'signin', login: 'peterxcli', session: expired});
  assert.equal(problem.kind, 'session_expired');
  assert.match(detail(problem, 'Expired')!, /\(24 hours ago\)$/);
  assert.deepEqual(actions(problem), ['signIn']);

  const valid = jwt({sub: 'peterxcli', iat: NOW / 1000 - 86400, exp: NOW / 1000 + 86400});
  assert.equal(explain(treehub('session revoked'), {source: 'signin', session: valid}).kind, 'session_revoked');
  assert.equal(explain(treehub('unknown user'), {source: 'signin', session: valid}).kind, 'account_deleted');
  assert.equal(explain(treehub('invalid or expired session'), {source: 'signin', session: 'not-a-jwt'}).kind,
    'session_invalid');
  assert.equal(explainCredentialProblem({service: 'treehub', status: 500}, {source: 'none'}, NOW), null);
});

test('TreeHub sessions are renewed past half their lifetime', () => {
  const DAY = 86400;
  const session = jwt({sub: 'peterxcli', iat: NOW / 1000 - 10 * DAY, exp: NOW / 1000 + 20 * DAY});
  // Issued 10 days ago for 30 days: half its lifetime is 5 days away
  assert.equal(sessionNeedsRefresh(session, NOW), false);
  assert.equal(sessionNeedsRefresh(session, NOW + 5 * DAY * 1000), false);
  assert.equal(sessionNeedsRefresh(session, NOW + 5 * DAY * 1000 + 1000), true);
  assert.equal(sessionNeedsRefresh(session, NOW + 19 * DAY * 1000), true);
  // Expired: only signing in again helps
  assert.equal(sessionNeedsRefresh(session, NOW + 20 * DAY * 1000), false);
  // Without its times, or not a JWT
  assert.equal(sessionNeedsRefresh(jwt({sub: 'peterxcli', exp: NOW / 1000 + DAY}), NOW), false);
  assert.equal(sessionNeedsRefresh('not-a-jwt', NOW), false);
});
