// What the background worker does for bookmarks and the review queue. The worker is the only writer of the
// shared state (lib/storage.ts): it calls the backend and GitHub, then saves the result so every open page updates.
// Toggles are optimistic: the state changes at once and is reverted if the backend refuses the change.
import * as api from './api.ts';
import {ApiError} from './api.ts';
import {signIn as authorize} from './auth.ts';
import {
  explainCredentialProblem,
  tokenFingerprint,
  type CredentialInfo,
  type CredentialProblem,
  type ResponseInfo
} from './credentials.ts';
import {GitHubError, fetchQueueStates, fetchRepos} from './github.ts';
import {needsAttention, prKey, type PRRef, type PRState} from './status.ts';
import {
  KEYS,
  load,
  personalToken,
  save,
  type Account,
  type Auth,
  type BookmarkEntry,
  type Hub,
  type QueueEntry,
  type TokenSeen
} from './storage.ts';

const REPO_TTL_MS = 30 * 60 * 1000;
// Records that GitHub accepted a token at most this often (unless its scopes change)
const TOKEN_SEEN_THROTTLE_MS = 10 * 60 * 1000;
// Visiting a pull request again within this time does not record another visit.
const SEEN_THROTTLE_MS = 30 * 1000;

const now = () => new Date().toISOString();
const sameRepo = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
const sameLogin = (a: Auth | undefined, login: string) => !!a && a.account.login.toLowerCase() === login.toLowerCase();

// Read-modify-write updates of the stored state run one at a time. Tasks must not call exclusive() again.
let tail: Promise<unknown> = Promise.resolve();
function exclusive<T>(task: () => Promise<T>): Promise<T> {
  const run = tail.then(task, task);
  tail = run.catch(() => undefined);
  return run;
}

// Bumped by every local change of the hub, so that a listing fetched before the change does not undo it.
let hubVersion = 0;

async function requireAuth(): Promise<Auth> {
  const {auth} = await load();
  if (!auth) throw new ApiError(401, 'login_required', 'Sign in with GitHub to use bookmarks and the review queue.');
  return auth;
}

/** The token used to read GitHub: the one from signing in, else the one entered in the sidebar settings. */
async function githubToken(auth: Auth): Promise<string | undefined> {
  return auth.githubToken || (await personalToken());
}

/**
 * Signs out locally when the backend rejects the session, so that the pages offer to sign in again, and explains
 * why (the error gets the explanation as `problem`, and the sign-in page shows it).
 */
async function backend<T>(request: Promise<T>): Promise<T> {
  try {
    return await request;
  } catch (err) {
    if (err instanceof ApiError && err.isAuthError) {
      const {auth} = await load();
      const {method, url, serverMessage} = err.request || {};
      const problem = auth
        ? explainCredentialProblem(
            {service: 'treehub', status: 401, method, url, message: serverMessage},
            {source: 'signin', login: auth.account.login, session: auth.session}
          )
        : null;
      await clearAccount(problem);
      if (problem) throw Object.assign(err, {problem});
    }
    throw err;
  }
}

async function clearAccount(problem: CredentialProblem | null = null): Promise<void> {
  await exclusive(() => save({auth: null, hub: null, statuses: null, repos: null, signinProblem: problem}));
  await updateBadge();
}

// ---------- Credentials ----------

async function tokenOf(source: 'settings' | 'signin' | 'none', auth: Auth | undefined): Promise<string | undefined> {
  if (source === 'settings') return personalToken();
  return source === 'signin' && auth ? auth.githubToken : undefined;
}

async function credentialFor(source: 'settings' | 'signin' | 'none'): Promise<CredentialInfo> {
  const {auth} = await load();
  const token = await tokenOf(source, auth);
  let lastAccepted = null;
  if (token) {
    const values = await chrome.storage.local.get(KEYS.tokenSeen);
    lastAccepted = ((values[KEYS.tokenSeen] || {}) as TokenSeen)[await tokenFingerprint(token)] || null;
  }
  return {source, token, lastAccepted, login: auth && auth.account.login, session: auth && auth.session};
}

/** Explains why GitHub refused a request of the content script (src/view.credentials.js). */
export async function explainResponse(
  response: ResponseInfo,
  source: 'settings' | 'signin' | 'none'
): Promise<CredentialProblem | null> {
  return explainCredentialProblem(response, await credentialFor(source));
}

/** Remembers that GitHub accepted the token of `source`, to tell when it stops being accepted. */
export async function recordTokenAccepted(source: 'settings' | 'signin', scopes?: string): Promise<void> {
  const token = await tokenOf(source, (await load()).auth);
  if (!token) return;
  const fingerprint = await tokenFingerprint(token);
  await exclusive(async () => {
    const values = await chrome.storage.local.get(KEYS.tokenSeen);
    const seen: TokenSeen = {...((values[KEYS.tokenSeen] || {}) as TokenSeen)};
    const previous = seen[fingerprint];
    const fresh = previous && Date.now() - Date.parse(previous.at) < TOKEN_SEEN_THROTTLE_MS;
    if (fresh && (!scopes || scopes === previous.scopes)) return;
    seen[fingerprint] = {at: now(), scopes: scopes || (previous && previous.scopes)};
    // Only the few latest tokens matter
    const latest = Object.entries(seen).sort((a, b) => Date.parse(b[1].at) - Date.parse(a[1].at)).slice(0, 10);
    await chrome.storage.local.set({[KEYS.tokenSeen]: Object.fromEntries(latest)});
  });
}

async function updateHub(auth: Auth, change: (hub: Hub) => Hub): Promise<void> {
  hubVersion++;
  await exclusive(async () => {
    const {auth: current, hub} = await load();
    // Signed out (or in as someone else) meanwhile
    if (!sameLogin(current, auth.account.login)) return;
    const base = hub && hub.login === auth.account.login
      ? hub
      : {login: auth.account.login, bookmarks: [], queue: [], syncedAt: ''};
    await save({hub: change(base)});
  });
}

// ---------- Account ----------

export async function signIn(devLogin?: string): Promise<Account> {
  const auth = await authorize(devLogin);
  await exclusive(async () => {
    const {auth: previous} = await load();
    // Data of another account must not show up
    await save(
      sameLogin(previous, auth.account.login)
        ? {auth, signinProblem: null}
        : {auth, hub: null, statuses: null, repos: null, signinProblem: null}
    );
  });
  await sync();
  void refreshStatuses();
  return auth.account;
}

export async function signOut(everywhere = false): Promise<void> {
  const {auth} = await load();
  if (auth && everywhere) {
    try {
      await api.logoutAll(auth.session);
    } catch (err) {
      if (!(err instanceof ApiError && err.isAuthError)) throw err;
    }
  }
  await clearAccount();
}

/** Deletes the TreeHub account (bookmarks and queue included) from the backend, then signs out. */
export async function deleteAccount(): Promise<void> {
  const auth = await requireAuth();
  await backend(api.deleteAccount(auth.session));
  await clearAccount();
}

/** Downloads the bookmarks and the queue, e.g. to pick up changes made in another browser. */
export async function sync(): Promise<void> {
  const auth = await requireAuth();
  const version = hubVersion;
  const [bookmarks, queue] = await backend(Promise.all([api.listBookmarks(auth.session), api.listQueue(auth.session)]));
  await exclusive(async () => {
    const {auth: current} = await load();
    // A toggle made meanwhile is newer than this listing; the next sync picks up both
    if (version !== hubVersion || !sameLogin(current, auth.account.login)) return;
    await save({hub: {login: auth.account.login, bookmarks, queue, syncedAt: now()}});
  });
}

// ---------- Bookmarks ----------

export async function setBookmark(repo: string, on: boolean): Promise<void> {
  const auth = await requireAuth();
  const {hub} = await load();
  const previous = hub && hub.bookmarks.find((b) => sameRepo(b.repo, repo));
  const without = (bookmarks: BookmarkEntry[]) => bookmarks.filter((b) => !sameRepo(b.repo, repo));

  await updateHub(auth, (h) => ({
    ...h,
    bookmarks: on ? [previous || {repo, createdAt: now()}, ...without(h.bookmarks)] : without(h.bookmarks)
  }));
  try {
    if (on) {
      const entry = await backend(api.putBookmark(auth.session, repo));
      await updateHub(auth, (h) => ({...h, bookmarks: h.bookmarks.map((b) => (sameRepo(b.repo, repo) ? entry : b))}));
    } else {
      await backend(api.deleteBookmark(auth.session, repo));
    }
  } catch (err) {
    await updateHub(auth, (h) => ({...h, bookmarks: previous ? [previous, ...without(h.bookmarks)] : without(h.bookmarks)}));
    throw err;
  }
}

/** Fetches GitHub details of the bookmarked repositories that have none or old ones. */
export async function refreshRepos(force = false): Promise<void> {
  const {auth, hub, repos} = await load();
  if (!auth || !hub) return;
  const token = await githubToken(auth);
  if (!token) return;

  const cache = (repos && repos.repos) || {};
  const due = hub.bookmarks
    .map((b) => b.repo)
    .filter((repo) => {
      const meta = cache[repo.toLowerCase()];
      return force || !meta || Date.now() - Date.parse(meta.fetchedAt) > REPO_TTL_MS;
    });
  if (!due.length) return;

  const fetched = await fetchRepos(token, due);
  await exclusive(async () => {
    const {auth: current, hub: latest, repos: stored} = await load();
    if (!sameLogin(current, auth.account.login)) return;
    const bookmarked = new Set(((latest && latest.bookmarks) || []).map((b) => b.repo.toLowerCase()));
    const merged = {...((stored && stored.repos) || {}), ...fetched};
    for (const key of Object.keys(merged)) {
      if (!bookmarked.has(key)) delete merged[key];
    }
    await save({repos: {repos: merged}});
  });
}

// ---------- Review queue ----------

export async function setQueued(ref: PRRef, on: boolean, options: {title?: string; seen?: boolean} = {}): Promise<void> {
  const auth = await requireAuth();
  const key = prKey(ref);
  const {hub} = await load();
  const previous = hub && hub.queue.find((e) => prKey(e) === key);
  const without = (queue: QueueEntry[]) => queue.filter((e) => prKey(e) !== key);
  const title = options.title || (previous && previous.title);

  await updateHub(auth, (h) => ({
    ...h,
    queue: on
      ? previous
        ? h.queue.map((e) => (prKey(e) === key ? {...e, title} : e))
        : [{repo: ref.repo, number: ref.number, title, addedAt: now()}, ...without(h.queue)]
      : without(h.queue)
  }));
  try {
    if (on) {
      let entry = await backend(api.putQueueItem(auth.session, ref, options.title));
      // Queued while looking at it
      if (options.seen) entry = await backend(api.markSeen(auth.session, ref));
      await updateHub(auth, (h) => ({...h, queue: h.queue.map((e) => (prKey(e) === key ? entry : e))}));
    } else {
      await backend(api.deleteQueueItem(auth.session, ref));
    }
  } catch (err) {
    await updateHub(auth, (h) => ({...h, queue: previous ? [previous, ...without(h.queue)] : without(h.queue)}));
    throw err;
  }

  if (on) void refreshStatuses([ref]);
  else await forgetStates(auth, [key]);
}

/**
 * Records a visit of a queued pull request, which settles its replies, mentions and updates.
 * @param force record it even if the last visit was just now (an explicit "mark as seen")
 */
export async function markSeen(ref: PRRef, force = false): Promise<void> {
  const {auth, hub} = await load();
  const key = prKey(ref);
  const entry = hub && hub.queue.find((e) => prKey(e) === key);
  if (!auth || !entry) return;
  if (!force && entry.lastSeenAt && Date.now() - Date.parse(entry.lastSeenAt) < SEEN_THROTTLE_MS) return;

  try {
    const updated = await backend(api.markSeen(auth.session, ref));
    await updateHub(auth, (h) => ({...h, queue: h.queue.map((e) => (prKey(e) === key ? updated : e))}));
  } catch (err) {
    // Removed in another browser
    if (err instanceof ApiError && err.status === 404) {
      await updateHub(auth, (h) => ({...h, queue: h.queue.filter((e) => prKey(e) !== key)}));
      await forgetStates(auth, [key]);
      return;
    }
    throw err;
  }
  void refreshStatuses([ref]);
}

async function forgetStates(auth: Auth, keys: string[]): Promise<void> {
  await exclusive(async () => {
    const {statuses} = await load();
    if (!statuses || statuses.login !== auth.account.login) return;
    const states = {...statuses.states};
    for (const key of keys) delete states[key];
    await save({statuses: {...statuses, states}});
  });
  await updateBadge();
}

let fullRefresh: Promise<void> | null = null;

/** Fetches the queued pull requests from GitHub and recomputes their statuses (all, or only `refs`). */
export function refreshStatuses(refs?: PRRef[]): Promise<void> {
  if (refs) return runRefresh(refs);
  if (!fullRefresh) fullRefresh = runRefresh().finally(() => (fullRefresh = null));
  return fullRefresh;
}

async function runRefresh(refs?: PRRef[]): Promise<void> {
  const {auth, hub} = await load();
  if (!auth || !hub) return;
  const login = auth.account.login;
  const keys = refs && new Set(refs.map(prKey));
  const entries = keys ? hub.queue.filter((e) => keys.has(prKey(e))) : hub.queue;

  let states: Record<string, PRState> = {};
  let error: string | undefined;
  let problem: CredentialProblem | undefined;
  let fetched = false;
  const token = await githubToken(auth);
  const source = auth.githubToken ? 'signin' : 'settings';
  if (!token) {
    error = 'TreeHub has no GitHub token to read pull requests with. Please sign in again.';
  } else if (entries.length) {
    try {
      states = await fetchQueueStates(token, entries, login);
      fetched = true;
      void recordTokenAccepted(source);
    } catch (err) {
      error = err instanceof Error ? err.message : String(err);
      if (err instanceof GitHubError && err.response && (err.status === 401 || err.status === 403)) {
        const response = {service: 'github' as const, status: err.status, label: 'Refreshing your review queue', ...err.response};
        problem = explainCredentialProblem(response, await credentialFor(source)) || undefined;
        if (problem) error = problem.title;
      }
    }
  }

  await exclusive(async () => {
    const {auth: current, hub: latest, statuses} = await load();
    if (!sameLogin(current, login)) return;
    const previous = statuses && statuses.login === login ? statuses : undefined;
    // Keeps the states of pull requests queued after this refresh started (refreshed on their own)
    const merged: Record<string, PRState> = {...(previous && previous.states), ...states};
    const queued = new Set(((latest && latest.queue) || []).map(prKey));
    for (const key of Object.keys(merged)) {
      if (!queued.has(key)) delete merged[key];
    }
    // A successful fetch settles earlier failures
    const settled = fetched || !previous;
    await save({
      statuses: {
        login,
        states: merged,
        refreshedAt: keys || error ? previous && previous.refreshedAt : now(),
        error: error || (settled ? undefined : previous.error),
        problem: problem || (error || settled ? undefined : previous.problem)
      }
    });
  });
  await updateBadge();
}

/** Syncs and refreshes when the statuses are older than `ms` (or were never fetched). */
export async function refreshIfOlderThan(ms: number): Promise<void> {
  const {auth, statuses} = await load();
  if (!auth) return;
  const refreshedAt = statuses && statuses.login === auth.account.login && statuses.refreshedAt;
  if (refreshedAt && Date.now() - Date.parse(refreshedAt) < ms) return;
  await sync();
  await refreshStatuses();
}

/** Shows how many queued pull requests need attention on the toolbar icon. */
export async function updateBadge(): Promise<void> {
  const {auth, hub, statuses} = await load();
  let count = 0;
  if (auth && hub && statuses && statuses.login === auth.account.login) {
    count = hub.queue.filter((e) => {
      const state = statuses.states[prKey(e)];
      return !!state && needsAttention(state);
    }).length;
  }
  if (chrome.action.setBadgeTextColor) await chrome.action.setBadgeTextColor({color: '#ffffff'});
  // GitHub refusing the credentials comes first: statuses can't be trusted
  const problem = auth && statuses && statuses.login === auth.account.login ? statuses.problem : undefined;
  if (problem) {
    await chrome.action.setBadgeBackgroundColor({color: '#d1242f'});
    await chrome.action.setBadgeText({text: '!'});
    await chrome.action.setTitle({title: `TreeHub: ${problem.title}`});
    return;
  }
  await chrome.action.setBadgeBackgroundColor({color: '#0969da'});
  await chrome.action.setBadgeText({text: count ? String(count) : ''});
  await chrome.action.setTitle({
    title: count ? `TreeHub: ${count} pull request${count === 1 ? ' needs' : 's need'} your attention` : 'TreeHub'
  });
}
