// Messages that the dashboard and the content script (src/view.hub.js) send to the background worker with
// chrome.runtime.sendMessage. The worker answers every request with a Reply.

export type Request =
  | {type: 'treehub:signIn'; devLogin?: string}
  | {type: 'treehub:signOut'; everywhere?: boolean}
  | {type: 'treehub:deleteAccount'}
  | {type: 'treehub:sync'}
  | {type: 'treehub:refresh'; ifOlderThanMs?: number}
  | {type: 'treehub:refreshRepos'; force?: boolean}
  | {type: 'treehub:setBookmark'; repo: string; on: boolean}
  | {type: 'treehub:setQueued'; repo: string; number: number; on: boolean; title?: string; seen?: boolean}
  | {type: 'treehub:seen'; repo: string; number: number; force?: boolean}
  | {type: 'treehub:openDashboard'; view?: 'queue' | 'bookmarks'};

export type Reply<T = unknown> = {ok: true; result: T} | {ok: false; error: string; code?: string};

export class RequestError extends Error {
  constructor(
    message: string,
    readonly code?: string
  ) {
    super(message);
    this.name = 'RequestError';
  }
}

/** Sends a request to the background worker and returns its result, or throws its error. */
export async function send<T = unknown>(request: Request): Promise<T> {
  const reply: Reply<T> | undefined = await chrome.runtime.sendMessage(request);
  if (!reply) throw new RequestError('TreeHub did not respond. Please reload the page.');
  if (!reply.ok) throw new RequestError(reply.error, reply.code);
  return reply.result;
}
