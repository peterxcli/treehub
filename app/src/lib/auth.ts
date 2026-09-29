// Sign-in with GitHub through the TreeHub backend (an OAuth App whose secret stays on the server).
// The backend redirects back to https://<extension id>.chromiumapp.org/github with the TreeHub session and the
// GitHub token in the URL fragment; chrome.identity hands that URL to us without loading it.
import {API_URL} from '../config.ts';
import {getMe} from './api.ts';
import type {Auth} from './storage.ts';

export class AuthError extends Error {
  constructor(
    readonly code: string,
    message: string
  ) {
    super(message);
    this.name = 'AuthError';
  }
}

const MESSAGES: Record<string, string> = {
  access_denied: 'You cancelled the authorization on GitHub.',
  exchange: 'GitHub did not complete the sign-in. Please try again.',
  user: 'TreeHub could not read your GitHub profile. Please try again.',
  internal: 'The TreeHub server failed. Please try again later.'
};

/** Random URL-safe string that ties the redirect to this sign-in attempt. */
function createNonce(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(24));
  return btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

/**
 * Opens the GitHub authorization window and returns the new session.
 * @param devLogin sign in as this handle without GitHub (only when the backend has DEV_AUTH=true)
 */
export async function signIn(devLogin?: string): Promise<Auth> {
  const nonce = createNonce();
  const params = new URLSearchParams({ext: chrome.runtime.id, nonce});
  if (devLogin) params.set('login', devLogin);
  const url = `${API_URL}${devLogin === undefined ? '/auth/github/start' : '/auth/dev-login'}?${params}`;

  let redirect: string | undefined;
  try {
    redirect = await chrome.identity.launchWebAuthFlow({url, interactive: true});
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    // Closing the window rejects with "The user did not approve access."
    if (/did not approve/i.test(message)) throw new AuthError('cancelled', 'Sign-in was cancelled.');
    throw new AuthError('flow', `Sign-in failed: ${message}`);
  }
  if (!redirect) throw new AuthError('cancelled', 'Sign-in was cancelled.');

  const fragment = new URLSearchParams(new URL(redirect).hash.slice(1));
  if (fragment.get('nonce') !== nonce) {
    throw new AuthError('state', 'Sign-in failed because the response did not match the request. Please try again.');
  }
  const error = fragment.get('error');
  if (error) throw new AuthError(error, MESSAGES[error] || `Sign-in failed (${error}).`);

  const session = fragment.get('session');
  if (!session) throw new AuthError('session', 'Sign-in failed: the TreeHub server returned no session.');

  return {
    session,
    githubToken: fragment.get('github_token') || undefined,
    account: await getMe(session),
    signedInAt: new Date().toISOString()
  };
}
