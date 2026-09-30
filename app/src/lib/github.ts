// GitHub GraphQL requests of the background worker: statuses of queued pull requests and details of bookmarks.
import {GITHUB_API} from '../config.ts';
import {
  QUERY_BATCH_SIZE,
  buildQueueQuery,
  prKey,
  readQueueResult,
  toPRState,
  type PRState,
  type QueueQueryResult
} from './status.ts';
import type {QueueEntry, RepoMeta} from './storage.ts';

export class GitHubError extends Error {
  readonly status: number;
  /** The request and the response headers, to explain the error (lib/credentials.ts). */
  response?: {method: string; url: string; message: string; headers: Record<string, string>};

  constructor(status: number, message: string) {
    super(message);
    this.name = 'GitHubError';
    this.status = status;
  }
}

// Headers GitHub lets browsers read (Access-Control-Expose-Headers) that explain refused requests
const EXPLAINING_HEADERS = [
  'x-ratelimit-limit',
  'x-ratelimit-remaining',
  'x-ratelimit-reset',
  'x-ratelimit-resource',
  'x-oauth-scopes',
  'x-accepted-oauth-scopes',
  'x-github-sso',
  'retry-after'
];

function failure(status: number, message: string, response: Response): GitHubError {
  const error = new GitHubError(status, message);
  const headers: Record<string, string> = {};
  for (const name of EXPLAINING_HEADERS) {
    const value = response.headers.get(name);
    if (value) headers[name] = value;
  }
  error.response = {method: 'POST', url: `${GITHUB_API}/graphql`, message, headers};
  return error;
}

interface GraphQLResult<T> {
  data?: T | null;
  errors?: Array<{message: string; type?: string; path?: Array<string | number>}>;
}

async function graphql<T>(token: string, query: string): Promise<GraphQLResult<T>> {
  let response: Response;
  try {
    response = await fetch(`${GITHUB_API}/graphql`, {
      method: 'POST',
      headers: {Authorization: `bearer ${token}`, 'Content-Type': 'application/json'},
      body: JSON.stringify({query})
    });
  } catch {
    throw new GitHubError(0, 'Cannot reach GitHub. Check your connection and try again.');
  }

  const json: (GraphQLResult<T> & {message?: string}) | null = await response.json().catch(() => null);
  if (response.status === 401) {
    const error = failure(401, 'GitHub rejected the access token. Please sign in again.', response);
    error.response!.message = (json && json.message) || 'Bad credentials';
    throw error;
  }
  if (!response.ok || !json) {
    throw failure(response.status, (json && json.message) || `GitHub failed (HTTP ${response.status}).`, response);
  }
  // Errors of the whole query come without data; others are per alias. GraphQL reports rate limits and
  // refusals (e.g. SAML single sign-on) with HTTP 200: they are told apart as 403s.
  if (!json.data && json.errors && json.errors.length) {
    const [first] = json.errors;
    const refused = first.type === 'RATE_LIMITED' || first.type === 'FORBIDDEN';
    throw failure(refused ? 403 : response.status, first.message, response);
  }
  return json;
}

/** Runs `task` over `items` with at most `limit` running at a time, keeping the order of results. */
async function mapLimit<T, R>(items: T[], limit: number, task: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const index = next++;
      results[index] = await task(items[index]);
    }
  };
  await Promise.all(Array.from({length: Math.min(limit, items.length)}, worker));
  return results;
}

function chunk<T>(items: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let i = 0; i < items.length; i += size) chunks.push(items.slice(i, i + size));
  return chunks;
}

/** Errors that retrying with smaller requests cannot fix. */
function isFatal(err: unknown): boolean {
  return (
    !(err instanceof GitHubError) || err.status === 0 || err.status === 401 || err.status === 403 || /rate limit/i.test(err.message)
  );
}

/** Fetches the queued pull requests and computes their statuses for `me`, by {@link prKey}. */
export async function fetchQueueStates(token: string, entries: QueueEntry[], me: string): Promise<Record<string, PRState>> {
  const now = new Date().toISOString();
  const states: Record<string, PRState> = {};

  const fetchBatch = async (batch: QueueEntry[]): Promise<void> => {
    try {
      const result = await graphql<QueueQueryResult['data']>(token, buildQueueQuery(batch));
      readQueueResult(batch, result as QueueQueryResult).forEach((node, index) => {
        const entry = batch[index];
        states[prKey(entry)] = toPRState(entry, node, {me, lastSeenAt: entry.lastSeenAt}, now);
      });
    } catch (err) {
      if (isFatal(err)) throw err;
      // A big query can time out on GitHub's side: split it, down to single pull requests
      if (batch.length > 1) {
        const half = Math.ceil(batch.length / 2);
        await fetchBatch(batch.slice(0, half));
        await fetchBatch(batch.slice(half));
      } else {
        const entry = batch[0];
        states[prKey(entry)] = toPRState(entry, {error: (err as Error).message}, {me}, now);
      }
    }
  };

  // A few requests at a time: GitHub's secondary rate limits punish bursts
  await mapLimit(chunk(entries, QUERY_BATCH_SIZE), 3, fetchBatch);
  return states;
}

const REPO_FRAGMENT = `
fragment RepoMeta on Repository {
  nameWithOwner
  description
  stargazerCount
  pushedAt
  isPrivate
  isArchived
  primaryLanguage { name color }
  pullRequests(states: OPEN) { totalCount }
  issues(states: OPEN) { totalCount }
}`;

interface RepoNode {
  nameWithOwner: string;
  description: string | null;
  stargazerCount: number;
  pushedAt: string | null;
  isPrivate: boolean;
  isArchived: boolean;
  primaryLanguage: {name: string; color: string | null} | null;
  pullRequests: {totalCount: number};
  issues: {totalCount: number};
}

/** Fetches details of repositories ("owner/name"), by lowercased name. */
export async function fetchRepos(token: string, repos: string[]): Promise<Record<string, RepoMeta>> {
  const now = new Date().toISOString();
  const metas: Record<string, RepoMeta> = {};
  await mapLimit(chunk(repos, 50), 2, async (batch) => {
    const fields = batch.map((repo, index) => {
      const [owner, name] = repo.split('/');
      return `  r${index}: repository(owner: ${JSON.stringify(owner)}, name: ${JSON.stringify(name)}) { ...RepoMeta }`;
    });
    const result = await graphql<Record<string, RepoNode | null>>(
      token,
      `query TreeHubRepos {\n${fields.join('\n')}\n}\n${REPO_FRAGMENT}`
    );
    batch.forEach((repo, index) => {
      const node = result.data && result.data[`r${index}`];
      const error = (result.errors || []).find((e) => e.path && e.path[0] === `r${index}`);
      metas[repo.toLowerCase()] = node
        ? {
            repo: node.nameWithOwner,
            description: node.description,
            stars: node.stargazerCount,
            language: node.primaryLanguage,
            pushedAt: node.pushedAt,
            isPrivate: node.isPrivate,
            isArchived: node.isArchived,
            openPullRequests: node.pullRequests.totalCount,
            openIssues: node.issues.totalCount,
            fetchedAt: now
          }
        : {
            repo,
            description: null,
            stars: 0,
            language: null,
            pushedAt: null,
            isPrivate: false,
            isArchived: false,
            openPullRequests: 0,
            openIssues: 0,
            fetchedAt: now,
            error: error ? error.message : 'Could not load this repository.'
          };
    });
  });
  return metas;
}
