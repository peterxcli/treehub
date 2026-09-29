const PR_NAV_FILTERS = [
  {id: 'all', label: 'All open pull requests', query: ''},
  {id: 'no-reviews', label: 'No reviews', query: 'review:none'},
  {id: 'review-requested', label: 'Awaiting review from you', query: 'review-requested:@me', needsToken: true},
  {id: 'reviewed', label: 'Reviewed by you', query: 'reviewed-by:@me', needsToken: true},
  {id: 'changes-requested', label: 'Changes requested', query: 'review:changes_requested'},
  {id: 'review-required', label: 'Review required', query: 'review:required'},
  {id: 'approved', label: 'Approved review', query: 'review:approved'}
];
const PR_NAV_CACHE_TTL = 60 * 1000;
// Errors whose message is built by Adapter._handleError()
const PR_NAV_KNOWN_ERRORS = [0, 401, 403, 404];

/**
 * Popup listing the open pull requests of the current repository, with review filters.
 */
class PullRequestNavView {
  constructor($dom, adapter) {
    this.adapter = adapter;
    this.repo = null;
    this._cache = {};
    this._requestId = 0;

    this.$toggler = $dom.find('.treehub-pr-nav-toggle').hide();
    this.$view = $dom.find('.treehub-pr-nav');
    this.$filter = this.$view.find('.treehub-pr-nav-filter');
    this.$menu = this.$view.find('.treehub-pr-nav-menu');
    this.$list = this.$view.find('.treehub-pr-nav-list');

    this.$menu.html(
      PR_NAV_FILTERS.map(
        (filter) =>
          `<li><button type="button" role="menuitemradio" data-filter="${filter.id}">${filter.label}</button></li>`
      ).join('')
    );

    this.$toggler.click((event) => {
      event.preventDefault();
      this.toggle();
    });
    this.$filter.click(() => this.$menu.toggleClass('open'));
    this.$view.find('.treehub-pr-nav-close').click(() => this.toggle(false));
    this.$view.on('click', (event) => {
      if (!$(event.target).closest(this.$filter).length) this.$menu.removeClass('open');
    });
    this.$menu.on('click', '[data-filter]', (event) => this._setFilter($(event.currentTarget).attr('data-filter')));
    this.$list
      .on('click', '.treehub-pr-nav-item', () => this.toggle(false))
      .on('click', '.treehub-pr-nav-more', () => this._load(this._page + 1))
      .on('click', '.settings-btn', (event) => {
        event.preventDefault();
        this.toggle(false);
        $(this).trigger(EVENT.VIEW_CLOSE, {showSettings: true});
      });

    $(document)
      .on('click', (event) => {
        const $target = $(event.target);
        if (this.isOpen && !$target.closest(this.$view).length && !$target.closest(this.$toggler).length) {
          this.toggle(false);
        }
      })
      .on('keydown', (event) => {
        if (event.key === 'Escape' && this.isOpen) this.toggle(false);
      })
      .on(EVENT.TOGGLE, (event, visible) => {
        if (!visible) this.toggle(false);
      });
  }

  get isOpen() {
    return this.$view.hasClass('open');
  }

  /**
   * Sets the repository whose pull requests are listed, or null to hide the button.
   */
  setRepo(repo) {
    const key = repo ? `${repo.username}/${repo.reponame}` : null;
    if (key !== this._repoKey) {
      this._repoKey = key;
      this._cache = {};
      this.toggle(false);
    }
    this.repo = repo;
    this.$toggler.toggle(!!repo);
  }

  async toggle(visible = !this.isOpen) {
    if (visible === this.isOpen || (visible && !this.repo)) return;

    this.$view.toggleClass('open', visible);
    this.$toggler.toggleClass('selected', visible);
    this.$menu.removeClass('open');

    if (visible) {
      this._filterId = await extStore.get(STORE.PR_FILTER);
      await this._load(1);
    }
  }

  async _setFilter(id) {
    this.$menu.removeClass('open');
    this._filterId = id;
    await extStore.set(STORE.PR_FILTER, id);
    await this._load(1);
  }

  async _load(page) {
    const filter = PR_NAV_FILTERS.find((f) => f.id === this._filterId) || PR_NAV_FILTERS[0];
    const token = await treehub.getAccessToken();
    const requestId = ++this._requestId;

    this.$filter.find('.treehub-pr-nav-filter-label').text(filter.label);
    this.$menu.find('[data-filter]').each((index, el) => {
      $(el).attr('aria-checked', $(el).attr('data-filter') === filter.id ? 'true' : 'false');
    });

    if (filter.needsToken && !token) {
      this._renderMessage(
        'This filter needs to know who you are. ' +
        'Please go to <a class="settings-btn">Settings</a> and enter a GitHub access token.'
      );
      return;
    }

    if (page === 1) {
      this._renderMessage('Loading…');
    } else {
      this.$list.find('.treehub-pr-nav-more').prop('disabled', true).text('Loading…');
    }

    try {
      const result = await this._search(filter, token, page);
      if (requestId !== this._requestId) return;

      this._page = page;
      this.$list.find('.treehub-pr-nav-more, .treehub-pr-nav-message').remove();
      if (page === 1 && !result.items.length) {
        this._renderMessage('No pull requests found.');
        return;
      }
      this.$list.append(this._renderItems(result.items));
      if (result.hasMore) {
        this.$list.append('<button type="button" class="treehub-pr-nav-more">Load more</button>');
      }
    } catch (err) {
      if (requestId !== this._requestId) return;
      // Messages of known errors link to the settings, others come from the server so escape them
      const message = PR_NAV_KNOWN_ERRORS.includes(err.status)
        ? err.message
        : escapeHtml(err.apiMessage || stripTags(err.message) || 'Cannot load pull requests.');
      this._renderMessage(message);
    }
  }

  _search(filter, token, page) {
    const key = `${this._repoKey}:${filter.id}:${page}:${!!token}`;
    const cached = this._cache[key];
    if (cached && Date.now() - cached.time < PR_NAV_CACHE_TTL) return cached.promise;

    const promise = this.adapter.searchPullRequests(this.repo, token, filter.query, page);
    this._cache[key] = {time: Date.now(), promise};
    promise.catch(() => delete this._cache[key]);
    return promise;
  }

  _renderMessage(html) {
    this.$list.html(`<div class="treehub-pr-nav-message">${html}</div>`);
  }

  _renderItems(items) {
    const {username, reponame} = this.repo;
    const current = (location.pathname.match(/^\/[^\/]+\/[^\/]+\/pull\/(\d+)/) || [])[1];

    return items
      .map((pr) => {
        const labels = (pr.labels || [])
          .map((label) => `<span class="treehub-pr-nav-label">${escapeHtml(label.name)}</span>`)
          .join('');
        const classes = `treehub-pr-nav-item${String(pr.number) === current ? ' selected' : ''}`;
        const author = pr.user ? ` by ${escapeHtml(pr.user.login)}` : '';

        return (
          `<a class="${classes}" href="/${username}/${reponame}/pull/${pr.number}">` +
          `<span class="treehub-pr-nav-icon${pr.draft ? ' draft' : ''}" title="${pr.draft ? 'Draft' : 'Open'}">` +
          `${octicon(pr.draft ? 'pullRequestDraft' : 'pullRequest')}</span>` +
          '<span class="treehub-pr-nav-info">' +
          `<span class="treehub-pr-nav-title">${escapeHtml(pr.title)}</span>${labels}` +
          `<span class="treehub-pr-nav-meta">#${pr.number} opened ${timeAgo(pr.created_at)}${author}</span>` +
          '</span></a>'
        );
      })
      .join('');
  }
}
