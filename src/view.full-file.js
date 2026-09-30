const FULL_FILE_BUTTON_CLASS = 'treehub-view-full';
const FULL_FILE_OPEN_CLASS = 'treehub-ff-opened';
// Don't syntax-highlight huge files, it would freeze the page
const FULL_FILE_MAX_HIGHLIGHT = 1024 * 1024;
const FULL_FILE_LANGUAGES = {dockerfile: 'dockerfile', makefile: 'makefile', 'cmakelists.txt': 'cmake'};
const FULL_FILE_MOD = /Mac/.test(navigator.platform) ? '⌘' : 'Ctrl+';
// The toolbar of the comment editor, like GitHub's: [format, icon, label, shortcut key], null for a separator
const FULL_FILE_TOOLS = [
  ['heading', 'heading', 'Add heading text'],
  ['bold', 'bold', 'Add bold text', 'b'],
  ['italic', 'italic', 'Add italic text', 'i'],
  ['quote', 'quote', 'Add a quote'],
  ['code', 'code', 'Add code', 'e'],
  ['link', 'link', 'Add a link', 'k'],
  null,
  ['ordered', 'listOrdered', 'Add a numbered list'],
  ['unordered', 'listUnordered', 'Add a bulleted list'],
  ['task', 'tasklist', 'Add a task list'],
  null,
  ['mention', 'mention', 'Directly mention a user or team'],
  ['reference', 'crossReference', 'Reference an issue, pull request, or discussion']
];
const FULL_FILE_SHORTCUTS = {b: 'bold', i: 'italic', e: 'code', k: 'link'};

/**
 * Adds a "View full" button to each diff of the pull request "Files changed" page. It opens a dialog
 * showing the entire file with its changes, where comments can be added to any line. Clicking line numbers
 * selects lines (Shift+click or drag for a range) to comment on them or copy their permalink.
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
        if (event.key !== 'Escape' || !this.$modal || $(event.target).is('textarea')) return;
        // Clears the selected lines first
        if (this._selection) this._clearSelection();
        else this.close();
      });
    // Dragging over line numbers to select lines can end anywhere
    $(window).on('mouseup', () => (this._dragging = false));
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
      this._context.content = content;

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
    this._clearSelection();
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
      '<span class="treehub-ff-hint">Click line numbers to select lines, Shift+click for a range</span>' +
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
      .on('click', '.treehub-ff-add-comment', (event) => {
        const index = +$(event.currentTarget).closest('tr').attr('data-index');
        this._openForm(index, index);
      })
      .on('mousedown', '.treehub-ff-row:not(.treehub-ff-hunk) > .treehub-ff-num', (event) => {
        if (event.button !== 0) return;
        event.preventDefault(); // selects lines, not text
        const index = +$(event.currentTarget).parent().attr('data-index');
        this._select(event.shiftKey && this._selection ? this._selection.anchor : index, index);
        this._dragging = true;
      })
      .on('mouseover', '.treehub-ff-row:not(.treehub-ff-hunk)', (event) => {
        if (this._dragging && this._selection) this._select(this._selection.anchor, +event.currentTarget.dataset.index);
      })
      .on('mouseover', '.treehub-ff-row:not(.treehub-ff-hunk) > .treehub-ff-num', (event) => {
        // Set on hover only, big files have many line numbers
        event.currentTarget.title = 'Select this line. Shift+click or drag to select several lines.';
      })
      .on('click', '.treehub-ff-sel-comment', () => this._commentOnSelection())
      .on('click', '.treehub-ff-sel-copy', (event) => this._copyPermalink($(event.currentTarget)))
      .on('click', '.treehub-ff-sel-clear', () => this._clearSelection())
      .on('click', '.treehub-ff-cancel', (event) => this._removeForm($(event.currentTarget).closest('tr')))
      .on('click', '.treehub-ff-single', (event) => this._submit($(event.currentTarget).closest('tr'), false))
      .on('click', '.treehub-ff-review', (event) => this._submit($(event.currentTarget).closest('tr'), true))
      .on('click', '.treehub-ff-thread-link', (event) => {
        event.preventDefault();
        const href = $(event.currentTarget).attr('href');
        this.close();
        if (!this.$modal) this.adapter.selectFile(href);
      })
      .on('click', '.treehub-ff-editor-tab', (event) => {
        this._showTab($(event.currentTarget).closest('tr'), event.currentTarget.dataset.tab);
      })
      .on('click', '.treehub-ff-tool', (event) => {
        this._format($(event.currentTarget).closest('tr'), event.currentTarget.dataset.format);
      })
      .on('keydown', '.treehub-ff-editor', (event) => {
        if (!(event.metaKey || event.ctrlKey)) return;
        const $form = $(event.currentTarget).closest('tr');
        const previewing = event.currentTarget.classList.contains('treehub-ff-previewing');
        const key = event.key.toLowerCase();
        if (key === 'enter') {
          // Like the primary button: adds to the (private) pending review rather than publishing
          event.preventDefault();
          this._submit($form, true);
        } else if (key === 'p' && event.shiftKey) {
          event.preventDefault();
          this._showTab($form, previewing ? 'write' : 'preview');
        } else if (FULL_FILE_SHORTCUTS[key] && !previewing && !event.shiftKey && !event.altKey) {
          event.preventDefault();
          this._format($form, FULL_FILE_SHORTCUTS[key]);
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
    this._code = code;
    // Permalinks of the conversations that GitHub left as links (the links stay if the files can't be loaded)
    $body.find('.treehub-ff-comment-body.markdown-body').each((index, el) => {
      this._showSnippets(el).catch(() => {});
    });
    this._selection = null;
    this.$selectionBar = $(
      '<div class="treehub-ff-selection" role="toolbar" aria-label="Selected lines" hidden>' +
      '<span class="treehub-ff-sel-label"></span>' +
      `<button type="button" class="treehub-ff-sel-comment">${octicon('comment', 14)}<span>Comment</span></button>` +
      `<button type="button" class="treehub-ff-sel-copy">${octicon('link', 14)}<span>Copy permalink</span></button>` +
      '<button type="button" class="treehub-ff-sel-clear" aria-label="Clear the selection">' +
      `${octicon('x', 14)}</button>` +
      '</div>'
    ).appendTo($body);

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
          // GitHub's rendering when known (sanitized by GitHub), else the text
          (comment.html
            ? `<div class="treehub-ff-comment-body markdown-body">${comment.html}</div>`
            : `<div class="treehub-ff-comment-body">${escapeHtml(comment.body)}</div>`) +
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

  /**
   * Selects rows anchor..focus (indexes of this._rows) and shows the actions on them next to the focus row.
   */
  _select(anchor, focus) {
    this._selection = {anchor, focus};
    const from = Math.min(anchor, focus);
    const to = Math.max(anchor, focus);
    this.$modal.find('.treehub-ff-row').each((i, el) => {
      const index = +el.dataset.index;
      el.classList.toggle('treehub-ff-selected', index >= from && index <= to);
    });

    const {text, multiple} = this._rangeLabel(describeRowRange(this._rows, from, to));
    this.$selectionBar.find('.treehub-ff-sel-label').text(`${multiple ? 'Lines' : 'Line'} ${text}`);
    this.$selectionBar.find('.treehub-ff-sel-copy span').text('Copy permalink');

    const body = this.$modal.find('.treehub-ff-body')[0];
    const row = this.$modal.find(`.treehub-ff-row[data-index="${focus}"]`)[0];
    const top = row.getBoundingClientRect().bottom - body.getBoundingClientRect().top + body.scrollTop;
    this.$selectionBar.css('top', top + 2).prop('hidden', false);
  }

  _clearSelection() {
    this._selection = null;
    this._dragging = false;
    if (!this.$modal) return;
    this.$modal.find('.treehub-ff-selected').removeClass('treehub-ff-selected');
    if (this.$selectionBar) this.$selectionBar.prop('hidden', true);
  }

  _selectedRange() {
    const {anchor, focus} = this._selection;
    return {from: Math.min(anchor, focus), to: Math.max(anchor, focus)};
  }

  /**
   * Names lines like the diff does: L for the file before the change, R for the file after.
   * @param {!Object} range result of describeRowRange()
   * @return {{text: string, multiple: boolean}} e.g. "R12" or "L4 to R6"
   */
  _rangeLabel({comment, newRange, oldRange}) {
    const name = (side, line) => `${side === 'LEFT' ? 'L' : 'R'}${line}`;
    if (comment) {
      return comment.startLine
        ? {text: `${name(comment.startSide, comment.startLine)} to ${name(comment.side, comment.line)}`, multiple: true}
        : {text: name(comment.side, comment.line), multiple: false};
    }
    const side = newRange ? 'RIGHT' : 'LEFT';
    const {start, end} = newRange || oldRange;
    return start === end
      ? {text: name(side, start), multiple: false}
      : {text: `${name(side, start)} to ${name(side, end)}`, multiple: true};
  }

  _commentOnSelection() {
    if (!this._selection) return;
    const {from, to} = this._selectedRange();
    this.$selectionBar.prop('hidden', true);
    this._openForm(from, to);
  }

  async _copyPermalink($button) {
    if (!this._selection) return;
    const {from, to} = this._selectedRange();
    const $label = $button.find('span');
    try {
      await navigator.clipboard.writeText(await this._permalink(describeRowRange(this._rows, from, to)));
      $label.text('Copied!');
    } catch (err) {
      $label.text('Cannot copy');
    }
    clearTimeout(this._copyTimer);
    this._copyTimer = setTimeout(() => $label.text('Copy permalink'), 2000);
  }

  /**
   * Returns the link to the lines of a range in the file at a commit, which GitHub renders as a code snippet.
   * @param {!Object} range result of describeRowRange()
   * @return {!Promise<string>}
   */
  async _permalink(range) {
    const {repo, token, file, headSha} = this._context;
    if (range.newRange) return this._blobUrl(headSha, file.filename, range.newRange);

    // Deleted lines only: they are in the file before the change, at the commit the changes start from
    const pull = await this.adapter.getPullRequest(repo, repo.pullNumber, token);
    const base = await this.adapter.getMergeBase(repo, token, pull.base.sha, headSha);
    return this._blobUrl(base, file.previous_filename || file.filename, range.oldRange);
  }

  _blobUrl(sha, path, {start, end}) {
    const {repo} = this._context;
    const encodedPath = path.split('/').map(encodeURIComponent).join('/');
    const lines = start === end ? `L${start}` : `L${start}-L${end}`;
    return `${location.origin}/${repo.username}/${repo.reponame}/blob/${sha}/${encodedPath}#${lines}`;
  }

  /**
   * Opens a comment form for rows from..to (indexes of this._rows), after the last one and its conversations.
   */
  async _openForm(from, to) {
    let $anchor = this.$modal.find(`.treehub-ff-row[data-index="${to}"]`);
    while ($anchor.next().is('.treehub-ff-thread-row, .treehub-ff-form-row')) {
      const $next = $anchor.next();
      if ($next.is('.treehub-ff-form-row') && +$next.attr('data-from') === from && +$next.attr('data-to') === to) {
        $next.find('textarea').focus();
        return;
      }
      $anchor = $next;
    }

    // GitHub only accepts line comments on lines of one hunk of the diff, others are posted as file comments
    const range = describeRowRange(this._rows, from, to);
    const {text, multiple} = this._rangeLabel(range);
    const {token} = this._context;
    let title = `Comment on ${multiple ? 'lines' : 'line'} ${text}`;
    if (!range.comment) {
      title += multiple
        ? ' · these lines aren\'t all in one hunk of the diff, it will be posted as a file comment linking to them'
        : ' · this line isn\'t part of the diff, it will be posted as a file comment linking to it';
    }

    const $form = $(
      `<tr class="treehub-ff-form-row" data-from="${from}" data-to="${to}">` +
      '<td colspan="3"><div class="treehub-ff-form">' +
      '<div class="treehub-ff-form-title"></div>' +
      this._renderEditor(this._canSuggest(range)) +
      '<div class="treehub-ff-form-error"></div>' +
      '<div class="treehub-ff-form-actions">' +
      '<button type="button" class="btn btn-sm treehub-ff-cancel">Cancel</button>' +
      '<button type="button" class="btn btn-sm treehub-ff-single">Add single comment</button>' +
      '<button type="button" class="btn btn-sm btn-primary treehub-ff-review">Start a review</button>' +
      '</div></div></td></tr>'
    );
    $form.data('range', range).find('.treehub-ff-form-title').text(title);
    $anchor.after($form);
    $form.find('textarea').focus();

    if (!token) {
      $form.find('.treehub-ff-form-error').html(
        'Commenting requires a GitHub access token with the <code>repo</code> (or <code>public_repo</code>) scope. ' +
        'Please sign in or enter one in TreeHub\'s Settings.'
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

  /**
   * Removes a comment form (or replaces it), and the selection of its lines.
   */
  _removeForm($form, $replacement) {
    const selection = this._selection && this._selectedRange();
    if (selection && selection.from === +$form.attr('data-from') && selection.to === +$form.attr('data-to')) {
      this._clearSelection();
    }
    if ($replacement) $form.replaceWith($replacement);
    else $form.remove();
  }

  async _submit($form, asReview) {
    const text = $form.find('textarea').val().trim();
    if (!text || $form.hasClass('treehub-ff-form--busy')) return;

    const {repo, token, file, headSha} = this._context;
    const range = $form.data('range');
    const $buttons = $form.find('button').prop('disabled', true);
    $form.addClass('treehub-ff-form--busy').find('.treehub-ff-form-error').empty();

    try {
      const body = await this._commentBody($form, text);
      const comment = Object.assign({path: file.filename, body, commitId: headSha}, range.comment);
      const result = await this.adapter.addReviewComment(repo, token, comment, asReview);
      if (asReview) {
        this._context.pendingReview = Promise.resolve(true);
        this.$modal.find('.treehub-ff-review').text('Add review comment');
      }

      // As GitHub renders it: from GitHub's answer, else rendered like the preview
      const html = await this._renderComment($form, body, result.html).catch(() => result.html || null);
      const thread = {
        url: result.pending ? null : `/${repo.username}/${repo.reponame}/pull/${repo.pullNumber}/files#r${result.id}`,
        resolved: false,
        comments: [{author: result.author || 'You', body: comment.body, html, createdAt: new Date().toISOString()}]
      };
      this._removeForm($form, $(this._renderThread(thread, {pending: result.pending})));

      // Refresh comments in the sidebar
      this.adapter.invalidatePullRequestChanges(repo);
      $(document).trigger(EVENT.LOC_CHANGE, true);
    } catch (err) {
      $form.find('.treehub-ff-form-error').text(this._describeError(err));
      $buttons.prop('disabled', false);
      $form.removeClass('treehub-ff-form--busy');
    }
  }

  /**
   * The comment editor, like GitHub's: Write and Preview tabs, and a formatting toolbar.
   * @param {boolean} suggest whether to offer to suggest changes to the lines
   */
  _renderEditor(suggest) {
    const tools = FULL_FILE_TOOLS.concat(suggest ? [null, ['suggestion', 'fileDiff', 'Insert a suggestion']] : [])
      .map((tool) => {
        if (!tool) return '<span class="treehub-ff-toolbar-sep"></span>';
        const [format, icon, label, key] = tool;
        const title = key ? `${label} (${FULL_FILE_MOD}${key.toUpperCase()})` : label;
        return (
          `<button type="button" class="treehub-ff-tool" data-format="${format}" aria-label="${label}" ` +
          `title="${title}">${octicon(icon)}</button>`
        );
      })
      .join('');
    return (
      '<div class="treehub-ff-editor">' +
      '<div class="treehub-ff-editor-head">' +
      '<div class="treehub-ff-editor-tabs" role="tablist">' +
      '<button type="button" role="tab" class="treehub-ff-editor-tab selected" data-tab="write" ' +
      'aria-selected="true">Write</button>' +
      '<button type="button" role="tab" class="treehub-ff-editor-tab" data-tab="preview" aria-selected="false" ' +
      `title="Preview (${FULL_FILE_MOD}Shift+P)">Preview</button>` +
      '</div>' +
      `<div class="treehub-ff-toolbar" role="toolbar" aria-label="Formatting">${tools}</div>` +
      '</div>' +
      '<textarea class="form-control" rows="4" placeholder="Leave a comment"></textarea>' +
      '<div class="treehub-ff-preview markdown-body" hidden></div>' +
      `<div class="treehub-ff-editor-foot">${octicon('markdown')}<span>Markdown is supported</span></div>` +
      '</div>'
    );
  }

  /** GitHub suggests changes to lines of the file after the change, in the diff. */
  _canSuggest(range) {
    const target = range.comment;
    return !!target && target.side === 'RIGHT' && (!target.startLine || target.startSide === 'RIGHT');
  }

  /** Applies a format of the toolbar to the selection of the form's text. */
  _format($form, format) {
    if ($form.find('.treehub-ff-editor').hasClass('treehub-ff-previewing')) this._showTab($form, 'write');
    const textarea = $form.find('textarea')[0];
    const suggestion = format === 'suggestion'
      ? this._suggestedRows($form).map((index) => this._rows[index].text).join('\n')
      : undefined;
    const edit = formatMarkdown(textarea.value, textarea.selectionStart, textarea.selectionEnd, format, suggestion);

    textarea.focus();
    textarea.setSelectionRange(edit.from, edit.to);
    // As if typed, so that the browser can undo it
    document.execCommand(edit.text ? 'insertText' : 'delete', false, edit.text);
    textarea.setSelectionRange(edit.selectionStart, edit.selectionEnd);
  }

  /** Shows the Write or the Preview tab of a form's editor. */
  async _showTab($form, tab) {
    const $editor = $form.find('.treehub-ff-editor');
    const previewing = tab === 'preview';
    $editor.toggleClass('treehub-ff-previewing', previewing);
    $editor.find('.treehub-ff-editor-tab').each((index, el) => {
      el.classList.toggle('selected', el.dataset.tab === tab);
      el.setAttribute('aria-selected', String(el.dataset.tab === tab));
    });

    const $textarea = $editor.find('textarea');
    const $preview = $editor.find('.treehub-ff-preview');
    if (!previewing) {
      $preview.prop('hidden', true);
      $textarea.prop('hidden', false).focus();
      return;
    }

    // Same height as the text, so that the page doesn't jump
    $preview.css('min-height', $textarea.outerHeight());
    $textarea.prop('hidden', true);
    $preview.prop('hidden', false);
    $editor.find('.treehub-ff-editor-tab[data-tab="preview"]').focus();

    const text = $textarea.val();
    if (!text.trim()) {
      $preview.html('<p class="treehub-ff-preview-note">Nothing to preview</p>');
      return;
    }
    $preview.html('<p class="treehub-ff-preview-note">Loading preview…</p>');
    try {
      const html = await this._renderComment($form, await this._commentBody($form, text));
      // Unless the user went back to writing meanwhile
      if ($editor.hasClass('treehub-ff-previewing') && $textarea.val() === text) $preview.html(html);
    } catch (err) {
      $preview.empty().append($('<p class="treehub-ff-preview-note treehub-ff-preview-error"></p>').text(
        `Cannot preview: ${this._describeError(err)}`
      ));
    }
  }

  /**
   * GitHub's rendering of Markdown in this repository, remembered for the last texts (e.g. switching tabs).
   * @return {!Promise<string>}
   */
  _renderMarkdown(text) {
    const {repo, token} = this._context;
    // References such as #12 depend on the repository
    const key = `${repo.username}/${repo.reponame}\n${text}`;
    this._markdownCache = this._markdownCache || new Map();
    return rememberLast(this._markdownCache, key, () => this.adapter.renderMarkdown(repo, token, text), 20);
  }

  /**
   * The comment of a form as it's posted. Comments on other lines than those of one hunk are posted on the file,
   * starting with the permalink to their lines, which GitHub shows as a snippet (unless the text links to them).
   * @return {!Promise<string>}
   */
  async _commentBody($form, text) {
    const range = $form.data('range');
    if (range.comment) return text;
    const permalink = await this._permalink(range);
    return text.includes(permalink) ? text : `${permalink}\n\n${text}`;
  }

  /**
   * Renders a form's comment as GitHub shows it: Markdown rendered by GitHub, with suggestions and code snippets.
   * @param {string} body
   * @param {?string=} html GitHub's rendering of the comment, if known
   * @return {!Promise<string>}
   */
  async _renderComment($form, body, html) {
    // A template doesn't load or run anything of its content
    const template = document.createElement('template');
    template.innerHTML = html || (await this._renderMarkdown(body));
    this._showSuggestions(template.content, $form);
    await this._showSnippets(template.content);
    return template.innerHTML;
  }

  /**
   * Shows permalinks to lines of this repository as GitHub does in comments: as snippets of the code. GitHub leaves
   * them as links in some renderings (e.g. of its Markdown API for some tokens). Like GitHub, only bare links, not
   * [text](link).
   * @param {!Node} root rendered comments
   * @return {!Promise}
   */
  async _showSnippets(root) {
    const decode = (url) => {
      try {
        return decodeURI(url);
      } catch (err) {
        return url;
      }
    };
    const links = [...root.querySelectorAll('a[href]')]
      .map((link) => ({link, url: link.getAttribute('href')}))
      .filter(({link, url}) => decode(url) === decode(link.textContent.trim()))
      .map(({link, url}) => ({link, url, permalink: parsePermalink(url, this._context.repo)}))
      .filter(({permalink}) => permalink);

    await Promise.all(
      links.map(async ({link, url, permalink}) => {
        const content = await this._fileAt(permalink.sha, permalink.path).catch(() => null);
        const snippet = content != null && this._renderSnippet(url, permalink, content);
        if (snippet) replaceWithBlock(link, snippet);
      })
    );
  }

  /**
   * GitHub's snippet of lines of a file (with its markup, so that it looks like in posted comments).
   * @return {?Element} null if the file doesn't have the lines
   */
  _renderSnippet(url, {sha, path, start, end}, content) {
    const {repo} = this._context;
    const lines = splitLines(content);
    if (start > lines.length || content.indexOf('\u0000') !== -1) return null;
    const rows = lines.slice(start - 1, end).map((text) => ({type: 'same', newNo: null, text}));
    const code = this._highlight(path, null, rows);
    const last = start + rows.length - 1;

    const snippet = document.createElement('div');
    snippet.className = 'Box Box--condensed my-2 treehub-ff-snippet';
    snippet.innerHTML =
      '<div class="Box-header f6">' +
      `<p class="mb-0 text-bold"><a href="${escapeHtml(url)}">${escapeHtml(`${repo.reponame}/${path}`)}</a></p>` +
      `<p class="mb-0 color-fg-muted">${start === last ? `Line ${start}` : `Lines ${start} to ${last}`} in ` +
      `<a class="commit-tease-sha Link--inTextBlock" href="/${repo.username}/${repo.reponame}/commit/${sha}">` +
      `${sha.slice(0, 7)}</a></p>` +
      '</div>' +
      '<div class="Box-body p-0 blob-wrapper blob-wrapper-embedded data">' +
      '<table class="highlight tab-size mb-0" data-tab-size="8"><tbody>' +
      rows
        .map(
          (row, i) =>
            '<tr class="border-0">' +
            `<td class="blob-num border-0 px-3 py-0 color-bg-default" data-line-number="${start + i}"></td>` +
            `<td class="blob-code blob-code-inner border-0 px-3 py-0 color-bg-default">${code[i]}</td></tr>`
        )
        .join('') +
      '</tbody></table></div>';
    return snippet;
  }

  /**
   * A file of this repository at a commit, remembered for the last ones.
   * @return {!Promise<string>}
   */
  _fileAt(sha, path) {
    const {repo, token, file, headSha, content} = this._context;
    if (sha === headSha && path === file.filename && content != null) return Promise.resolve(content);
    this._fileCache = this._fileCache || new Map();
    const key = `${repo.username}/${repo.reponame}\n${sha}\n${path}`;
    return rememberLast(this._fileCache, key, () => this.adapter.getFileContent(repo, token, path, sha), 5);
  }

  /**
   * The rows a suggestion of a form replaces: its lines of the file after the change.
   * @return {!Array<number>} indexes of this._rows
   */
  _suggestedRows($form) {
    const indexes = [];
    for (let index = +$form.attr('data-from'); index <= +$form.attr('data-to'); index++) {
      const {type} = this._rows[index];
      if (type !== 'del' && type !== 'hunk') indexes.push(index);
    }
    return indexes;
  }

  /**
   * Shows the suggestions of a form's rendered comment as GitHub does: its lines replaced by the suggested
   * ones. GitHub's Markdown API renders them as code blocks.
   * @param {!Node} root the rendered comment
   */
  _showSuggestions(root, $form) {
    const blocks = root.querySelectorAll('pre[lang="suggestion"]');
    if (!blocks.length || !this._canSuggest($form.data('range'))) return;
    const indexes = this._suggestedRows($form);
    if (!indexes.length) return;
    const firstLine = this._rows[indexes[0]].newNo;
    const row = (type, line, code) =>
      `<tr class="treehub-ff-${type}"><td class="treehub-ff-num">${line}</td><td class="treehub-ff-code">` +
      `<span class="treehub-ff-marker">${type === 'add' ? '+' : '-'}</span>${code}</td></tr>`;

    blocks.forEach((pre) => {
      // No line removes the lines
      const text = pre.textContent;
      const lines = text ? text.replace(/\n$/, '').split('\n') : [];
      const code = this._highlight(
        this._context.file.filename,
        null,
        lines.map((line) => ({type: 'add', text: line}))
      );
      const $block = $(
        '<div class="treehub-ff-suggestion"><div class="treehub-ff-suggestion-title">Suggested change</div>' +
        '<table class="treehub-ff-table"><tbody>' +
        indexes.map((index) => row('del', this._rows[index].newNo, this._code[index])).join('') +
        lines.map((line, i) => row('add', firstLine + i, code[i])).join('') +
        '</tbody></table></div>'
      );
      pre.replaceWith($block[0]);
    });
  }

  _describeError(err) {
    if (err.status === 401) {
      return 'The GitHub access token is invalid. Please sign in again or update it in TreeHub\'s Settings.';
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
 * Puts a block in place of an element. In a paragraph, the block ends the paragraph and the rest of it follows in
 * another one, as when parsing HTML (a paragraph can't contain blocks), like GitHub's snippets of permalinks.
 */
function replaceWithBlock(element, block) {
  const paragraph = element.parentElement && element.parentElement.closest('p');
  if (!paragraph) {
    element.replaceWith(block);
    return;
  }
  const rest = paragraph.ownerDocument.createRange();
  rest.setStartAfter(element);
  rest.setEnd(paragraph, paragraph.childNodes.length);
  const after = paragraph.cloneNode(false);
  after.append(rest.extractContents());
  element.remove();
  paragraph.after(block, after);
}

/**
 * Remembers the last promises of a loader by key, not the failed ones.
 * @param {!Map<string, !Promise>} cache
 * @param {string} key
 * @param {function(): !Promise} load
 * @param {number} size how many to remember
 * @return {!Promise}
 */
function rememberLast(cache, key, load, size) {
  if (!cache.has(key)) {
    const promise = load();
    cache.set(key, promise);
    promise.catch(() => cache.get(key) === promise && cache.delete(key));
    if (cache.size > size) cache.delete(cache.keys().next().value);
  }
  return cache.get(key);
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
