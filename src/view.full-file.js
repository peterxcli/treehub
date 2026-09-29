const FULL_FILE_BUTTON_CLASS = 'treehub-view-full';
const FULL_FILE_OPEN_CLASS = 'treehub-ff-opened';
// Don't syntax-highlight huge files, it would freeze the page
const FULL_FILE_MAX_HIGHLIGHT = 1024 * 1024;
const FULL_FILE_LANGUAGES = {dockerfile: 'dockerfile', makefile: 'makefile', 'cmakelists.txt': 'cmake'};

/**
 * Adds a "View full" button to each diff of the pull request "Files changed" page. It opens a dialog
 * showing the entire file with its changes, where comments can be added to any line.
 */
class FullFileView {
  constructor(adapter) {
    this.adapter = adapter;
    this.enabled = false;
    this.$modal = null;
    this._observing = false;
    this._injectTimer = null;
    this._observer = new window.MutationObserver(() => this._scheduleInject());

    $(document)
      .on(EVENT.LOC_CHANGE, () => this.refresh())
      .on('click', `.${FULL_FILE_BUTTON_CLASS}`, (event) => {
        event.preventDefault();
        event.stopPropagation();
        this.open($(event.currentTarget).attr('data-diff-id'));
      })
      .on('keydown', (event) => {
        if (event.key === 'Escape' && this.$modal && !$(event.target).is('textarea')) this.close();
      });
  }

  async init() {
    this.setEnabled(await extStore.get(STORE.VIEW_FULL));
  }

  setEnabled(enabled) {
    this.enabled = !!enabled;
    this.refresh();
  }

  /**
   * Adds or removes the buttons depending on the current page.
   */
  refresh() {
    const active = this.enabled && !!this.adapter.getPullOfFilesPage();

    if (active && !this._observing) {
      this._observer.observe(document.body, {childList: true, subtree: true});
      this._observing = true;
    } else if (!active && this._observing) {
      this._observer.disconnect();
      this._observing = false;
    }

    if (active) this._inject();
    else $(`.${FULL_FILE_BUTTON_CLASS}`).remove();
  }

  _scheduleInject() {
    if (this._injectTimer) return;
    this._injectTimer = setTimeout(() => {
      this._injectTimer = null;
      this._inject();
    }, 200);
  }

  _inject() {
    this.adapter.getDiffContainers().forEach((diffEl) => {
      if (diffEl.querySelector(`.${FULL_FILE_BUTTON_CLASS}`)) return;

      const button = $(
        `<button type="button" class="${FULL_FILE_BUTTON_CLASS} tooltipped tooltipped-nw" ` +
        `aria-label="[TreeHub] View entire file with diffs">${octicon('eye', 14)}<span>View full</span></button>`
      ).attr('data-diff-id', diffEl.id)[0];
      this.adapter.insertDiffHeaderAction(diffEl, button);
    });
  }

  async open(diffId) {
    const pull = this.adapter.getPullOfFilesPage();
    if (!pull || !diffId) return;

    const repo = {username: pull.username, reponame: pull.reponame, pullNumber: pull.pullNumber};
    const token = await treehub.getAccessToken();
    const request = (this._request = {});
    this._show();

    try {
      const changes = await this.adapter.getPullRequestChanges(repo, token);
      const file = changes.files.find((f) => `diff-${f.diffId}` === diffId);
      if (!file) throw {message: 'This file is not part of the pull request anymore. Please reload the page.'};

      // Show and comment on the commit the changes were computed for
      const headSha = changes.headSha || (await this.adapter.getPullRequest(repo, repo.pullNumber, token)).head.sha;
      if (this._request !== request) return;

      this._context = {
        repo,
        token,
        file,
        headSha,
        pendingReview: null,
        threads: (changes.threads[file.filename] || []).filter((thread) => !thread.outdated)
      };
      this._renderHeader(file, headSha, changes.threads[file.filename] || []);

      const content =
        file.status === 'removed'
          ? null
          : await this.adapter.getFileContent(repo, token, file.filename, headSha).catch(() => null);
      if (this._request !== request) return;

      this._renderBody(file, content);
    } catch (err) {
      if (this._request !== request) return;
      const message = err.apiMessage || stripTags(err.message) || 'Cannot load the file.';
      this.$modal.find('.treehub-ff-body').html($('<div class="treehub-ff-message"></div>').text(message));
    }
  }

  close() {
    if (!this.$modal) return;

    const unsaved = this.$modal.find('textarea').filter((index, el) => el.value.trim()).length;
    if (unsaved && !window.confirm('You have unsaved comments. Discard them?')) return;

    this._request = null;
    this.$modal.remove();
    this.$modal = null;
    $('html').removeClass(FULL_FILE_OPEN_CLASS);
  }

  _show() {
    if (this.$modal) this.$modal.remove();

    this.$modal = $(
      '<div class="treehub-ff-backdrop">' +
      '<div class="treehub-ff-dialog" role="dialog" aria-modal="true">' +
      '<div class="treehub-ff-header">' +
      '<span class="treehub-ff-title"></span><span class="treehub-ff-stats"></span>' +
      '<span class="treehub-ff-spacer"></span>' +
      '<a class="treehub-ff-link" target="_blank" rel="noopener"></a>' +
      `<button type="button" class="treehub-ff-close" aria-label="Close">${octicon('x')}</button>` +
      '</div>' +
      '<div class="treehub-ff-notice"></div>' +
      '<div class="treehub-ff-body"><div class="treehub-ff-message">Loading…</div></div>' +
      '</div></div>'
    ).appendTo(document.body);

    $('html').addClass(FULL_FILE_OPEN_CLASS);

    this.$modal
      .on('mousedown', (event) => {
        // Close when clicking the backdrop (but not when selecting text inside the dialog)
        if (event.target === event.currentTarget) this.close();
      })
      .on('click', '.treehub-ff-close', () => this.close())
      .on('click', '.treehub-ff-add-comment', (event) => this._openForm($(event.currentTarget).closest('tr')))
      .on('click', '.treehub-ff-cancel', (event) => $(event.currentTarget).closest('tr').remove())
      .on('click', '.treehub-ff-single', (event) => this._submit($(event.currentTarget).closest('tr'), false))
      .on('click', '.treehub-ff-review', (event) => this._submit($(event.currentTarget).closest('tr'), true))
      .on('click', '.treehub-ff-thread-link', (event) => {
        event.preventDefault();
        const href = $(event.currentTarget).attr('href');
        this.close();
        if (!this.$modal) this.adapter.selectFile(href);
      })
      .on('keydown', 'textarea', (event) => {
        // Like the primary button: adds to the (private) pending review rather than publishing
        if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
          event.preventDefault();
          this._submit($(event.currentTarget).closest('tr'), true);
        }
      });
  }

  _renderHeader(file, headSha, allThreads) {
    const {repo} = this._context;
    const outdated = allThreads.length - this._context.threads.length;
    const encodedPath = file.filename.split('/').map(encodeURIComponent).join('/');

    this.$modal.find('.treehub-ff-dialog').attr('aria-label', file.filename);
    this.$modal.find('.treehub-ff-title').text(file.filename).attr('title', file.filename);
    this.$modal
      .find('.treehub-ff-stats')
      .html(
        (file.additions ? `<span class="treehub-ff-additions">+${file.additions}</span>` : '') +
        (file.deletions ? `<span class="treehub-ff-deletions">-${file.deletions}</span>` : '')
      );
    if (file.status !== 'removed') {
      this.$modal
        .find('.treehub-ff-link')
        .attr('href', `/${repo.username}/${repo.reponame}/blob/${headSha}/${encodedPath}`)
        .html(`${octicon('linkExternal', 14)} View file`);
    }
    if (outdated) {
      this._addNotice(`${outdated} outdated ${outdated === 1 ? 'conversation is' : 'conversations are'} not shown.`);
    }
  }

  _addNotice(text) {
    this.$modal.find('.treehub-ff-notice').append($('<div></div>').text(text));
  }

  _renderBody(file, content) {
    const hunks = parsePatch(file.patch);
    let rows;

    if (content != null && content.indexOf('\u0000') !== -1) {
      rows = [];
      this._addNotice('Binary file not shown.');
    } else if (content != null || file.status === 'removed') {
      const lines = content != null ? splitLines(content) : [];
      if (file.patch || file.status === 'removed') {
        rows = mergeFileWithPatch(lines, hunks);
      } else {
        rows = lines.map((text, index) => ({type: 'same', oldNo: null, newNo: index + 1, text}));
        this._addNotice('GitHub doesn\'t provide the diff of this file (too large?), showing its content only.');
      }
    } else {
      rows = patchToRows(hunks);
      this._addNotice('Cannot load the entire file, showing the changes only.');
    }

    if (!rows.length) {
      this.$modal.find('.treehub-ff-body').html('<div class="treehub-ff-message">Nothing to show.</div>');
      return;
    }

    const threadsByLine = {};
    this._context.threads.forEach((thread) => {
      const key = `${thread.side === 'LEFT' ? 'L' : 'R'}${thread.line}`;
      (threadsByLine[key] = threadsByLine[key] || []).push(thread);
    });

    const code = this._highlight(file.filename, content, rows);
    const html = rows.map((row, index) => {
      let rowHtml = this._renderRow(row, index, code[index]);
      const threads = [
        ...(row.oldNo && row.type !== 'add' && row.type !== 'hunk' ? threadsByLine[`L${row.oldNo}`] || [] : []),
        ...(row.newNo && row.type !== 'del' && row.type !== 'hunk' ? threadsByLine[`R${row.newNo}`] || [] : [])
      ];
      threads.forEach((thread) => (rowHtml += this._renderThread(thread)));
      return rowHtml;
    });

    const $body = this.$modal.find('.treehub-ff-body');
    $body.html(`<table class="treehub-ff-table"><tbody>${html.join('')}</tbody></table>`);
    this._rows = rows;

    // Center the first change, scrolling only the dialog
    const firstChange = $body.find('.treehub-ff-add, .treehub-ff-del')[0];
    if (firstChange) {
      const body = $body[0];
      const top = firstChange.getBoundingClientRect().top - body.getBoundingClientRect().top;
      body.scrollTop += top - body.clientHeight / 2;
    }
  }

  _renderRow(row, index, code) {
    if (row.type === 'hunk') {
      return (
        `<tr class="treehub-ff-row treehub-ff-hunk" data-index="${index}">` +
        `<td class="treehub-ff-num" colspan="2"></td><td class="treehub-ff-code">${code}</td></tr>`
      );
    }

    const marker = row.type === 'add' ? '+' : row.type === 'del' ? '-' : ' ';
    return (
      `<tr class="treehub-ff-row treehub-ff-${row.type}" data-index="${index}">` +
      `<td class="treehub-ff-num">${row.oldNo || ''}</td>` +
      `<td class="treehub-ff-num">${row.newNo || ''}</td>` +
      '<td class="treehub-ff-code">' +
      '<button type="button" class="treehub-ff-add-comment" aria-label="Add a comment">' +
      `${octicon('plus', 12)}</button>` +
      `<span class="treehub-ff-marker">${marker}</span>${code}</td></tr>`
    );
  }

  _renderThread(thread, {pending = false} = {}) {
    const comments = thread.comments
      .map(
        (comment) =>
          '<div class="treehub-ff-comment">' +
          `<div class="treehub-ff-comment-header"><b>${escapeHtml(comment.author)}</b>` +
          `<span>${timeAgo(comment.createdAt)}</span>` +
          (pending ? '<span class="treehub-ff-badge">Pending</span>' : '') +
          '</div>' +
          `<div class="treehub-ff-comment-body">${escapeHtml(comment.body)}</div>` +
          '</div>'
      )
      .join('');
    const link = thread.url
      ? `<a class="treehub-ff-thread-link" href="${escapeHtml(thread.url)}">View conversation</a>`
      : '';

    return (
      '<tr class="treehub-ff-thread-row"><td colspan="3">' +
      `<div class="treehub-ff-thread${thread.resolved ? ' treehub-ff-thread--resolved' : ''}">` +
      comments +
      `<div class="treehub-ff-thread-footer">${link}` +
      (thread.resolved ? '<span class="treehub-ff-badge">Resolved</span>' : '') +
      '</div></div></td></tr>'
    );
  }

  async _openForm($row) {
    // Place the form after the conversations of that line, if any
    let $anchor = $row;
    while ($anchor.next().is('.treehub-ff-thread-row, .treehub-ff-form-row')) {
      if ($anchor.next().is('.treehub-ff-form-row')) {
        $anchor.next().find('textarea').focus();
        return;
      }
      $anchor = $anchor.next();
    }

    const row = this._rows[$row.attr('data-index')];
    const side = row.type === 'del' ? 'LEFT' : 'RIGHT';
    const line = side === 'LEFT' ? row.oldNo : row.newNo;
    // GitHub only accepts line comments on lines of the diff, others are posted as file comments
    const inDiff = row.type !== 'same';
    const {token} = this._context;
    const title =
      `Comment on line ${side === 'LEFT' ? 'L' : 'R'}${line}` +
      (inDiff ? '' : ' · this line isn\'t part of the diff, it will be posted as a file comment linking to it');

    const $form = $(
      `<tr class="treehub-ff-form-row" data-side="${side}" data-line="${line}" data-in-diff="${inDiff}">` +
      '<td colspan="3"><div class="treehub-ff-form">' +
      `<div class="treehub-ff-form-title">${title}</div>` +
      '<textarea class="form-control" rows="4" placeholder="Leave a comment"></textarea>' +
      '<div class="treehub-ff-form-error"></div>' +
      '<div class="treehub-ff-form-actions">' +
      '<button type="button" class="btn btn-sm treehub-ff-cancel">Cancel</button>' +
      '<button type="button" class="btn btn-sm treehub-ff-single">Add single comment</button>' +
      '<button type="button" class="btn btn-sm btn-primary treehub-ff-review">Start a review</button>' +
      '</div></div></td></tr>'
    );
    $anchor.after($form);
    $form.find('textarea').focus();

    if (!token) {
      $form.find('.treehub-ff-form-error').html(
        'Commenting requires a GitHub access token with the <code>repo</code> (or <code>public_repo</code>) scope. ' +
        'Please enter one in TreeHub\'s Settings.'
      );
      $form.find('.treehub-ff-single, .treehub-ff-review').prop('disabled', true);
      return;
    }

    this._context.pendingReview =
      this._context.pendingReview || this.adapter.getPendingReview(this._context.repo, token).catch(() => null);
    if (await this._context.pendingReview) {
      $form.find('.treehub-ff-review').text('Add review comment');
    }
  }

  async _submit($form, asReview) {
    const $textarea = $form.find('textarea');
    const body = $textarea.val().trim();
    if (!body || $form.hasClass('treehub-ff-form--busy')) return;

    const {repo, token, file, headSha} = this._context;
    const side = $form.attr('data-side');
    const line = parseInt($form.attr('data-line'), 10);
    const inDiff = $form.attr('data-in-diff') === 'true';
    const $buttons = $form.find('button').prop('disabled', true);
    $form.addClass('treehub-ff-form--busy').find('.treehub-ff-form-error').empty();

    // A link to a line of a file at a commit is rendered by GitHub as a code snippet
    const encodedPath = file.filename.split('/').map(encodeURIComponent).join('/');
    const permalink = `${location.origin}/${repo.username}/${repo.reponame}/blob/${headSha}/${encodedPath}#L${line}`;
    const comment = inDiff
      ? {path: file.filename, line, side, body, commitId: headSha}
      : {path: file.filename, body: `${permalink}\n\n${body}`, commitId: headSha};

    try {
      const result = await this.adapter.addReviewComment(repo, token, comment, asReview);
      if (asReview) {
        this._context.pendingReview = Promise.resolve(true);
        this.$modal.find('.treehub-ff-review').text('Add review comment');
      }

      const thread = {
        url: result.pending ? null : `/${repo.username}/${repo.reponame}/pull/${repo.pullNumber}/files#r${result.id}`,
        resolved: false,
        comments: [{author: result.author || 'You', body: comment.body, createdAt: new Date().toISOString()}]
      };
      $form.replaceWith(this._renderThread(thread, {pending: result.pending}));

      // Refresh comments in the sidebar
      this.adapter.invalidatePullRequestChanges(repo);
      $(document).trigger(EVENT.LOC_CHANGE, true);
    } catch (err) {
      $form.find('.treehub-ff-form-error').text(this._describeError(err));
      $buttons.prop('disabled', false);
      $form.removeClass('treehub-ff-form--busy');
    }
  }

  _describeError(err) {
    if (err.status === 401) {
      return 'The GitHub access token is invalid. Please update it in TreeHub\'s Settings.';
    }
    if (err.status === 403 || err.status === 404) {
      return (
        `GitHub refused the comment${err.apiMessage ? ` (${err.apiMessage})` : ''}. ` +
        'Please make sure the access token can write pull requests (repo or public_repo scope).'
      );
    }

    const details = (err.details || []).map((detail) => (typeof detail === 'string' ? detail : detail.message));
    const message = [err.apiMessage || stripTags(err.message), ...details].filter(Boolean).join(': ');
    return message || 'Cannot add the comment.';
  }

  /**
   * Returns the HTML of each row's code, syntax-highlighted when the language is supported.
   */
  _highlight(path, content, rows) {
    const escaped = rows.map((row) => escapeHtml(row.text));
    const hljs = loadHighlighter();
    const language = hljs && this._getLanguage(hljs, path);
    if (!language) return escaped;

    const highlight = (text) => splitHtmlLines(hljs.highlight(text, {language, ignoreIllegals: true}).value);

    try {
      // Highlight the whole new file at once so that multi-line constructs are colored correctly
      const newLines = content != null && content.length <= FULL_FILE_MAX_HIGHLIGHT ? highlight(content) : null;
      const result = escaped.slice();
      const blocks = [];
      let block = null;

      rows.forEach((row, index) => {
        if (row.type === 'hunk') {
          block = null;
        } else if (row.type !== 'del' && newLines) {
          if (newLines[row.newNo - 1] != null) result[index] = newLines[row.newNo - 1];
          block = null;
        } else {
          // Deleted lines (and new lines when the file isn't available) are highlighted by block
          const kind = row.type === 'del' ? 'del' : 'new';
          if (!block || block.kind !== kind) blocks.push((block = {kind, indexes: []}));
          block.indexes.push(index);
        }
      });

      blocks.forEach(({indexes}) => {
        if (indexes.reduce((size, i) => size + rows[i].text.length, 0) > FULL_FILE_MAX_HIGHLIGHT) return;
        const lines = highlight(indexes.map((i) => rows[i].text).join('\n'));
        indexes.forEach((rowIndex, i) => {
          if (lines[i] != null) result[rowIndex] = lines[i];
        });
      });

      return result;
    } catch (err) {
      return escaped;
    }
  }

  _getLanguage(hljs, path) {
    const name = path.split('/').pop().toLowerCase();
    if (FULL_FILE_LANGUAGES[name] && hljs.getLanguage(FULL_FILE_LANGUAGES[name])) return FULL_FILE_LANGUAGES[name];

    const ext = (name.match(/\.([^.]+)$/) || [])[1];
    return ext && hljs.getLanguage(ext) ? ext : null;
  }
}

/**
 * Loads highlight.js on demand, it's only needed when showing an entire file.
 * @return {?Object} hljs
 */
function loadHighlighter() {
  if (!window.hljs && typeof window['highlight.js'] === 'function') {
    try {
      window['highlight.js']();
    } catch (ignored) {}
  }
  return window.hljs || null;
}
