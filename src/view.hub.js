const HUB_STORE = {
  AUTH: 'treehub.auth',
  HUB: 'treehub.hub'
};
const HUB_PR_PATH = /^\/[^\/]+\/[^\/]+\/pull\/(\d+)(?:\/|$)/;
const HUB_FLASH_MS = 6000;

/**
 * Bookmark and review queue toggles, the dashboard button and the TreeHub account in the settings.
 *
 * The background worker (app/src/background.ts) signs in and owns the bookmarks and the queue. This view shows
 * them from chrome.storage, which the worker keeps current, and asks the worker to change them. It also tells the
 * worker when a queued pull request is looked at, which settles its replies, mentions and updates.
 */
class HubView {
  constructor($dom) {
    this.repo = null; // "owner/name" of the current repository
    this.pull = null; // {repo, number} of the current pull request
    this.auth = null;
    this.hub = null;
    this._pending = {};

    this.$bookmark = $dom.find('.treehub-bookmark-toggle').hide();
    this.$queue = $dom.find('.treehub-queue-toggle').hide();
    this.$account = $dom.find('.treehub-account');
    this.$flash = $dom.find('.treehub-hub-flash');

    this.$bookmark.click((event) => {
      event.preventDefault();
      this._toggle('bookmark');
    });
    this.$queue.click((event) => {
      event.preventDefault();
      this._toggle('queue');
    });
    $dom.find('.treehub-home').click((event) => {
      event.preventDefault();
      this._openDashboard();
    });
    this.$account
      .on('click', '.treehub-sign-in', () => this._signIn())
      .on('click', '.treehub-open-dashboard', () => this._openDashboard())
      .on('click', '.treehub-sign-out', () => this._signOut());
    this.$flash.click(() => this.$flash.removeClass('visible'));

    $(extStore).on(EVENT.STORE_CHANGE, (event, changes) => {
      if (changes[HUB_STORE.AUTH] || changes[HUB_STORE.HUB]) this._load();
    });
    // Switching tabs: looked at the pull request until now, or looking at it again
    document.addEventListener('visibilitychange', () => this._seen(this.pull));
  }

  async init() {
    await this._load();
  }

  /**
   * Sets the repository of the current page (from the adapter), or null outside repositories.
   */
  setRepo(repo) {
    const previous = this.pull;
    this.repo = repo ? `${repo.username}/${repo.reponame}` : null;
    const match = this.repo && location.pathname.match(HUB_PR_PATH);
    this.pull = match ? {repo: this.repo, number: parseInt(match[1], 10)} : null;

    if (!this._samePull(previous, this.pull)) {
      // Leaving a pull request, e.g. after commenting on it
      this._seen(previous);
      if (document.visibilityState === 'visible') this._seen(this.pull);
    }
    this._render();
  }

  async _load() {
    const auth = await extStore.get(HUB_STORE.AUTH);
    const hub = await extStore.get(HUB_STORE.HUB);
    this.auth = auth || null;
    this.hub = auth && hub && hub.login === auth.account.login ? hub : null;
    this._render();
  }

  _render() {
    const auth = this.auth;
    this.$account.toggleClass('signed-in', !!auth);
    if (auth) {
      const {login, avatarUrl} = auth.account;
      this.$account.find('.treehub-account-login').text(login);
      this.$account
        .find('.treehub-account-avatar')
        .attr('src', avatarUrl ? `${avatarUrl}${avatarUrl.includes('?') ? '&' : '?'}s=40` : '')
        .toggle(!!avatarUrl);
    }

    this._renderToggle(this.$bookmark, !!this.repo, this._isBookmarked(this.repo), {
      on: 'Remove this bookmark',
      off: 'Bookmark this repository',
      signedOut: 'Sign in with GitHub to bookmark this repository'
    });
    this._renderToggle(this.$queue, !!this.pull, this._isQueued(this.pull), {
      on: 'Remove from your review queue',
      off: 'Add to your review queue',
      signedOut: 'Sign in with GitHub to add this pull request to your review queue'
    });
  }

  _renderToggle($toggle, visible, added, labels) {
    const on = !!this.auth && added;
    $toggle.toggle(visible).toggleClass('added', on).attr('aria-pressed', String(on));
    $toggle.find('.tooltipped').attr('aria-label', !this.auth ? labels.signedOut : on ? labels.on : labels.off);
  }

  _isBookmarked(repo) {
    const lower = repo && repo.toLowerCase();
    return !!(lower && this.hub && this.hub.bookmarks.some((bookmark) => bookmark.repo.toLowerCase() === lower));
  }

  _isQueued(pull) {
    return !!(pull && this.hub && this.hub.queue.some((item) => this._samePull(item, pull)));
  }

  _samePull(a, b) {
    return !!a && !!b && a.number === b.number && a.repo.toLowerCase() === b.repo.toLowerCase();
  }

  async _toggle(kind) {
    const target = kind === 'bookmark' ? this.repo : this.pull;
    if (!target || this._pending[kind]) return;

    const $toggle = kind === 'bookmark' ? this.$bookmark : this.$queue;
    this._pending[kind] = true;
    $toggle.addClass('pending');
    try {
      let on;
      if (this.auth) {
        on = kind === 'bookmark' ? !this._isBookmarked(target) : !this._isQueued(target);
      } else {
        await this._send({type: 'treehub:signIn'});
        await this._load();
        on = true; // what the click asked for
      }

      if (kind === 'bookmark') {
        await this._send({type: 'treehub:setBookmark', repo: target, on});
      } else {
        await this._send({
          type: 'treehub:setQueued',
          repo: target.repo,
          number: target.number,
          on,
          title: on ? this._pullTitle() : undefined,
          // Queued while looking at it
          seen: on && document.visibilityState === 'visible'
        });
      }
    } catch (err) {
      this._flash(err.message);
    } finally {
      this._pending[kind] = false;
      $toggle.removeClass('pending');
    }
  }

  /** Title of the pull request of this page, cached by the backend for display. */
  _pullTitle() {
    const heading = $('[data-component="PH_Title"] .markdown-title, .js-issue-title').first().text().trim();
    const fromTitle = (document.title.match(/^(.*) by \S+ · Pull Request #\d+ · /) || [])[1];
    return (heading || fromTitle || '').slice(0, 300) || undefined;
  }

  _seen(pull) {
    if (!this._isQueued(pull)) return;
    this._send({type: 'treehub:seen', repo: pull.repo, number: pull.number}).catch(() => {
      // Not worth bothering: the next visit is recorded too
    });
  }

  async _signIn() {
    const $button = this.$account.find('.treehub-sign-in').prop('disabled', true);
    $button.find('span').text('Waiting for GitHub…');
    try {
      await this._send({type: 'treehub:signIn'});
      await this._load();
    } catch (err) {
      this._flash(err.message);
    } finally {
      $button.prop('disabled', false).find('span').text('Sign in with GitHub');
    }
  }

  async _signOut() {
    try {
      await this._send({type: 'treehub:signOut'});
      await this._load();
    } catch (err) {
      this._flash(err.message);
    }
  }

  _openDashboard() {
    this._send({type: 'treehub:openDashboard'}).catch((err) => this._flash(err.message));
  }

  _flash(message) {
    clearTimeout(this._flashTimer);
    this.$flash.text(message).addClass('visible');
    this._flashTimer = setTimeout(() => this.$flash.removeClass('visible'), HUB_FLASH_MS);
  }

  /** Sends a request (app/src/lib/messages.ts) to the background worker and returns its result. */
  _send(request) {
    return new Promise((resolve, reject) => {
      const noReply = () => reject(new Error('TreeHub did not respond. Please reload this page.'));
      try {
        chrome.runtime.sendMessage(request, (reply) => {
          if (chrome.runtime.lastError || !reply) return noReply();
          if (reply.ok) resolve(reply.result);
          else reject(new Error(reply.error));
        });
      } catch (err) {
        // The extension was reloaded or updated after this page loaded
        reject(new Error('TreeHub was updated. Please reload this page.'));
      }
    });
  }
}
