// Headers GitHub lets browsers read (Access-Control-Expose-Headers) that explain refused requests
const CREDENTIAL_HEADERS = [
  'x-ratelimit-limit',
  'x-ratelimit-remaining',
  'x-ratelimit-reset',
  'x-ratelimit-resource',
  'x-oauth-scopes',
  'x-accepted-oauth-scopes',
  'x-github-sso',
  'retry-after'
];
// A dismissed problem shows again after this time
const CREDENTIAL_DISMISS_MS = 30 * 60 * 1000;
// How often the background worker hears that GitHub accepted a token
const CREDENTIAL_ACCEPTED_MS = 10 * 60 * 1000;

/**
 * Watches the GitHub API responses of TreeHub's requests (all of them go through its jQuery). When GitHub refuses
 * the credentials (401, 403, or 404 for what the page shows, which exists), a popup explains why and how to fix
 * it: an expired or revoked token, a missing scope, no access to the repository, single sign-on, a rate limit...
 * The background worker writes the explanation (app/src/lib/credentials.ts), which also covers the review queue
 * and the TreeHub sign-in (EVENT.CREDENTIAL_PROBLEM).
 */
class CredentialsView {
  constructor() {
    this.$popup = null;
    this._shownKey = null;
    this._queue = [];
    this._dismissed = {};
    this._accepted = {};

    $(document)
      .on('ajaxComplete', (event, jqXHR, settings) => this._onResponse(jqXHR, settings))
      .on(EVENT.CREDENTIAL_PROBLEM, (event, problem) => this.show(problem));
  }

  /**
   * Shows the explanation of a problem, unless it is already shown or was dismissed recently.
   * @param {{key: string, title: string, summary: string, details: !Array, actions: !Array}} problem
   */
  show(problem) {
    if (!problem) return;
    const dismissed = this._dismissed[problem.key];
    if (dismissed && Date.now() - dismissed < CREDENTIAL_DISMISS_MS) return;
    if (this._shownKey === problem.key || this._queue.some((queued) => queued.key === problem.key)) return;
    if (this.$popup) this._queue.push(problem);
    else this._render(problem);
  }

  async _onResponse(jqXHR, settings) {
    const url = settings.url || '';
    if (!url.startsWith('https://api.github.com/')) return;

    const token = ((settings.headers && settings.headers.Authorization) || '').replace(/^(token|bearer)\s+/i, '');
    const json = jqXHR.status >= 400 ? errorJson(jqXHR) : jqXHR.responseJSON;
    // GraphQL refuses with HTTP 200: rate limits and SAML single sign-on
    const refusal = jqXHR.status === 200 && json && json.errors &&
      json.errors.find((error) => error.type === 'RATE_LIMITED' || error.type === 'FORBIDDEN');
    const status = refusal ? 403 : jqXHR.status;

    if (status >= 200 && status < 300) {
      if (token) this._reportAccepted(token, jqXHR.getResponseHeader('X-OAuth-Scopes'));
      return;
    }
    if (status !== 401 && status !== 403 && !(status === 404 && this._pageShows(settings))) return;
    // A tree of a repository the token can read: no such branch, tag or commit, rather than no access
    if (status === 404 && new URL(url).pathname.includes('/git/trees/') && (await this._canRead(url, token))) return;

    const headers = {};
    for (const name of CREDENTIAL_HEADERS) {
      const value = jqXHR.getResponseHeader(name);
      if (value) headers[name] = value;
    }
    const response = {
      service: 'github',
      status,
      method: (settings.type || settings.method || 'GET').toUpperCase(),
      url,
      message: refusal ? refusal.message : json && json.message,
      headers
    };
    const source = await this._sourceOf(token);
    const problem = await sendToBackground({type: 'treehub:explainCredentials', response, source}).catch(() => null);
    this.show(problem);
  }

  /**
   * Whether the request is for the repository of the page, or its pull request: they exist since GitHub shows
   * them, so GitHub answering 404 means that the token has no access (GitHub hides private resources this way).
   */
  _pageShows(settings) {
    if ((settings.type || settings.method || 'GET').toUpperCase() !== 'GET') return false;
    const path = new URL(settings.url).pathname;
    const match = path.match(/^\/repos\/([^/]+)\/([^/]+)(\/.*)?$/);
    if (!match) return false;

    const [, owner, name, rest = ''] = match;
    const [, pageOwner = '', pageName = ''] = location.pathname.split('/');
    const samePage = pageOwner.toLowerCase() === owner.toLowerCase() && pageName.toLowerCase() === name.toLowerCase();
    return samePage && (rest === '' || /^\/pulls\/\d+(\/files)?$/.test(rest) || rest.startsWith('/git/trees/'));
  }

  /** Whether GitHub lets the token (or no token) read the repository of an API URL. */
  async _canRead(url, token) {
    const [repoUrl] = url.match(/^https:\/\/api\.github\.com\/repos\/[^/]+\/[^/]+/) || [];
    if (!repoUrl) return false;
    try {
      return (await fetch(repoUrl, {headers: token ? {Authorization: `token ${token}`} : {}})).ok;
    } catch (err) {
      return false;
    }
  }

  async _sourceOf(token) {
    if (!token) return 'none';
    return token === (await extStore.get(STORE.TOKEN)) ? 'settings' : 'signin';
  }

  /** Tells the background worker (now and then) that GitHub accepted a token, to tell when it stops. */
  async _reportAccepted(token, scopes) {
    const key = token.slice(-8);
    if (Date.now() - (this._accepted[key] || 0) < CREDENTIAL_ACCEPTED_MS) return;
    this._accepted[key] = Date.now();
    const source = await this._sourceOf(token);
    sendToBackground({type: 'treehub:tokenAccepted', source, scopes: scopes || undefined}).catch(() => {});
  }

  _render(problem) {
    this._shownKey = problem.key;

    const details = problem.details
      .map((detail) => {
        const value = detail.href
          ? `<a href="${escapeHtml(detail.href)}" target="_blank" rel="noopener">${escapeHtml(detail.value)}</a>`
          : escapeHtml(detail.value);
        return `<dt>${escapeHtml(detail.label)}</dt><dd>${value}</dd>`;
      })
      .join('');
    const actions = problem.actions
      .map((action, index) => {
        const classes = `btn btn-sm${index === 0 ? ' btn-primary' : ''}`;
        return action.href
          ? `<a class="${classes}" href="${escapeHtml(action.href)}" target="_blank" rel="noopener">` +
            `${escapeHtml(action.label)}</a>`
          : `<button type="button" class="${classes}" data-action="${escapeHtml(action.action)}">` +
            `${escapeHtml(action.label)}</button>`;
      })
      .join('');

    this.$popup = $(
      '<section class="treehub-cred" role="alertdialog" aria-labelledby="treehub-cred-title" ' +
      'aria-describedby="treehub-cred-summary">' +
      `<header>${octicon('alert')}<h2 id="treehub-cred-title"></h2><span class="treehub-cred-by">TreeHub</span>` +
      `<button type="button" class="treehub-cred-close" aria-label="Dismiss">${octicon('x')}</button></header>` +
      '<p id="treehub-cred-summary" class="treehub-cred-summary"></p>' +
      `<dl class="treehub-cred-details">${details}</dl>` +
      `<div class="treehub-cred-actions">${actions}` +
      '<button type="button" class="btn btn-sm treehub-cred-dismiss">Dismiss</button></div>' +
      '</section>'
    );
    this.$popup.find('h2').text(problem.title);
    this.$popup.find('.treehub-cred-summary').text(problem.summary);
    this.$popup
      .on('click', '.treehub-cred-close, .treehub-cred-dismiss', () => this._dismiss())
      .on('click', '[data-action="settings"]', () => {
        this._dismiss();
        $(document).trigger(EVENT.OPEN_SETTINGS);
      })
      .on('click', '[data-action="signIn"]', (event) => this._signIn($(event.currentTarget)))
      .appendTo(document.body);
  }

  async _signIn($button) {
    const label = $button.text();
    $button.prop('disabled', true).text('Waiting for GitHub…');
    try {
      await sendToBackground({type: 'treehub:signIn'});
      this._close();
      // Load again with the new token
      $(document).trigger(EVENT.LOC_CHANGE, true);
    } catch (err) {
      $button.prop('disabled', false).text(label);
      if (this.$popup) this.$popup.find('.treehub-cred-summary').text(err.message);
    }
  }

  _dismiss() {
    if (this._shownKey) this._dismissed[this._shownKey] = Date.now();
    this._close();
  }

  _close() {
    if (this.$popup) this.$popup.remove();
    this.$popup = null;
    this._shownKey = null;
    const next = this._queue.shift();
    if (next) this.show(next);
  }
}
