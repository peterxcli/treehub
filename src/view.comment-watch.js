// After a comment seems posted, when to ask whether it was: soon, then again in case GitHub was slow
const COMMENT_CHECK_DELAYS_MS = [2000, 8000];
// How often to look whether the comment boxes typed in were emptied or closed, as posting does
const COMMENT_FIELD_POLL_MS = 1000;
// Comments count from a little before the pull request was opened: the browser's clock may be ahead of GitHub's
const COMMENT_CLOCK_MARGIN_MS = 30 * 1000;

/**
 * Notices when the user may have commented on the pull request of the page, for the review queue to add it
 * (view.hub.js). The user types in a comment box (a textarea outside the sidebar, e.g. GitHub's or the "View full"
 * dialog's), then posts: submits a form with a comment box (a comment, a reply, a review), presses Cmd/Ctrl+Enter,
 * or the box gets emptied or closed. Then, or when the user leaves the pull request after typing, `check` asks
 * GitHub whether the user commented since they opened it. What the user types is never read.
 */
class CommentWatch {
  /**
   * @param {object} options
   * @param {(pull: {repo: string, number: number}) => boolean} options.active whether comments on the pull request
   *     can queue it (signed in, enabled, not queued)
   * @param {(pull: {repo: string, number: number}, since: string) => Promise<boolean>} options.check asks whether
   *     the user commented since `since`, and queues the pull request if so: resolves true then
   */
  constructor({active, check}) {
    this._active = active;
    this._check = check;
    this._state = null;
    document.addEventListener('input', (event) => this._onInput(event), true);
    document.addEventListener('submit', (event) => this._onSubmit(event), true);
    document.addEventListener('keydown', (event) => this._onKeydown(event), true);
  }

  /**
   * Watches the pull request of the page ({repo, number}, or null), after a last look at the previous one (whose
   * checks still run).
   */
  setPull(pull) {
    this.leave();
    if (this._state) this._stopPoll(this._state);
    this._watch(pull, COMMENT_CLOCK_MARGIN_MS);
  }

  /** Only comments from now on count, e.g. after the user removed the pull request from the queue. */
  restart() {
    const state = this._state;
    if (!state) return;
    clearTimeout(state.timer);
    state.cancelled = true;
    this._stopPoll(state);
    // Strictly from now on: earlier comments were there when the user removed it
    this._watch(state.pull, 0);
  }

  /** The user leaves the pull request or the tab: checks if they typed or posted since the last check. */
  leave() {
    const state = this._state;
    if (state && state.dirty) this._run(state, true);
  }

  _watch(pull, margin) {
    if (!pull) return (this._state = null);
    const since = new Date(Date.now() - margin).toISOString();
    this._state = {pull, since, dirty: false, fields: [], timer: null, poll: null};
  }

  _stopPoll(state) {
    clearInterval(state.poll);
    state.poll = null;
  }

  _isCommentBox(element) {
    return element instanceof HTMLTextAreaElement && !element.closest('.treehub-sidebar');
  }

  /** The state of the page's pull request when comments on it can queue it. */
  _watched() {
    const state = this._state;
    return state && this._active(state.pull) ? state : null;
  }

  _onInput(event) {
    const state = this._isCommentBox(event.target) && this._watched();
    if (!state) return;
    state.dirty = true;
    if (!state.fields.includes(event.target)) state.fields.push(event.target);
    if (!state.poll) state.poll = setInterval(() => this._pollFields(state), COMMENT_FIELD_POLL_MS);
  }

  _pollFields(state) {
    const done = state.fields.filter((field) => !field.isConnected || !field.value.trim());
    if (!done.length) return;
    state.fields = state.fields.filter((field) => !done.includes(field));
    if (!state.fields.length) this._stopPoll(state);
    this._schedule(state);
  }

  // Forms with a comment box: comments, replies, reviews (even with an empty summary)
  _onSubmit(event) {
    const form = event.target;
    if (!(form instanceof HTMLFormElement) || form.closest('.treehub-sidebar') || !form.querySelector('textarea')) {
      return;
    }
    const state = this._watched();
    if (state) this._schedule(state);
  }

  _onKeydown(event) {
    if (event.key !== 'Enter' || !(event.metaKey || event.ctrlKey) || !this._isCommentBox(event.target)) return;
    const state = this._watched();
    if (state) this._schedule(state);
  }

  _schedule(state) {
    state.dirty = true;
    clearTimeout(state.timer);
    state.timer = setTimeout(() => this._run(state, false, 0), COMMENT_CHECK_DELAYS_MS[0]);
  }

  async _run(state, leaving, attempt = 0) {
    clearTimeout(state.timer);
    if (state.checking || state.cancelled || !this._active(state.pull)) return;
    state.checking = true;
    state.dirty = false;
    let queued = false;
    try {
      queued = await this._check(state.pull, state.since);
    } catch (err) {
      // Best effort: posting again or leaving the page asks again
      state.dirty = true;
    } finally {
      state.checking = false;
    }
    if (queued) {
      state.fields = [];
      return this._stopPoll(state);
    }
    const next = COMMENT_CHECK_DELAYS_MS[attempt + 1];
    if (leaving || !next || state.cancelled) return;
    state.timer = setTimeout(() => this._run(state, false, attempt + 1), next - COMMENT_CHECK_DELAYS_MS[attempt]);
  }
}
