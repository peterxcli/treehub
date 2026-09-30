// Explains why GitHub or the TreeHub server refused a request (HTTP 401 and 403, and 404 for resources that
// exist since the user is looking at them), from the response and what TreeHub knows of the credentials. The
// sidebar pages and the dashboard show the result in a popup. Pure functions, tested with Node.
//
// GitHub tokens don't carry their expiry, and GitHub doesn't let browsers read the header announcing it
// (GitHub-Authentication-Token-Expiration isn't CORS-exposed), so a rejected token is explained with when GitHub
// last accepted it. TreeHub sessions are JWTs whose expiry is known.

export type ProblemKind =
  | 'rate_limited'
  | 'secondary_rate_limited'
  | 'sso_required'
  | 'oauth_app_restricted'
  | 'missing_scope'
  | 'no_access'
  | 'token_rejected'
  | 'token_required'
  | 'forbidden'
  | 'session_expired'
  | 'session_revoked'
  | 'account_deleted'
  | 'session_invalid';

export interface ResponseInfo {
  service: 'github' | 'treehub';
  status: number;
  method?: string;
  url?: string;
  /** What the request was for, e.g. "Loading the code tree"; guessed from the URL when not given. */
  label?: string;
  /** Error message of the API, e.g. "Bad credentials". */
  message?: string;
  /** Response headers, lowercased names. */
  headers?: Record<string, string | null | undefined>;
}

export interface CredentialInfo {
  /** Where the GitHub token of the request came from. */
  source: 'settings' | 'signin' | 'none';
  /** The GitHub token; only its kind and last characters are shown. */
  token?: string;
  /** When GitHub last accepted the token, and its scopes then. */
  lastAccepted?: {at: string; scopes?: string} | null;
  /** Handle signed in to TreeHub. */
  login?: string;
  /** TreeHub session (a JWT). */
  session?: string;
}

export interface Detail {
  label: string;
  value: string;
  href?: string;
}

export interface Action {
  label: string;
  href?: string;
  /** Done by the page: sign in with GitHub, or open TreeHub's settings (the token field). */
  action?: 'signIn' | 'settings';
}

export interface CredentialProblem {
  kind: ProblemKind;
  /** The same problem has the same key, so that it is shown once. */
  key: string;
  title: string;
  summary: string;
  details: Detail[];
  actions: Action[];
}

/** Client ID of TreeHub's GitHub OAuth App: its page on GitHub shows and manages the access TreeHub has. */
export const GITHUB_OAUTH_CLIENT_ID = 'Ov23liKyOwKsuF8gMRts';
const APP_SETTINGS = `https://github.com/settings/connections/applications/${GITHUB_OAUTH_CLIENT_ID}`;
const CLASSIC_TOKENS = 'https://github.com/settings/tokens';
const FINE_GRAINED_TOKENS = 'https://github.com/settings/personal-access-tokens';
const NEW_TOKEN = 'https://github.com/settings/tokens/new?scopes=repo&description=TreeHub%20browser%20extension';

// ---------- Tokens ----------

export type TokenKind = 'fine_grained' | 'classic' | 'oauth' | 'app_user' | 'app_installation' | 'unknown';

const TOKEN_KINDS: Array<[string, TokenKind, string]> = [
  ['github_pat_', 'fine_grained', 'Fine-grained personal access token'],
  ['ghp_', 'classic', 'Personal access token (classic)'],
  ['gho_', 'oauth', 'OAuth token'],
  ['ghu_', 'app_user', 'GitHub App user token'],
  ['ghs_', 'app_installation', 'GitHub App installation token']
];

/** Kind of a GitHub token from its prefix, and a masked form showing its last characters. */
export function describeToken(token: string): {kind: TokenKind; label: string; masked: string} {
  const found = TOKEN_KINDS.find(([prefix]) => token.startsWith(prefix));
  if (found) {
    const [prefix, kind, label] = found;
    return {kind, label, masked: `${prefix}…${token.slice(-4)}`};
  }
  // Tokens made before 2021 are 40 hex characters
  const label = /^[0-9a-f]{40}$/.test(token) ? 'Personal access token (classic)' : 'Token';
  return {kind: label === 'Token' ? 'unknown' : 'classic', label, masked: `…${token.slice(-4)}`};
}

/** Short fingerprint of a token, to remember facts about it without storing it again. */
export async function tokenFingerprint(token: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token));
  return Array.from(new Uint8Array(digest).slice(0, 8), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

/** Expiry and issue time of a TreeHub session (JWT), or null when it can't be read. */
export function readSession(jwt: string): {issuedAt: string | null; expiresAt: string | null} | null {
  try {
    const payload = jwt.split('.')[1];
    const json = JSON.parse(atob(payload.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(payload.length / 4) * 4, '=')));
    const time = (seconds: unknown) => (typeof seconds === 'number' ? new Date(seconds * 1000).toISOString() : null);
    return {issuedAt: time(json.iat), expiresAt: time(json.exp)};
  } catch {
    return null;
  }
}

// ---------- Scopes ----------

// Scopes that include others (https://docs.github.com/apps/oauth-apps/building-oauth-apps/scopes-for-oauth-apps)
const SCOPE_PARENTS: Record<string, string[]> = {
  public_repo: ['repo'],
  'repo:status': ['repo'],
  repo_deployment: ['repo'],
  'repo:invite': ['repo'],
  security_events: ['repo'],
  'read:org': ['write:org', 'admin:org'],
  'write:org': ['admin:org'],
  'read:user': ['user'],
  'user:email': ['user'],
  'user:follow': ['user']
};

const splitScopes = (value: string | null | undefined) =>
  (value || '')
    .split(',')
    .map((scope) => scope.trim())
    .filter(Boolean);

function hasScope(granted: string[], needed: string): boolean {
  return granted.includes(needed) || (SCOPE_PARENTS[needed] || []).some((parent) => granted.includes(parent));
}

// ---------- Requests ----------

/** What a request was for, from its URL, e.g. "Loading the changes of apache/ozone#11302". */
export function describeRequest(method = 'GET', url = ''): string {
  let path = url;
  try {
    path = new URL(url).pathname;
  } catch {
    // Already a path
  }
  const write = method.toUpperCase() !== 'GET';
  const repo = path.match(/^\/repos\/([^/]+\/[^/]+)(\/.*)?$/);
  if (repo) {
    const [, name, rest = ''] = repo;
    const pull = rest.match(/^\/pulls\/(\d+)(\/[^/]+)?/);
    if (pull) {
      const ref = `${name}#${pull[1]}`;
      switch (pull[2]) {
        case '/files':
          return `Loading the changes of ${ref}`;
        case '/comments':
          return write ? `Adding a comment to ${ref}` : `Loading the comments of ${ref}`;
        case '/reviews':
          return write ? `Starting a review of ${ref}` : `Loading the reviews of ${ref}`;
        default:
          return `Loading ${ref}`;
      }
    }
    if (rest.startsWith('/git/trees')) return `Loading the code tree of ${name}`;
    if (rest.startsWith('/git/blobs') || rest.startsWith('/contents')) return `Loading a file of ${name}`;
    if (rest.startsWith('/compare')) return `Comparing commits of ${name}`;
    if (rest.startsWith('/commits')) return `Loading a commit of ${name}`;
    if (!rest || rest === '/') return `Loading ${name}`;
    return `${write ? 'Updating' : 'Loading'} ${name}`;
  }
  if (path.startsWith('/search/issues')) return 'Listing pull requests';
  if (path.endsWith('/graphql')) return 'Querying GitHub';
  if (path.startsWith('/api/')) return 'Syncing your bookmarks and review queue';
  return `${method.toUpperCase()} ${path}`;
}

function requestDetail(response: ResponseInfo): Detail {
  let path = response.url || '';
  try {
    const url = new URL(path);
    path = url.pathname + url.search;
  } catch {
    // Already a path
  }
  const method = (response.method || 'GET').toUpperCase();
  return {
    label: 'Request',
    value: `${response.label || describeRequest(method, response.url)} (${method} ${path.replace(/[?&]_=\d+/, '')})`
  };
}

// ---------- Times ----------

function formatTime(iso: string, now: number): string {
  const time = Date.parse(iso);
  const date = new Date(time);
  const sameDay = new Date(now).toDateString() === date.toDateString();
  const text = sameDay
    ? date.toLocaleTimeString(undefined, {hour: '2-digit', minute: '2-digit'})
    : date.toLocaleString(undefined, {dateStyle: 'medium', timeStyle: 'short'});
  return `${text} (${relative(time - now)})`;
}

function relative(ms: number): string {
  const future = ms > 0;
  const minutes = Math.round(Math.abs(ms) / 60000);
  const [count, unit] =
    minutes < 1
      ? [0, '']
      : minutes < 60
        ? [minutes, 'minute']
        : minutes < 48 * 60
          ? [Math.round(minutes / 60), 'hour']
          : [Math.round(minutes / 1440), 'day'];
  if (!count) return future ? 'in less than a minute' : 'just now';
  const amount = `${count} ${unit}${count === 1 ? '' : 's'}`;
  return future ? `in ${amount}` : `${amount} ago`;
}

// ---------- Explanations ----------

/**
 * Explains a refused request, or returns null when there is nothing to explain (e.g. a 404 of a resource that
 * may not exist).
 */
export function explainCredentialProblem(
  response: ResponseInfo,
  credential: CredentialInfo,
  now = Date.now()
): CredentialProblem | null {
  return response.service === 'treehub'
    ? explainSession(response, credential, now)
    : explainGitHub(response, credential, now);
}

function explainGitHub(response: ResponseInfo, credential: CredentialInfo, now: number): CredentialProblem | null {
  const {status} = response;
  const header = (name: string) => (response.headers && response.headers[name]) || '';
  const message = response.message || '';
  const token = credential.source !== 'none' && credential.token ? describeToken(credential.token) : null;
  const fromSettings = credential.source === 'settings';
  const who = credential.login ? ` as @${credential.login}` : '';

  const details: Detail[] = [requestDetail(response)];
  if (token) {
    const origin = fromSettings ? 'entered in TreeHub settings' : `from signing in to TreeHub${who}`;
    details.push({label: 'Token', value: `${token.label} ${token.masked}, ${origin}`});
  } else {
    details.push({label: 'Token', value: 'None: TreeHub isn\'t signed in and has no personal access token'});
  }
  const scopes = header('x-oauth-scopes') || (credential.lastAccepted && credential.lastAccepted.scopes) || '';
  if (token && token.kind !== 'fine_grained' && (scopes || header('x-accepted-oauth-scopes'))) {
    details.push({label: 'Token scopes', value: scopes || 'none'});
  }
  if (message) details.push({label: 'GitHub says', value: message});

  const tokenPage = token && token.kind === 'fine_grained' ? FINE_GRAINED_TOKENS : CLASSIC_TOKENS;
  const fixToken: Action[] = fromSettings
    ? [{label: 'Update the token in TreeHub settings', action: 'settings'}, {label: 'Your tokens on GitHub', href: tokenPage}]
    : [{label: 'Sign in again', action: 'signIn'}];
  const getToken: Action[] = [
    {label: 'Sign in with GitHub', action: 'signIn'},
    {label: 'Enter a token in TreeHub settings', action: 'settings'}
  ];
  const repo = ((response.url || '').match(/\/repos\/([^/?#]+\/[^/?#]+)/) || [])[1] || '';
  const problem = (
    kind: ProblemKind,
    title: string,
    summary: string,
    actions: Action[],
    extra: Detail[] = [],
    scope = ''
  ): CredentialProblem => ({
    kind,
    // Stable across requests: repeated failures show one popup
    key: [kind, token ? token.masked : 'none', scope].join(':'),
    title,
    summary,
    details: [...details, ...extra],
    actions
  });

  // Rate limits: not a credential problem, but GitHub answers 403 (or 429)
  const exhausted = header('x-ratelimit-remaining') === '0';
  if ((status === 403 || status === 429) && (exhausted || /rate limit/i.test(message))) {
    const reset = Number(header('x-ratelimit-reset'));
    const retryAfter = Number(header('retry-after'));
    if (!exhausted || /secondary rate limit/i.test(message)) {
      const wait = retryAfter ? [{label: 'Try again', value: formatTime(new Date(now + retryAfter * 1000).toISOString(), now)}] : [];
      return problem(
        'secondary_rate_limited',
        'GitHub is limiting TreeHub\'s requests',
        'Too many requests were made in a short time (GitHub\'s secondary rate limit). TreeHub works again after ' +
          'a short pause.',
        [],
        wait
      );
    }
    const limit = Number(header('x-ratelimit-limit')) || (token ? 5000 : 60);
    const resource = header('x-ratelimit-resource');
    const extra: Detail[] = [
      {label: 'Limit', value: `${limit.toLocaleString()} requests per hour${resource ? ` (${resource})` : ''}, all used`}
    ];
    if (reset) extra.push({label: 'Resets', value: formatTime(new Date(reset * 1000).toISOString(), now)});
    return problem(
      'rate_limited',
      'GitHub API rate limit exceeded',
      token
        ? 'TreeHub used all the requests GitHub allows per hour for this token. It works again when the limit resets.'
        : 'Without a token, GitHub allows 60 requests per hour. Sign in with GitHub (or enter a personal access ' +
          'token) to raise the limit to 5,000 per hour.',
      token ? [] : getToken,
      extra
    );
  }

  // SAML single sign-on of an organization
  const sso = header('x-github-sso');
  if ((status === 403 && /^required/i.test(sso)) || /SAML enforcement/i.test(message)) {
    const url = (sso.match(/url=(\S+)/) || [])[1];
    const org = url ? decodeURIComponent((url.match(/\/orgs\/([^/]+)\/sso/) || [])[1] || '') : '';
    const name = org ? `The ${org} organization` : 'The organization of this repository';
    return problem(
      'sso_required',
      'Single sign-on required',
      `${name} requires SAML single sign-on: the token has to be authorized for it.`,
      url ? [{label: `Authorize for ${org || 'the organization'}`, href: url}, ...fixToken.slice(1)] : fixToken,
      [],
      org || repo
    );
  }

  // Organizations can restrict OAuth apps (TreeHub's sign-in); personal access tokens aren't concerned
  if (/OAuth App access restrictions/i.test(message)) {
    const org = (message.match(/the [`'"]?([\w.-]+)[`'"]? organization/i) || [])[1];
    return problem(
      'oauth_app_restricted',
      'The organization restricts apps',
      `${org ? `The ${org} organization` : 'This organization'} limits the apps that can access its data, and ` +
        'hasn\'t approved TreeHub. An owner can approve it; you can request it on TreeHub\'s page in your GitHub ' +
        'settings, or enter a personal access token in TreeHub settings instead.',
      [{label: 'Request approval', href: APP_SETTINGS}, {label: 'Enter a token in TreeHub settings', action: 'settings'}],
      [],
      org || repo
    );
  }

  if (status === 401) {
    if (!token) {
      return problem(
        'token_required',
        'Sign in to GitHub',
        'GitHub needs a token for this request. Sign in with GitHub, or enter a personal access token in ' +
          'TreeHub settings.',
        getToken
      );
    }
    const last = credential.lastAccepted && credential.lastAccepted.at;
    const extra: Detail[] = last ? [{label: 'Last accepted', value: formatTime(last, now)}] : [];
    let summary: string;
    if (!fromSettings) {
      summary =
        `GitHub no longer accepts the token TreeHub got when you signed in${who}: TreeHub's authorization was ` +
        'revoked, or GitHub removed it after a year without use. Sign in again to get a new one.';
    } else if (token.kind === 'fine_grained') {
      summary =
        'GitHub no longer accepts the fine-grained personal access token entered in TreeHub settings. ' +
        'Fine-grained tokens always expire: it expired, or it was revoked or regenerated. GitHub lists its ' +
        'expiration date on your token settings page.';
    } else {
      summary =
        'GitHub no longer accepts the personal access token entered in TreeHub settings: it expired, or it was ' +
        'deleted or regenerated. GitHub lists its expiration date on your token settings page.';
    }
    return problem(
      'token_rejected',
      fromSettings ? 'Your GitHub token isn\'t valid anymore' : 'Your GitHub sign-in isn\'t valid anymore',
      summary,
      fromSettings ? [...fixToken, {label: 'Create a new token', href: NEW_TOKEN}] : fixToken,
      extra
    );
  }

  // Missing OAuth scope (classic tokens and TreeHub's sign-in)
  const accepted = splitScopes(header('x-accepted-oauth-scopes'));
  const granted = splitScopes(header('x-oauth-scopes'));
  if (token && token.kind !== 'fine_grained' && accepted.length && !accepted.some((scope) => hasScope(granted, scope))) {
    return problem(
      'missing_scope',
      'Your token is missing a scope',
      `GitHub needs a token with the ${accepted.join(' or ')} scope for this, and ` +
        `${granted.length ? `this token only has ${granted.join(', ')}` : 'this token has no scopes'}.` +
        (fromSettings ? ' Add the scope to the token on GitHub, or create a new one.' : ' Sign in again to fix it.'),
      fromSettings ? [...fixToken, {label: 'Create a new token', href: NEW_TOKEN}] : fixToken,
      [{label: 'Needs', value: accepted.join(' or ')}],
      accepted.join(',')
    );
  }

  // A 404 means no access: the page shows the resource, so it exists (GitHub hides private resources this way)
  const noAccess = status === 404 || /Resource not accessible by (personal access token|integration)/i.test(message);
  if (noAccess) {
    if (!token) {
      return problem(
        'token_required',
        'Sign in to see this repository',
        'This repository is private, or TreeHub needs a token to read it. Sign in with GitHub, or enter a ' +
          'personal access token in TreeHub settings.',
        getToken,
        [],
        repo
      );
    }
    let summary: string;
    if (token.kind === 'fine_grained') {
      summary =
        'The fine-grained personal access token entered in TreeHub settings has no access to this repository, or ' +
        'lacks a permission this needs (Contents: read, Pull requests: read and write to comment). Edit the token\'s ' +
        'repository access and permissions on GitHub.';
    } else if (fromSettings) {
      summary =
        'GitHub doesn\'t let this token read this repository. For a private repository the token needs the repo ' +
        'scope; the organization may also require single sign-on, or restrict personal access tokens.';
    } else {
      summary =
        `Your GitHub account${who} can't access this repository through TreeHub. Its organization may restrict ` +
        'OAuth apps (an owner can approve TreeHub) or require single sign-on.';
    }
    return problem(
      'no_access',
      'No access to this repository',
      summary,
      fromSettings ? fixToken : [{label: 'Check TreeHub\'s access', href: APP_SETTINGS}, ...fixToken],
      [],
      repo
    );
  }

  if (status === 403) {
    return problem(
      'forbidden',
      'GitHub refused this request',
      token
        ? 'GitHub refused this request with this token. See what GitHub says below.'
        : 'GitHub refused this request without a token. Sign in with GitHub, or enter a personal access token.',
      token ? fixToken : getToken,
      [],
      `${repo}:${message}`
    );
  }
  return null;
}

function explainSession(response: ResponseInfo, credential: CredentialInfo, now: number): CredentialProblem | null {
  if (response.status !== 401) return null;
  const session = credential.session ? readSession(credential.session) : null;
  const details: Detail[] = [requestDetail(response)];
  if (credential.login) details.push({label: 'Signed in as', value: `@${credential.login}`});
  if (session && session.issuedAt) details.push({label: 'Signed in', value: formatTime(session.issuedAt, now)});
  const signIn: Action[] = [{label: 'Sign in again', action: 'signIn'}];
  const message = response.message || '';
  const make = (kind: ProblemKind, title: string, summary: string, extra: Detail[] = []): CredentialProblem => ({
    kind,
    key: `${kind}:${credential.login || ''}`,
    title,
    summary,
    details: [...details, ...extra],
    actions: signIn
  });

  if (session && session.expiresAt && Date.parse(session.expiresAt) <= now) {
    return make(
      'session_expired',
      'Your TreeHub sign-in expired',
      'TreeHub sign-ins last 30 days. Sign in again to keep your bookmarks and review queue in sync.',
      [{label: 'Expired', value: formatTime(session.expiresAt, now)}]
    );
  }
  if (/revoked/i.test(message)) {
    return make(
      'session_revoked',
      'You were signed out everywhere',
      '"Sign out everywhere" ended your TreeHub sessions in all browsers. Sign in again to continue.'
    );
  }
  if (/unknown user/i.test(message)) {
    return make(
      'account_deleted',
      'Your TreeHub account was deleted',
      'Your TreeHub account, with its bookmarks and review queue, was deleted from this or another browser. ' +
        'Signing in again creates a new, empty account.'
    );
  }
  return make(
    'session_invalid',
    'Your TreeHub sign-in isn\'t valid anymore',
    'The TreeHub server doesn\'t accept this sign-in anymore. Sign in again to continue.',
    session && session.expiresAt ? [{label: 'Expires', value: formatTime(session.expiresAt, now)}] : []
  );
}
