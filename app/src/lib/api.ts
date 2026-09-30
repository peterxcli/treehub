// Client of the TreeHub backend. Messages are defined in server/proto/treehub/v1/api.proto; the server writes
// proto field names (snake_case) with encoding/json, which fromJson accepts.
import {create, fromJson, toJson, type DescMessage, type JsonValue, type MessageShape} from '@bufbuild/protobuf';
import {API_URL} from '../config.ts';
import {
  BookmarkSchema,
  ErrorResponseSchema,
  ListBookmarksResponseSchema,
  ListQueueResponseSchema,
  MeResponseSchema,
  OkResponseSchema,
  PutQueueItemRequestSchema,
  QueueItemSchema,
  type Bookmark,
  type QueueItem,
  type User
} from '../gen/treehub/v1/api_pb.ts';
import type {Account, BookmarkEntry, QueueEntry} from './storage.ts';
import type {PRRef} from './status.ts';

export class ApiError extends Error {
  /** The request, and the server's own message, to explain the error (lib/credentials.ts). */
  request?: {method: string; url: string; serverMessage?: string};

  constructor(
    readonly status: number,
    readonly code: string,
    message: string
  ) {
    super(message);
    this.name = 'ApiError';
  }

  /** The session is missing, expired or was revoked: the user has to sign in again. */
  get isAuthError(): boolean {
    return this.status === 401;
  }
}

async function call<T extends DescMessage>(
  schema: T,
  method: string,
  path: string,
  session: string,
  body?: JsonValue
): Promise<MessageShape<T>> {
  let response: Response;
  try {
    response = await fetch(API_URL + path, {
      method,
      headers: {
        Authorization: `Bearer ${session}`,
        ...(body === undefined ? {} : {'Content-Type': 'application/json'})
      },
      body: body === undefined ? undefined : JSON.stringify(body)
    });
  } catch {
    throw new ApiError(0, 'network', 'Cannot reach the TreeHub server. Check your connection and try again.');
  }

  let json: JsonValue = null;
  try {
    json = await response.json();
  } catch {
    // Not JSON, e.g. an error page of a proxy
  }

  if (!response.ok) {
    const error =
      json && typeof json === 'object' ? fromJson(ErrorResponseSchema, json, {ignoreUnknownFields: true}) : null;
    const code = (error && error.error) || `http_${response.status}`;
    const failure = new ApiError(
      response.status,
      code,
      describe(code) || (error && error.message) || describe(`http_${response.status}`)!
    );
    failure.request = {method, url: API_URL + path, serverMessage: (error && error.message) || undefined};
    throw failure;
  }
  return fromJson(schema, json, {ignoreUnknownFields: true});
}

/** Message of a known error code; HTTP statuses of unknown codes read as `http_<status>`. */
function describe(code: string): string | undefined {
  switch (code) {
    case 'login_required':
      return 'Your TreeHub session expired or was ended. Please sign in again.';
    case 'limit_reached':
      return 'You reached the maximum number of items. Remove some and try again.';
    case 'invalid_repo':
      return 'This is not a valid repository name.';
    case 'invalid_number':
      return 'This is not a valid pull request number.';
    case 'not_found':
      return 'Not found.';
  }
  const status = code.startsWith('http_') && code.slice(5);
  return status ? `The TreeHub server failed (HTTP ${status}). Please try again later.` : undefined;
}

const repoPath = (repo: string) => repo.split('/').map(encodeURIComponent).join('/');
const prPath = (ref: PRRef) => `${repoPath(ref.repo)}/${ref.number}`;

export function toAccount(user: User): Account {
  return {login: user.login, githubId: user.githubId, name: user.name, avatarUrl: user.avatarUrl};
}

export function toBookmarkEntry(bookmark: Bookmark): BookmarkEntry {
  return {repo: bookmark.repo, createdAt: bookmark.createdAt};
}

export function toQueueEntry(item: QueueItem): QueueEntry {
  return {repo: item.repo, number: item.number, title: item.title, addedAt: item.addedAt, lastSeenAt: item.lastSeenAt};
}

export async function getMe(session: string): Promise<Account> {
  const {user} = await call(MeResponseSchema, 'GET', '/api/me', session);
  if (!user) throw new ApiError(500, 'internal', 'The TreeHub server returned no user.');
  return toAccount(user);
}

/** Deletes the user with their bookmarks and queue from the backend. */
export async function deleteAccount(session: string): Promise<void> {
  await call(OkResponseSchema, 'DELETE', '/api/me', session);
}

/** Revokes every session of the user, on all devices. */
export async function logoutAll(session: string): Promise<void> {
  await call(OkResponseSchema, 'POST', '/api/logout-all', session);
}

export async function listBookmarks(session: string): Promise<BookmarkEntry[]> {
  const {bookmarks} = await call(ListBookmarksResponseSchema, 'GET', '/api/bookmarks', session);
  return bookmarks.map(toBookmarkEntry);
}

export async function putBookmark(session: string, repo: string): Promise<BookmarkEntry> {
  return toBookmarkEntry(await call(BookmarkSchema, 'PUT', `/api/bookmarks/${repoPath(repo)}`, session));
}

export async function deleteBookmark(session: string, repo: string): Promise<void> {
  await call(OkResponseSchema, 'DELETE', `/api/bookmarks/${repoPath(repo)}`, session);
}

export async function listQueue(session: string): Promise<QueueEntry[]> {
  const {items} = await call(ListQueueResponseSchema, 'GET', '/api/queue', session);
  return items.map(toQueueEntry);
}

export async function putQueueItem(session: string, ref: PRRef, title?: string): Promise<QueueEntry> {
  const body = toJson(PutQueueItemRequestSchema, create(PutQueueItemRequestSchema, {title}), {useProtoFieldName: true});
  return toQueueEntry(await call(QueueItemSchema, 'PUT', `/api/queue/${prPath(ref)}`, session, body));
}

export async function deleteQueueItem(session: string, ref: PRRef): Promise<void> {
  await call(OkResponseSchema, 'DELETE', `/api/queue/${prPath(ref)}`, session);
}

/** Records that the user just looked at the pull request. */
export async function markSeen(session: string, ref: PRRef): Promise<QueueEntry> {
  return toQueueEntry(await call(QueueItemSchema, 'POST', `/api/queue/${prPath(ref)}/seen`, session));
}
