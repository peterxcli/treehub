// State shared by the background worker, the dashboard and the content script, kept in chrome.storage.local.
// Only the background worker writes it; the others read it and follow chrome.storage.onChanged.
// Keys start with "treehub." so the content script's store (src/core.storage.js) sees their changes.
import type {CredentialProblem} from './credentials.ts';
import type {PRState} from './status.ts';

export const KEYS = {
  /** {@link Auth} of the signed-in user. */
  auth: 'treehub.auth',
  /** {@link Hub}: the user's bookmarks and review queue, as stored by the backend. */
  hub: 'treehub.hub',
  /** {@link Statuses}: computed statuses of the queued pull requests. */
  statuses: 'treehub.queue_state',
  /** {@link RepoCache}: GitHub details of bookmarked repositories. */
  repos: 'treehub.repo_meta',
  /** Why the user was signed out, e.g. an expired session: a {@link CredentialProblem}. */
  signinProblem: 'treehub.signin_problem',
  /** {@link TokenSeen}: when GitHub last accepted each token. */
  tokenSeen: 'treehub.token_seen',
  /** Personal access token entered in the sidebar settings (src/core.constants.js). */
  token: 'treehub.token'
} as const;

export interface Account {
  login: string;
  githubId: string;
  name?: string;
  avatarUrl?: string;
}

export interface Auth {
  /** TreeHub session (JWT) sent to the backend. */
  session: string;
  /** GitHub OAuth token (repo scope), kept only in this browser. Absent with the dev sign-in. */
  githubToken?: string;
  account: Account;
  signedInAt: string;
}

export interface BookmarkEntry {
  repo: string; // "owner/name"
  createdAt: string;
}

export interface QueueEntry {
  repo: string; // "owner/name"
  number: number;
  title?: string;
  addedAt: string;
  lastSeenAt?: string;
}

export interface Hub {
  login: string;
  bookmarks: BookmarkEntry[]; // newest first
  queue: QueueEntry[]; // newest first
  syncedAt: string;
}

export interface Statuses {
  login: string;
  /** By {@link prKey}. */
  states: Record<string, PRState>;
  refreshedAt?: string;
  /** Why the last refresh failed, e.g. an expired GitHub token. */
  error?: string;
  /** Explanation of the failure when GitHub refused the credentials. */
  problem?: CredentialProblem;
}

/** By token fingerprint (lib/credentials.ts): when GitHub last accepted the token, and its scopes then. */
export type TokenSeen = Record<string, {at: string; scopes?: string}>;

export interface RepoMeta {
  repo: string; // "owner/name" as GitHub spells it
  description: string | null;
  stars: number;
  language: {name: string; color: string | null} | null;
  pushedAt: string | null;
  isPrivate: boolean;
  isArchived: boolean;
  openPullRequests: number;
  openIssues: number;
  fetchedAt: string;
  error?: string;
}

export interface RepoCache {
  /** By lowercased "owner/name". */
  repos: Record<string, RepoMeta>;
}

export interface State {
  auth?: Auth;
  hub?: Hub;
  statuses?: Statuses;
  repos?: RepoCache;
  signinProblem?: CredentialProblem;
}

const NAMES = {
  auth: KEYS.auth,
  hub: KEYS.hub,
  statuses: KEYS.statuses,
  repos: KEYS.repos,
  signinProblem: KEYS.signinProblem
} as const;

export async function load(): Promise<State> {
  const values = await chrome.storage.local.get(Object.values(NAMES));
  return {
    auth: values[KEYS.auth] as Auth | undefined,
    hub: values[KEYS.hub] as Hub | undefined,
    statuses: values[KEYS.statuses] as Statuses | undefined,
    repos: values[KEYS.repos] as RepoCache | undefined,
    signinProblem: values[KEYS.signinProblem] as CredentialProblem | undefined
  };
}

export async function save(changes: Partial<{[K in keyof State]: State[K] | null}>): Promise<void> {
  const set: Record<string, unknown> = {};
  const remove: string[] = [];
  for (const [name, value] of Object.entries(changes)) {
    const key = NAMES[name as keyof typeof NAMES];
    if (value == null) remove.push(key);
    else set[key] = value;
  }
  if (remove.length) await chrome.storage.local.remove(remove);
  if (Object.keys(set).length) await chrome.storage.local.set(set);
}

/** The personal access token from the sidebar settings, used when there is no OAuth token (dev sign-in). */
export async function personalToken(): Promise<string | undefined> {
  const values = await chrome.storage.local.get(KEYS.token);
  return (values[KEYS.token] as string | undefined) || undefined;
}

/** Calls `listener` with the new state whenever one of the keys changes. */
export function subscribe(listener: (changes: Partial<State>) => void): () => void {
  const byKey = Object.fromEntries(Object.entries(NAMES).map(([name, key]) => [key, name]));
  const onChanged = (changes: Record<string, chrome.storage.StorageChange>, area: string) => {
    if (area !== 'local') return;
    const update: Record<string, unknown> = {};
    for (const [key, change] of Object.entries(changes)) {
      if (byKey[key]) update[byKey[key]] = change.newValue;
    }
    if (Object.keys(update).length) listener(update as Partial<State>);
  };
  chrome.storage.onChanged.addListener(onChanged);
  return () => chrome.storage.onChanged.removeListener(onChanged);
}
