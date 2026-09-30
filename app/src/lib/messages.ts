// Messages that the dashboard and the content script (src/view.hub.js, src/view.credentials.js) send to the
// background worker with chrome.runtime.sendMessage. The worker answers every request with a Reply.
import type {CredentialProblem, ResponseInfo} from './credentials.ts';

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
  | {type: 'treehub:openDashboard'; view?: 'queue' | 'bookmarks'}
  | {type: 'treehub:explainCredentials'; response: ResponseInfo; source: 'settings' | 'signin' | 'none'}
  | {type: 'treehub:tokenAccepted'; source: 'settings' | 'signin'; scopes?: string}
  | {type: 'treehub:dismissSigninProblem'}
  | {type: 'treehub:recordView'; kind: 'repo' | 'pull'; repo: string; number?: number; title?: string}
  | {type: 'treehub:listHistory'; limit?: number; cursor?: string; kind?: 'repo' | 'pull'}
  | {type: 'treehub:deleteHistoryEntry'; kind: 'repo' | 'pull'; repo: string; number?: number}
  | {type: 'treehub:clearHistory'}
  | {type: 'treehub:getHistorySettings'}
  | {type: 'treehub:setHistorySettings'; retentionDays: number; paused: boolean};

export type Reply<T = unknown> =
  | {ok: true; result: T}
  | {ok: false; error: string; code?: string; problem?: CredentialProblem};

export class RequestError extends Error {
  constructor(
    message: string,
    readonly code?: string,
    /** Set when the request failed because of the credentials. */
    readonly problem?: CredentialProblem
  ) {
    super(message);
    this.name = 'RequestError';
  }
}

/** Sends a request to the background worker and returns its result, or throws its error. */
export async function send<T = unknown>(request: Request): Promise<T> {
  const reply: Reply<T> | undefined = await chrome.runtime.sendMessage(request);
  if (!reply) throw new RequestError('TreeHub did not respond. Please reload the page.');
  if (!reply.ok) throw new RequestError(reply.error, reply.code, reply.problem);
  return reply.result;
}
