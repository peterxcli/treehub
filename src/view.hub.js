const HUB_STORE = {
  AUTH: 'treehub.auth',
  HUB: 'treehub.hub',
  // Why the user was signed out without asking, e.g. an expired session (app/src/lib/credentials.ts)
  SIGNIN_PROBLEM: 'treehub.signin_problem'
};
const HUB_PR_PATH = /^\/[^\/]+\/[^\/]+\/pull\/(\d+)(?:\/|$)/;
const HUB_FLASH_MS = 6000;
// A message with an action stays longer
const HUB_FLASH_ACTION_MS = 12000;

/**
 * Bookmark and review queue toggles, the dashboard button and the TreeHub account in the settings.
 *
 * The background worker (app/src/background.ts) signs in and owns the bookmarks and the queue. This view shows
 * them from chrome.storage, which the worker keeps current, and asks the worker to change them. It also tells the
 * worker when a queued pull request is looked at, which settles its replies, mentions and updates, and which
 * repositories and pull requests the user opens, for their history. When the user was signed out without asking
 * (e.g. the session expired), a notice in the sidebar says so. Bookmarking a repository or queueing a pull request
 * offers to add a note to it. A pull request the user comments on joins the queue (view.comment-watch.js), unless
 * switched off in the settings.
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
    this.$signinNotice = $dom.find('.treehub-signin-notice');
    this.$notePrompt = $dom.find('.treehub-note-prompt');
    this.$noteText = this.$notePrompt.find('textarea');
    this._noteTarget = null;
    this._autoQueue = true;
    this._comments = new CommentWatch({
      active: (pull) => !!this.auth && !!this.hub && this._autoQueue && !this._isQueued(pull),
      check: (pull, since) => this._queueIfCommented(pull, since)
    });

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
    this.$notePrompt
      .on('submit', (event) => {
        event.preventDefault();
        this._saveNote();
      })
      .on('click', '.treehub-note-prompt-skip', () => this._closeNotePrompt())
      .on('keydown', 'textarea', (event) => {
        // Not GitHub's keyboard shortcuts
        event.stopPropagation();
        if (event.key === 'Escape') this._closeNotePrompt();
        else if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) this._saveNote();
      })
      // Leaving it without writing anything
      .on('focusout', () => {
        setTimeout(() => {
          const inside = this.$notePrompt[0].contains(document.activeElement);
          if (!inside && !this.$noteText.val().trim()) this._closeNotePrompt();
        });
      });
    this.$signinNotice
      .on('click', '.treehub-signin-notice-signin', (event) => this._signInAgain($(event.currentTarget)))
      .on('click', '.treehub-signin-notice-dismiss', () => {
        this._send({type: 'treehub:dismissSigninProblem'}).catch(() => {});
      });

    // The sidebar closing with nothing written skips the note
    $(document).on(EVENT.TOGGLE, (event, visible) => {
      if (!visible && this._noteTarget && !this.$noteText.val().trim()) this._closeNotePrompt();
    });
    $(extStore).on(EVENT.STORE_CHANGE, (event, changes) => {
      const keys = [HUB_STORE.AUTH, HUB_STORE.HUB, HUB_STORE.SIGNIN_PROBLEM, STORE.AUTO_QUEUE];
      if (keys.some((key) => changes[key])) this._load();
    });
    // Switching tabs: looked at the pull request until now, or looking at it again
    document.addEventListener('visibilitychange', () => {
      this._seen(this.pull);
      if (document.visibilityState === 'visible') this._recordView();
      else this._comments.leave();
    });
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
      this._comments.setPull(this.pull);
    }
    this._recordView();
    this._render();
  }

  /**
   * Adds the pull request, or else the repository, of the page to the user's history (when signed in and the page
   * is shown). The worker skips pages viewed again just now.
   */
  _recordView() {
    if (!this.auth || !this.repo || document.visibilityState !== 'visible') return;
    const view = this.pull
      ? {kind: 'pull', repo: this.pull.repo, number: this.pull.number, title: this._pullTitle()}
      : {kind: 'repo', repo: this.repo};
    this._send(Object.assign({type: 'treehub:recordView'}, view)).catch(() => {
      // Not worth bothering: the next view is recorded
    });
  }

  async _load() {
    const auth = await extStore.get(HUB_STORE.AUTH);
    const hub = await extStore.get(HUB_STORE.HUB);
    const signinProblem = await extStore.get(HUB_STORE.SIGNIN_PROBLEM);
    this._autoQueue = (await extStore.get(STORE.AUTO_QUEUE)) !== false;
    const signedIn = !this.auth && auth;
    const wasQueued = this._isQueued(this.pull);
    this.auth = auth || null;
    this.hub = auth && hub && hub.login === auth.account.login ? hub : null;
    this.signinProblem = !auth && signinProblem ? signinProblem : null;
    // Removed from the queue: only comments from now on add it again
    if (wasQueued && !this._isQueued(this.pull)) this._comments.restart();
    this._render();
    // Signed in on this page: it counts as viewed
    if (signedIn) this._recordView();
  }

  _render() {
    const auth = this.auth;
    const problem = this.signinProblem;
    this.$signinNotice.prop('hidden', !problem);
    if (problem) {
      this.$signinNotice.find('.treehub-signin-notice-title').text(problem.title);
      this.$signinNotice.find('.treehub-signin-notice-text').text(
        `${problem.summary} Until then, TreeHub doesn't record your history, bookmarks or review queue.`
      );
    }
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
      if (on) this._openNotePrompt(kind === 'bookmark' ? {repo: target} : target);
      else if (this._noteTarget && this._sameTarget(this._noteTarget, kind === 'bookmark' ? {repo: target} : target)) {
        this._closeNotePrompt();
      }
    } catch (err) {
      this._fail(err);
    } finally {
      this._pending[kind] = false;
      $toggle.removeClass('pending');
    }
  }

  /** Offers to add a note to what was just bookmarked ({repo}) or queued ({repo, number}). */
  _openNotePrompt(target) {
    this._noteTarget = target;
    this.$notePrompt
      .find('.treehub-note-prompt-title')
      .text(target.number ? `Added #${target.number} to your review queue` : `Bookmarked ${target.repo}`);
    this.$noteText.val('').prop('disabled', false);
    this.$notePrompt.prop('hidden', false).find('button').prop('disabled', false);
    this.$noteText.focus();
  }

  _closeNotePrompt() {
    this._noteTarget = null;
    this.$notePrompt.prop('hidden', true);
  }

  async _saveNote() {
    const target = this._noteTarget;
    const note = this.$noteText.val().trim();
    if (!target) return;
    if (!note) return this._closeNotePrompt();
    this.$notePrompt.find('button').prop('disabled', true);
    try {
      await this._send(Object.assign({type: 'treehub:setNote', note}, target));
      if (this._noteTarget === target) this._closeNotePrompt();
    } catch (err) {
      this.$notePrompt.find('button').prop('disabled', false);
      this._fail(err);
    }
  }

  _sameTarget(a, b) {
    return a.number ? this._samePull(a, b) : !b.number && a.repo.toLowerCase() === b.repo.toLowerCase();
  }

  /**
   * Queues the pull request if the user commented on it since `since` (view.comment-watch.js), and says so when it
   * is the one of the page. Resolves whether it queued it.
   */
  async _queueIfCommented(pull, since) {
    const queued = await this._send({type: 'treehub:queueIfCommented', repo: pull.repo, number: pull.number, since});
    if (queued && this._samePull(pull, this.pull)) {
      this._flash('Added to your review queue: you commented on it.', {
        info: true,
        action: {label: 'Add a note', run: () => this._openNotePrompt(pull)}
      });
    }
    return !!queued;
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
      this._fail(err);
    } finally {
      $button.prop('disabled', false).find('span').text('Sign in with GitHub');
    }
  }

  async _signInAgain($button) {
    $button.prop('disabled', true).text('Waiting for GitHub…');
    try {
      await this._send({type: 'treehub:signIn'});
      await this._load();
    } catch (err) {
      this._fail(err);
    } finally {
      $button.prop('disabled', false).text('Sign in again');
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
    this._send({type: 'treehub:openDashboard'}).catch((err) => this._fail(err));
  }

  /** Explains refused credentials (e.g. an expired TreeHub session) in a popup, other errors in a flash. */
  _fail(err) {
    if (err.problem) $(document).trigger(EVENT.CREDENTIAL_PROBLEM, [err.problem]);
    else this._flash(err.message);
  }

  /** Shows a message at the top of the sidebar: an error, or else `info`, with an optional {label, run} action. */
  _flash(message, {info = false, action = null} = {}) {
    clearTimeout(this._flashTimer);
    this.$flash.empty().toggleClass('info', info).append($('<span>').text(message));
    if (action) {
      const $action = $('<button type="button" class="btn-link treehub-hub-flash-action">').text(action.label);
      $action.on('click', (event) => {
        event.stopPropagation();
        this.$flash.removeClass('visible');
        action.run();
      });
      this.$flash.append(' ', $action);
    }
    this.$flash.addClass('visible');
    const duration = action ? HUB_FLASH_ACTION_MS : HUB_FLASH_MS;
    this._flashTimer = setTimeout(() => this.$flash.removeClass('visible'), duration);
  }

  _send(request) {
    return sendToBackground(request);
  }
}
