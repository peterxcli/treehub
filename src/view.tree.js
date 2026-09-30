class TreeView {
  constructor($dom, adapter) {
    this.adapter = adapter;
    this.$view = $dom.find('.treehub-tree-view');
    this.$tree = this.$view
      .find('.treehub-view-body')
      .on('click.jstree', '.jstree-open>a', ({target}) => {
        this.$jstree.close_node(target);
      })
      .on('click.jstree', '.jstree-closed>a', ({target}) => {
        this.$jstree.open_node(target);
      })
      .on('click', this._onItemClick.bind(this))
      .jstree({
        core: {multiple: false, animation: 50, worker: false, themes: {responsive: false}},
        plugins: ['wholerow', 'search', 'wrap', 'comments'],
        comments: {render: (node) => this._renderThreads(node.original.patch.threads)}
      });

    $(document).on(EVENT.VIEWED_CHANGE, (event, {path, viewed}) => this._setViewed(path, viewed));
  }

  get $jstree() {
    return this.$tree.jstree(true);
  }

  focus() {
    this.$jstree.get_container().focus();
  }

  show(repo, token) {
    const $jstree = this.$jstree;

    $jstree.settings.core.data = (node, cb) => {
      // This function does not accept an async function as its value
      // Thus, we use an async anonymous function inside to fix it
      (async () => {
        const startTime = Date.now();
        const loadAll = await this.adapter.shouldLoadEntireTree(repo);
        node = !loadAll && (node.id === '#' ? {path: ''} : node.original);

        this.adapter.loadCodeTree({repo, token, node}, (err, treeData) => {
          if (err) {
            if (err.status === 206 && loadAll) {
              // The repo is too big to load all, need to retry
              $jstree.refresh(true);
            } else {
              $(this).trigger(EVENT.FETCH_ERROR, [err]);
            }
            return;
          }

          cb(treeData);
          $(document).trigger(EVENT.REPO_LOADED, {repo, loadAll, duration: Date.now() - startTime});
        });
      })()
    };

    this.$tree.one('refresh.jstree', async () => {
      await this.syncSelection(repo);
      $(this).trigger(EVENT.VIEW_READY);
    });

    this._showHeader(repo);
    $jstree.refresh(true);
  }

  _showHeader(repo) {
    const adapter = this.adapter;
    const branch = escapeHtml((repo.displayBranch || repo.branch).toString());

    this.$view
      .find('.treehub-view-header')
      .html(
        // The text of each line wraps next to its icon, up to two lines (the full text in a tooltip)
        `<div class="treehub-header-summary">
          <div class="treehub-header-repo" title="${repo.username}/${repo.reponame}">
            <i class="treehub-icon-repo"></i>
            <span class="treehub-header-text"><a href="/${repo.username}">${repo.username}</a> /
            <a class="treehub-header-repo-link" href="/${repo.username}/${repo.reponame}">${repo.reponame}</a></span>
          </div>
          <div class="treehub-header-branch" title="${branch}">
            <i class="treehub-icon-branch"></i>
            <span class="treehub-header-text">${branch}</span>
          </div>
        </div>`
      )
      .on('click', 'a.treehub-header-repo-link', function(event) {
        event.preventDefault();
        // A.href always return absolute URL, don't want that
        const href = $(this).attr('href');
        const newTab = event.shiftKey || event.ctrlKey || event.metaKey;
        newTab ? adapter.openInNewTab(href) : adapter.selectFile(href);
      });
  }

  /**
   * Intercept the _onItemClick method
   * return true to stop the current execution
   * @param {Event} event
   */
  onItemClick(event) {
    return false;
  }

  _onItemClick(event) {
    let $target = $(event.target);
    let download = false;

    if (this.onItemClick(event)) return;

    const adapter = this.adapter;
    const newTab = event.shiftKey || event.ctrlKey || event.metaKey;

    // Review conversation shown below a changed file
    const $comment = $target.closest('.treehub-comment');
    if ($comment.length) {
      event.preventDefault();
      const href = $comment.attr('href');
      newTab ? adapter.openInNewTab(href) : adapter.selectFile(href);
      return;
    }

    // Badge with the number of conversations of a changed file
    const $commentsToggle = $target.closest('.treehub-comments-toggle');
    if ($commentsToggle.length) {
      const node = this.$jstree.get_node($commentsToggle.closest('.jstree-node'));
      this._toggleComments(node);
      return;
    }

    // Handle icon click, fix #122
    if ($target.is('i.jstree-icon')) download = true;

    // The row clicked: its name, stats, icon (see the wrap plugin in util.plugins.js)
    $target = $target.closest('a.jstree-anchor');
    if (!$target.length) return;

    // Refocus once the page changed, so that keyboard navigation keeps working
    const refocusAfterCompletion = () => {
      $(document).one(EVENT.LOC_CHANGE, () => {
        this.$jstree.get_container().focus();
      });
    };

    const href = $target.attr('href');
    // The 2nd path is for submodule child links
    const $icon = $target.children().length ? $target.children(':first') : $target.siblings(':first');

    if ($icon.hasClass('commit')) {
      refocusAfterCompletion();
      newTab ? adapter.openInNewTab(href) : adapter.selectSubmodule(href);
    } else if ($icon.hasClass('blob')) {
      if (download) {
        const downloadUrl = $target.attr('data-download-url');
        const downloadFileName = $target.attr('data-download-filename');
        adapter.downloadFile(downloadUrl, downloadFileName);
      } else {
        refocusAfterCompletion();
        newTab ? adapter.openInNewTab(href) : adapter.selectFile(href);

        // Reveal the conversations of the selected changed file
        const node = this.$jstree.get_node($target.closest('.jstree-node'));
        if (node && node.original && !node.original.commentsExpanded) this._toggleComments(node);
      }
    }
  }

  /**
   * Shows or hides the review conversations below a changed file.
   */
  _toggleComments(node) {
    const patch = node && node.original && node.original.patch;
    if (!patch || !patch.threads || !patch.threads.length) return;

    node.original.commentsExpanded = !node.original.commentsExpanded;
    this.$jstree.redraw_node(node.id);
  }

  /**
   * Updates the viewed state of a changed file.
   */
  _setViewed(path, viewed) {
    const node = this.$jstree.get_node(NODE_PREFIX + path);
    if (!node || !node.original || !node.original.patch) return;

    node.original.patch.viewed = viewed;
    node.li_attr.class = viewed ? VIEWED_CLASS : '';
    $(this.$jstree.get_node(node.id, true)).toggleClass(VIEWED_CLASS, viewed);
  }

  _renderThreads(threads) {
    const sorted = threads.slice().sort((a, b) => {
      // Current conversations by line, outdated ones last
      const lineA = a.line == null ? Infinity : a.line;
      const lineB = b.line == null ? Infinity : b.line;
      return lineA - lineB || a.comments[0].createdAt.localeCompare(b.comments[0].createdAt);
    });

    const items = sorted.map((thread) => {
      const [first] = thread.comments;
      const last = thread.comments[thread.comments.length - 1];
      const replies = thread.comments.length - 1;
      const status = thread.resolved ? 'Resolved' : thread.outdated ? 'Outdated' : '';
      const line = thread.line || thread.originalLine;
      const title = `${line ? `Line ${line}: ` : ''}${first.body}`;

      return (
        `<a class="treehub-comment${thread.resolved ? ' treehub-comment--resolved' : ''}" ` +
        `href="${escapeHtml(thread.url)}" title="${escapeHtml(title.slice(0, 500))}">` +
        '<div class="treehub-comment-header">' +
        `<span class="treehub-comment-author">${escapeHtml(first.author)}</span>` +
        `<span class="treehub-comment-time">${timeAgo(first.createdAt)}</span>` +
        (status ? `<span class="treehub-comment-status">${status}</span>` : '') +
        '</div>' +
        `<div class="treehub-comment-body">${escapeHtml(first.body.replace(/\s+/g, ' ').trim()) || '&nbsp;'}</div>` +
        (replies
          ? '<div class="treehub-comment-replies">' +
            `${replies} ${replies === 1 ? 'reply' : 'replies'} - last by ` +
            `<b>${escapeHtml(last.author)}</b> ${timeAgo(last.createdAt)}</div>`
          : '') +
        '</a>'
      );
    });

    return `<div class="treehub-comments">${items.join('')}</div>`;
  }

  async syncSelection(repo) {
    const $jstree = this.$jstree;
    if (!$jstree) return;

    // On a diff page, select the file whose diff is targeted, e.g. #diff-<sha256>R12
    const diffAnchor = location.hash.match(/^#diff-([0-9a-f]{64})/);
    const diffPath = diffAnchor && this.adapter.getPathFromDiffAnchor(diffAnchor[1]);
    if (diffPath) {
      const nodeId = NODE_PREFIX + diffPath;
      if ($jstree.get_node(nodeId) && !$jstree.is_selected(nodeId)) {
        $jstree.deselect_all();
        $jstree.select_node(nodeId);
      }
      return;
    }

    // Convert /username/reponame/object_type/branch/path to path
    const path = decodeURIComponent(location.pathname);
    const match = path.match(/(?:[^\/]+\/){4}(.*)/);
    if (!match) return;

    const currentPath = match[1];
    const loadAll = await this.adapter.shouldLoadEntireTree(repo);

    selectPath(loadAll ? [currentPath] : breakPath(currentPath));

    // Convert ['a/b'] to ['a', 'a/b']
    function breakPath(fullPath) {
      return fullPath.split('/').reduce((res, path, idx) => {
        res.push(idx === 0 ? path : `${res[idx - 1]}/${path}`);
        return res;
      }, []);
    }

    function selectPath(paths, index = 0) {
      const nodeId = NODE_PREFIX + paths[index];

      if ($jstree.get_node(nodeId)) {
        $jstree.deselect_all();
        $jstree.select_node(nodeId);
        $jstree.open_node(nodeId, () => {
          if (++index < paths.length) {
            selectPath(paths, index);
          }
        });
      }
    }
  }
}
