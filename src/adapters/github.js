const GH_API = 'https://api.github.com';
const GH_MAX_HUGE_REPOS_SIZE = 50;

// The API returns at most 3000 files for a pull request or a commit
const GH_MAX_PAGES = 30;
const GH_CACHE_TTL = 5 * 60 * 1000;

// Diff containers in the "Files changed" page (classic and React versions) have id="diff-<sha256(path)>"
const GH_DIFF_ID = /^diff-[0-9a-f]{64}$/;
const GH_PR_FILES_PATH = /^\/([^\/]+)\/([^\/]+)\/pull\/(\d+)\/(files|changes)\/?$/;

const GH_REVIEW_THREADS_QUERY = `
  query($owner: String!, $name: String!, $number: Int!, $cursor: String) {
    repository(owner: $owner, name: $name) {
      pullRequest(number: $number) {
        reviewThreads(first: 100, after: $cursor) {
          pageInfo { hasNextPage endCursor }
          nodes {
            isResolved isOutdated path line originalLine startLine diffSide
            comments(first: 100) {
              nodes { databaseId bodyText createdAt author { login } }
            }
          }
        }
      }
    }
  }`;

const GH_VIEWED_FILES_QUERY = `
  query($owner: String!, $name: String!, $number: Int!, $cursor: String) {
    repository(owner: $owner, name: $name) {
      pullRequest(number: $number) {
        files(first: 100, after: $cursor) {
          pageInfo { hasNextPage endCursor }
          nodes { path viewerViewedState }
        }
      }
    }
  }`;

const GH_ADD_REVIEW_THREAD_MUTATION = `
  mutation($reviewId: ID!, $path: String!, $body: String!, $line: Int, $side: DiffSide, $startLine: Int,
           $startSide: DiffSide, $subjectType: PullRequestReviewThreadSubjectType) {
    addPullRequestReviewThread(input: {
      pullRequestReviewId: $reviewId, path: $path, body: $body, line: $line, side: $side,
      startLine: $startLine, startSide: $startSide, subjectType: $subjectType
    }) {
      thread { comments(last: 1) { nodes { databaseId author { login } } } }
    }
  }`;

class GitHub extends Adapter {
  constructor() {
    super();
    this._cache = {};
  }

  // @override
  init($sidebar, dock) {
    super.init($sidebar, dock);
    this._observeViewedToggles();
  }

  // @override
  getCssClass() {
    return 'treehub-github-sidebar';
  }

  // @override
  async shouldLoadEntireTree(repo) {
    const isLoadingChanges = await extStore.get(STORE.PR) && (repo.pullNumber || repo.commitSha);
    if (isLoadingChanges) {
      return true;
    }

    const isGlobalLazyLoad = await extStore.get(STORE.LAZYLOAD);
    if (isGlobalLazyLoad) {
      return false;
    }

    // Else, return true only if it isn't in a huge repo list, which we must lazy load
    const key = `${repo.username}/${repo.reponame}`;
    const hugeRepos = await extStore.get(STORE.HUGE_REPOS);
    if (hugeRepos[key] && isValidTimeStamp(hugeRepos[key])) {
      // Update the last load time of the repo
      hugeRepos[key] = new Date().getTime();
      await extStore.set(STORE.HUGE_REPOS, hugeRepos);
    }
    return !hugeRepos[key];
  }

  // @override
  getCreateTokenUrl() {
    return 'https://github.com/settings/tokens/new?scopes=repo&description=TreeHub%20browser%20extension';
  }

  // @override
  updateLayout(sidebarPinned, sidebarVisible, sidebarWidth, dock) {
    const side = dock === 'right' ? 'right' : 'left';
    const otherSide = side === 'left' ? 'right' : 'left';
    // A pinned sidebar pushes the whole page aside, and GitHub lays the page out in the space left. Elements with
    // .container or .container-lg are not moved: GitHub uses these classes inside pages now (READMEs, the code
    // view), where extra margins squeezed the content.
    $('html')
      .css(`margin-${otherSide}`, '')
      .css(`margin-${side}`, sidebarPinned && sidebarVisible ? sidebarWidth : '');
  }

  // @override
  async getRepoFromPath(currentRepo, token, cb) {
    if (!await treehub.shouldShowTreeHub()) {
      return cb();
    }

    // (username)/(reponame)[/(type)][/(typeId)]
    const match = window.location.pathname.match(/([^\/]+)\/([^\/]+)(?:\/([^\/]+))?(?:\/([^\/]+))?/);

    const username = match[1];
    const reponame = match[2];
    const type = match[3];
    const typeId = match[4];

    const isPR = type === 'pull' && /^\d+$/.test(typeId);
    const isCommit = type === 'commit' && !!typeId;

    // Not a repository, skip
    if (~GH_RESERVED_USER_NAMES.indexOf(username) || ~GH_RESERVED_REPO_NAMES.indexOf(reponame)) {
      return cb();
    }

    let pullRefs = null;
    if (isPR) {
      pullRefs = this._getPullRefsFromDom();
      if (!pullRefs) {
        try {
          const pull = await this.getPullRequest({username, reponame}, typeId, token);
          pullRefs = {base: pull.base.ref, head: pull.head.ref};
        } catch (err) {
          return cb(err);
        }
      }
    }

    const branch =
      // The commit shown
      (isCommit && typeId) ||
      // The target branch of a pull request
      (pullRefs && pullRefs.base) ||
      // The branch (or commit) of tree and blob URLs
      ((type === 'tree' || type === 'blob') && typeId) ||
      // The branch shown last in this repository
      (currentRepo.username === username && currentRepo.reponame === reponame && currentRepo.branch) ||
      // The default branch, when known (else it is requested below)
      this._defaultBranch[username + '/' + reponame];

    const showChanges = await extStore.get(STORE.PR);
    const pullNumber = isPR && showChanges ? typeId : null;
    const commitSha = isCommit && showChanges ? typeId : null;
    const displayBranch = pullRefs && pullRefs.head ? `${pullRefs.base} < ${pullRefs.head}` : null;
    const repo = {username, reponame, branch, displayBranch, pullNumber, commitSha};
    if (repo.branch) {
      cb(null, repo);
    } else {
      // Still no luck, get default branch for real
      this._get(null, {repo, token}, (err, data) => {
        if (err) return cb(err);
        repo.branch = this._defaultBranch[username + '/' + reponame] = data.default_branch || 'master';
        cb(null, repo);
      });
    }
  }

  // @override
  loadCodeTree(opts, cb) {
    opts.encodedBranch = encodeURIComponent(decodeURIComponent(opts.repo.branch));
    opts.path = (opts.node && (opts.node.sha || opts.encodedBranch)) || opts.encodedBranch + '?recursive=1';
    this._loadCodeTreeInternal(opts, null, cb);
  }

  get isOnPRPage() {
    const match = window.location.pathname.match(/([^\/]+)\/([^\/]+)(?:\/([^\/]+))?(?:\/([^\/]+))?/);

    if (!match) return false;

    const type = match[3];

    return type === 'pull';
  }

  get isOnCommitPage() {
    return /^\/[^\/]+\/[^\/]+\/commit\/[^\/]+/.test(location.pathname);
  }

  /**
   * Whether the current page shows all changes of a pull request (i.e. "Files changed").
   */
  get isOnPRFilesPage() {
    return !!this.getPullOfFilesPage();
  }

  /**
   * Returns the pull request of the current "Files changed" page, if any.
   * @return {?{username: string, reponame: string, pullNumber: string}}
   */
  getPullOfFilesPage() {
    const match = location.pathname.match(GH_PR_FILES_PATH);
    return match ? {username: match[1], reponame: match[2], pullNumber: match[3]} : null;
  }

  /**
   * Returns the diff containers of the current page, one per changed file.
   * @return {!Array<!Element>}
   */
  getDiffContainers() {
    return Array.from(document.querySelectorAll('div[id^="diff-"]')).filter((el) => GH_DIFF_ID.test(el.id));
  }

  /**
   * Inserts an element among the actions of the header of a diff.
   * @return {boolean} whether it was inserted.
   */
  insertDiffHeaderAction(diffEl, el) {
    // New UI: next to the "Viewed" button
    const viewedButton = diffEl.querySelector('button[class*="MarkAsViewedButton"]');
    if (viewedButton) {
      viewedButton.parentElement.insertBefore(el, viewedButton);
      return true;
    }

    const header = diffEl.querySelector('[class*="DiffFileHeader-module__diff-file-header"]');
    const actions = header && header.querySelector('.flex-justify-end');
    if (actions) {
      const first = actions.firstElementChild;
      const group = first && first.matches('div') ? first : actions;
      group.insertBefore(el, group.firstChild);
      return true;
    }

    // Classic UI
    const fileActions = diffEl.querySelector('.file-header .file-actions');
    if (fileActions) {
      const group = fileActions.querySelector('.d-flex') || fileActions;
      group.insertBefore(el, group.firstChild);
      return true;
    }

    return false;
  }

  // @override
  selectFile(path) {
    // Changes link to anchors of the diff page (#diff-<id>, #r<comment id>). If the target is in the
    // current page, scroll to it instead of navigating.
    const [pathname, anchor] = path.split('#');
    if (anchor && this._isSameDiffPage(pathname)) {
      if (this.scrollToAnchor(anchor)) return;
      // Not rendered yet (e.g. lazy-loaded diff), let GitHub handle the anchor
      location.hash = anchor;
      return;
    }

    // Another page: GitHub loads it and scrolls to the anchor
    if (anchor) return this.navigate(path);

    super.selectFile(path);
  }

  /**
   * Scrolls to an element of the current page, e.g. a diff or a review comment.
   * @return {boolean} whether the element was found.
   */
  scrollToAnchor(anchor) {
    let el = document.getElementById(anchor);
    if (!el) {
      // New commit page: <div role="region">...<table data-diff-anchor="diff-...">
      const table = document.querySelector(`[data-diff-anchor="${CSS.escape(anchor)}"]`);
      el = table && (table.closest('[role="region"]') || table);
    }
    if (!el) return false;

    history.replaceState(history.state, '', `${location.pathname}${location.search}#${anchor}`);

    // Jump to the element to find out which sticky headers cover it, then scroll smoothly below them.
    // No paint happens in between, so there's no flicker. GitHub sets `scroll-behavior: smooth`,
    // hence the explicit 'instant' jumps.
    const startY = window.scrollY;
    el.scrollIntoView({block: 'start', behavior: 'instant'});
    const offset = this._getStickyHeaderHeight() + 8;
    const targetY = window.scrollY - offset;
    window.scrollTo({top: startY, behavior: 'instant'});
    if (Math.abs(targetY - startY) < 1) return true;
    window.scrollTo({top: targetY, behavior: 'smooth'});

    // Diffs rendered while scrolling (e.g. virtualized in the new GitHub UI) can move the target, fix it up
    // once the scroll ends, unless users take over the scrolling meanwhile
    const fixUp = () => {
      stop();
      const delta = el.getBoundingClientRect().top - offset;
      if (Math.abs(delta) > 4) window.scrollBy({top: delta, behavior: 'instant'});
    };
    const stop = () => {
      clearTimeout(timer);
      window.removeEventListener('scrollend', fixUp);
      ['wheel', 'touchstart', 'keydown', 'mousedown'].forEach((type) => window.removeEventListener(type, stop));
    };
    const timer = setTimeout(stop, 3000);
    window.addEventListener('scrollend', fixUp);
    ['wheel', 'touchstart', 'keydown', 'mousedown'].forEach((type) => {
      window.addEventListener(type, stop, {passive: true});
    });
    return true;
  }

  /**
   * Height of the page headers stuck at the top of the viewport.
   */
  _getStickyHeaderHeight() {
    let bottom = 0;
    for (const el of document.elementsFromPoint(window.innerWidth / 2, 1)) {
      for (let node = el; node && node !== document.body; node = node.parentElement) {
        const position = getComputedStyle(node).position;
        if ((position === 'sticky' || position === 'fixed') && !node.closest('.treehub-sidebar')) {
          bottom = Math.max(bottom, node.getBoundingClientRect().bottom);
          break;
        }
      }
    }
    return Math.min(bottom, window.innerHeight / 2);
  }

  /**
   * Whether pathname is the current page. The "Files changed" page of a pull request can be
   * either /pull/<number>/files or /pull/<number>/changes (new GitHub UI).
   */
  _isSameDiffPage(pathname) {
    if (pathname === location.pathname) return true;
    const target = pathname.match(GH_PR_FILES_PATH);
    const current = location.pathname.match(GH_PR_FILES_PATH);
    return !!(target && current && target.slice(1, 4).join('/') === current.slice(1, 4).join('/'));
  }

  /**
   * Returns the path of the file whose diff anchor (diff-<sha256>) is given, if it's part of loaded changes.
   */
  getPathFromDiffAnchor(anchor) {
    return this._diffAnchors && this._diffAnchors[anchor.replace(/^#?diff-/, '')];
  }

  // @override
  _getTree(path, opts, cb) {
    if (opts.repo.pullNumber || opts.repo.commitSha) {
      this._getPatch(opts, cb);
    } else {
      this._get(`/git/trees/${path}`, opts, (err, res) => {
        if (err) cb(err);
        else cb(null, res.tree);
      });
    }
  }

  /**
   * Get files that were patched in Pull Request or commit.
   * The diff map that is returned contains changed files, as well as the parents of the changed files.
   * This allows the tree to be filtered for only folders that contain files with diffs.
   * @param {Object} opts: {
   *                  path: the starting path to load the tree,
   *                  repo: the current repository,
   *                  node (optional): the selected node (null to load entire tree),
   *                  token (optional): the personal access token
   *                 }
   * @param {Function} cb(err: error, diffMap: Object)
   */
  _getPatch(opts, cb) {
    const {repo, token} = opts;
    const getChanges = repo.pullNumber
      ? this.getPullRequestChanges(repo, token, {reload: true})
      : this.getCommitChanges(repo, token, {reload: true});

    getChanges.then(
      (changes) => {
        const diffMap = {};
        this._diffAnchors = {};

        changes.files.forEach((file) => {
          this._diffAnchors[file.diffId] = file.filename;

          // Record file patch info
          diffMap[file.filename] = {
            type: 'blob',
            diffId: file.diffId,
            diffPath: changes.diffPath,
            action: file.status,
            additions: file.additions,
            blob_url: file.blob_url,
            deletions: file.deletions,
            filename: file.filename,
            previous: file.previous_filename,
            path: file.path,
            sha: file.sha,
            viewed: changes.viewed ? changes.viewed[file.filename] === 'VIEWED' : undefined,
            threads: changes.threads[file.filename] || []
          };

          // Record ancestor folders
          const folderPath = file.filename
            .split('/')
            .slice(0, -1)
            .join('/');
          const split = folderPath.split('/');

          // Aggregate metadata for ancestor folders
          split.reduce((path, curr) => {
            if (path.length) path = `${path}/${curr}`;
            else path = `${curr}`;

            if (diffMap[path] == null) {
              diffMap[path] = {
                type: 'tree',
                filename: path,
                filesChanged: 1,
                additions: file.additions,
                deletions: file.deletions
              };
            } else {
              diffMap[path].additions += file.additions;
              diffMap[path].deletions += file.deletions;
              diffMap[path].filesChanged++;
            }
            return path;
          }, '');
        });

        // Transform to emulate response from get `tree`
        const tree = Object.keys(diffMap).map((fileName) => {
          const patch = diffMap[fileName];
          return {
            patch,
            path: fileName,
            sha: patch.sha,
            type: patch.type,
            url: patch.blob_url
          };
        });

        // Sort by path, needs to be alphabetical order (so parent folders come before children)
        // Note: this is still part of the above transform to mimic the behavior of get tree
        tree.sort((a, b) => a.path.localeCompare(b.path));

        cb(null, tree);
      },
      (err) => cb(err)
    );
  }

  /**
   * Returns the pull request details (cached).
   * @param {{username: string, reponame: string}} repo
   * @param {string|number} number
   * @param {string=} token
   * @return {!Promise<Object>}
   */
  getPullRequest(repo, number, token) {
    return this._cached(`pull:${repo.username}/${repo.reponame}#${number}`, async () => {
      const {data} = await this._api(`/pulls/${number}`, {repo, token});
      return data;
    });
  }

  /**
   * Returns the commit a pull request's changes are computed from: the merge base of its base and head (cached).
   * @return {!Promise<string>} commit SHA
   */
  getMergeBase(repo, token, baseSha, headSha) {
    return this._cached(`merge-base:${repo.username}/${repo.reponame}:${baseSha}...${headSha}`, async () => {
      const {data} = await this._api(`/compare/${baseSha}...${headSha}?per_page=1`, {repo, token});
      return data.merge_base_commit.sha;
    });
  }

  /**
   * Returns the changes of a pull request (cached): changed files with their patches and diff anchors,
   * review threads grouped by path and the viewed state of each file if available.
   * @param {!Object} repo
   * @param {string=} token
   * @param {{reload: boolean}=} options
   */
  getPullRequestChanges(repo, token, {reload = false} = {}) {
    const key = `changes:${repo.username}/${repo.reponame}#${repo.pullNumber}`;
    return this._cached(key, async () => {
      const opts = {repo, token};
      const [files, threads, viewed] = await Promise.all([
        this._getAll(`/pulls/${repo.pullNumber}/files`, opts).then((files) => this._addDiffIds(files)),
        this._getReviewThreads(opts),
        this._getViewedState(opts)
      ]);

      // The head commit of this snapshot of the changes, e.g. from .../raw/<sha>/path
      const withRef = files.find((file) => file.status !== 'removed' && /\/raw\/[0-9a-f]{40}\//.test(file.raw_url));
      const headSha = withRef ? withRef.raw_url.match(/\/raw\/([0-9a-f]{40})\//)[1] : null;

      return {
        files,
        threads,
        headSha,
        viewed: viewed || this._readViewedStateFromPage(files),
        diffPath: `/${repo.username}/${repo.reponame}/pull/${repo.pullNumber}/files`
      };
    }, reload);
  }

  /**
   * Makes the next getPullRequestChanges() call fetch fresh data.
   */
  invalidatePullRequestChanges(repo) {
    delete this._cache[`changes:${repo.username}/${repo.reponame}#${repo.pullNumber}`];
  }

  /**
   * Returns the changes of a commit (cached), in the same format as getPullRequestChanges().
   */
  getCommitChanges(repo, token, {reload = false} = {}) {
    const key = `commit:${repo.username}/${repo.reponame}@${repo.commitSha}`;
    return this._cached(key, async () => {
      const opts = {repo, token};
      const files = [];
      let url = `/commits/${repo.commitSha}?per_page=100`;

      for (let page = 0; url && page < GH_MAX_PAGES; page++) {
        const {data, jqXHR} = await this._api(url, opts);
        files.push(...(data.files || []));
        url = this._getNextPageUrl(jqXHR);
      }

      const threads = {};
      if (await extStore.get(STORE.COMMENTS)) {
        const comments = await this._getAll(`/commits/${repo.commitSha}/comments`, opts).catch(() => []);
        comments
          .filter((comment) => comment.path)
          .forEach((comment) => {
            (threads[comment.path] = threads[comment.path] || []).push(this._toThread([comment], {
              url: `/${repo.username}/${repo.reponame}/commit/${repo.commitSha}#r${comment.id}`,
              outdated: comment.position == null
            }));
          });
      }

      return {
        files: await this._addDiffIds(files),
        threads,
        viewed: null,
        diffPath: `/${repo.username}/${repo.reponame}/commit/${repo.commitSha}`
      };
    }, reload);
  }

  /**
   * Returns the content of a file at a given commit.
   * Uses the raw endpoint of the website (works for public repos and, when signed in, private repos),
   * then falls back to the API.
   */
  async getFileContent(repo, token, path, ref) {
    const encodedPath = path.split('/').map(encodeURIComponent).join('/');
    try {
      const res = await fetch(`${location.origin}/${repo.username}/${repo.reponame}/raw/${ref}/${encodedPath}`, {
        credentials: 'same-origin'
      });
      if (res.ok) return await res.text();
    } catch (ignored) {}

    const {data} = await this._api(`/contents/${encodedPath}?ref=${ref}`, {repo, token}, {
      accept: 'application/vnd.github.raw',
      dataType: 'text'
    });
    return data;
  }

  /**
   * Searches open pull requests of a repository.
   * @param {!Object} repo
   * @param {string=} token
   * @param {string} qualifiers additional search qualifiers, e.g. "review:approved"
   * @param {number} page 1-based page
   * @return {!Promise<{items: !Array<Object>, hasMore: boolean}>}
   */
  async searchPullRequests(repo, token, qualifiers, page = 1) {
    const perPage = 30;
    const query = `repo:${repo.username}/${repo.reponame} is:pr is:open ${qualifiers}`.trim();
    const url = `${GH_API}/search/issues?q=${encodeURIComponent(query)}` +
      `&sort=created&order=desc&per_page=${perPage}&page=${page}`;
    const {data} = await this._api(url, {repo, token});
    return {items: data.items, hasMore: page * perPage < Math.min(data.total_count, 1000)};
  }

  /**
   * Returns the pending review of the current user for a pull request, if any.
   */
  async getPendingReview(repo, token) {
    if (!token) return null;
    const reviews = await this._getAll(`/pulls/${repo.pullNumber}/reviews`, {repo, token});
    return reviews.find((review) => review.state === 'PENDING') || null;
  }

  /**
   * Adds a review comment to a pull request, on lines of the diff or on the whole file.
   * GitHub only accepts line comments on lines of the diff (hunks), and multi-line ones within one hunk.
   * @param {{path: string, line: number=, side: string=, startLine: number=, startSide: string=, body: string,
   *   commitId: string}} comment line and side are omitted for a comment on the file, startLine and startSide
   *   are set for a comment on several lines (from startLine to line).
   * @param {boolean} asReview whether to add the comment to the pending review (created if needed)
   *   instead of publishing it right away.
   * @return {!Promise<{id: number, author: string, pending: boolean}>}
   */
  async addReviewComment(repo, token, {path, line, side, startLine, startSide, body, commitId}, asReview) {
    const opts = {repo, token};
    const lines = startLine ? {line, side, start_line: startLine, start_side: startSide} : {line, side};
    const target = line ? Object.assign({path}, lines) : {path, subject_type: 'file'};

    if (!asReview) {
      const {data} = await this._api(`/pulls/${repo.pullNumber}/comments`, opts, {
        method: 'POST',
        data: Object.assign({body, commit_id: commitId}, target)
      });
      return {id: data.id, author: data.user && data.user.login, pending: false};
    }

    let pendingReview = await this.getPendingReview(repo, token);
    if (!pendingReview) {
      // Reviews can be created with line comments only, add a file comment right after creating the review
      const {data} = await this._api(`/pulls/${repo.pullNumber}/reviews`, opts, {
        method: 'POST',
        data: line ? {commit_id: commitId, comments: [Object.assign({body}, target)]} : {commit_id: commitId}
      });
      if (line) return {id: data.id, author: data.user && data.user.login, pending: true};
      pendingReview = data;
    }

    const result = await this._graphql(GH_ADD_REVIEW_THREAD_MUTATION, {
      reviewId: pendingReview.node_id,
      path,
      body,
      line: line || null,
      side: line ? side : null,
      startLine: startLine || null,
      startSide: startLine ? startSide : null,
      subjectType: line ? 'LINE' : 'FILE'
    }, opts);
    const thread = result.addPullRequestReviewThread && result.addPullRequestReviewThread.thread;
    if (!thread) {
      throw {message: line ? `GitHub couldn't add a comment to line ${line}.` : 'GitHub couldn\'t add the comment.'};
    }
    const comment = thread.comments.nodes[0];
    return {id: comment.databaseId, author: comment.author && comment.author.login, pending: true};
  }

  /**
   * Review threads of a pull request grouped by file path.
   * Uses GraphQL when a token is available (to know which threads are resolved), otherwise REST.
   * @return {!Promise<!Object<string, !Array<Object>>>}
   */
  async _getReviewThreads(opts) {
    const byPath = {};
    if (!(await extStore.get(STORE.COMMENTS))) return byPath;

    const {repo} = opts;
    const commentUrl = (id) => `/${repo.username}/${repo.reponame}/pull/${repo.pullNumber}/files#r${id}`;
    let threads = null;

    if (opts.token) {
      try {
        const nodes = await this._graphqlAll(GH_REVIEW_THREADS_QUERY, 'reviewThreads', opts);
        threads = nodes
          .filter((node) => node.comments.nodes.length)
          .map((node) => {
            const comments = node.comments.nodes.map((comment) => ({
              id: comment.databaseId,
              author: comment.author ? comment.author.login : 'ghost',
              body: comment.bodyText,
              createdAt: comment.createdAt
            }));
            return {
              id: comments[0].id,
              path: node.path,
              line: node.line,
              originalLine: node.originalLine,
              startLine: node.startLine,
              side: node.diffSide,
              resolved: node.isResolved,
              outdated: node.isOutdated,
              url: commentUrl(comments[0].id),
              comments
            };
          });
      } catch (err) {
        // E.g. the token can't access the GraphQL API; fall back to REST below
      }
    }

    if (!threads) {
      const comments = await this._getAll(`/pulls/${repo.pullNumber}/comments`, opts).catch(() => []);
      const groups = new Map();
      comments.forEach((comment) => {
        const rootId = comment.in_reply_to_id || comment.id;
        if (!groups.has(rootId)) groups.set(rootId, []);
        groups.get(rootId).push(comment);
      });
      threads = Array.from(groups.values()).map((group) => {
        group.sort((a, b) => a.created_at.localeCompare(b.created_at));
        return this._toThread(group, {url: commentUrl(group[0].id), outdated: group[0].line == null});
      });
    }

    threads.forEach((thread) => {
      (byPath[thread.path] = byPath[thread.path] || []).push(thread);
    });
    return byPath;
  }

  /**
   * Converts REST comments (the first one being the root) into a thread.
   */
  _toThread(comments, {url, outdated}) {
    const root = comments[0];
    return {
      id: root.id,
      path: root.path,
      line: root.line,
      originalLine: root.original_line,
      startLine: root.start_line,
      side: root.side || 'RIGHT',
      resolved: null,
      outdated,
      url,
      comments: comments.map((comment) => ({
        id: comment.id,
        author: comment.user ? comment.user.login : 'ghost',
        body: comment.body,
        createdAt: comment.created_at
      }))
    };
  }

  /**
   * Viewed state of the files of a pull request, e.g. {"path/to/file": "VIEWED"}.
   * Needs a token (GraphQL API), resolves to null otherwise.
   * @return {!Promise<?Object<string, string>>}
   */
  async _getViewedState(opts) {
    if (!opts.token) return null;
    try {
      const nodes = await this._graphqlAll(GH_VIEWED_FILES_QUERY, 'files', opts);
      return nodes.reduce((viewed, node) => {
        viewed[node.path] = node.viewerViewedState;
        return viewed;
      }, {});
    } catch (err) {
      return null;
    }
  }

  /**
   * Reads which files are marked as viewed in the "Files changed" page.
   * @param {!Array<Object>} files changed files with their diffId
   * @return {?Object<string, string>} null if the page doesn't show viewed checkboxes.
   */
  _readViewedStateFromPage(files) {
    if (!this.isOnPRFilesPage) return null;

    const pathsByDiffId = {};
    files.forEach((file) => (pathsByDiffId[file.diffId] = file.filename));

    let found = false;
    const viewed = {};
    this.getDiffContainers().forEach((el) => {
      const state = this._getViewedStateOfDiff(el);
      const path = pathsByDiffId[el.id.slice('diff-'.length)];
      if (state != null && path) {
        found = true;
        viewed[path] = state ? 'VIEWED' : 'UNVIEWED';
      }
    });
    return found ? viewed : null;
  }

  _closestDiffContainer(el) {
    for (; el; el = el.parentElement) {
      if (el.id && GH_DIFF_ID.test(el.id)) return el;
    }
    return null;
  }

  /**
   * @return {?boolean} whether the diff is marked as viewed, null if unknown.
   */
  _getViewedStateOfDiff(diffEl) {
    const button = diffEl.querySelector('button[class*="MarkAsViewedButton"]');
    if (button) return button.getAttribute('aria-pressed') === 'true';

    const checkbox = diffEl.querySelector('input.js-reviewed-checkbox');
    if (checkbox) return checkbox.checked;

    return null;
  }

  _getPathOfDiff(diffEl) {
    return this.getPathFromDiffAnchor(diffEl.id);
  }

  /**
   * Keeps the viewed state in the sidebar in sync when users toggle "Viewed" in the page.
   */
  _observeViewedToggles() {
    const notify = (target) => {
      const diffEl = this._closestDiffContainer(target);
      if (!diffEl) return;
      const viewed = this._getViewedStateOfDiff(diffEl);
      const path = this._getPathOfDiff(diffEl);
      if (viewed != null && path) {
        $(document).trigger(EVENT.VIEWED_CHANGE, {path, viewed});
      }
    };

    // New UI: aria-pressed of the "Viewed" button
    new window.MutationObserver((mutations) => {
      mutations.forEach((mutation) => {
        if (mutation.target.matches && mutation.target.matches('button[class*="MarkAsViewedButton"]')) {
          notify(mutation.target);
        }
      });
    }).observe(document.body, {attributes: true, attributeFilter: ['aria-pressed'], subtree: true});

    // Classic UI: "Viewed" checkbox
    document.addEventListener('change', (event) => {
      if (event.target.matches && event.target.matches('input.js-reviewed-checkbox')) notify(event.target);
    }, true);
  }

  /**
   * Reads the base and head branches of a pull request from the page.
   * @return {?{base: string, head: string}}
   */
  _getPullRefsFromDom() {
    const refOf = (text) => ((text || '').match(/:(.*)/) || [])[1];

    const $base = $('.commit-ref.base-ref');
    if ($base.length) {
      return {base: refOf($base.attr('title')), head: refOf($('.commit-ref.head-ref').attr('title'))};
    }

    // New pull request UI, e.g. <a data-component="BranchName">owner:branch</a>, base comes first
    const $refs = $('[data-component="BranchName"]');
    const base = refOf($refs.eq(0).text().trim());
    const head = refOf($refs.eq(1).text().trim());
    return base ? {base, head} : null;
  }

  async _addDiffIds(files) {
    await Promise.all(files.map(async (file) => {
      file.diffId = await sha256Hex(file.filename);
    }));
    return files;
  }

  /**
   * Caches the promise returned by fn for a while. Failed promises are not cached.
   */
  _cached(key, fn, reload = false) {
    const entry = this._cache[key];
    if (!reload && entry && Date.now() - entry.time < GH_CACHE_TTL) return entry.promise;

    const promise = fn();
    this._cache[key] = {time: Date.now(), promise};
    promise.catch(() => {
      if (this._cache[key] && this._cache[key].promise === promise) delete this._cache[key];
    });
    return promise;
  }


  _getNextPageUrl(jqXHR) {
    const match = (jqXHR.getResponseHeader('Link') || '').match(/<([^>]+)>;\s*rel="next"/);
    return match ? match[1] : null;
  }

  /**
   * Makes an API request.
   * @param {string} path relative to the repository API URL, or an absolute URL
   * @param {{repo: Object, token: string=}} opts
   * @param {{method: string=, data: Object=, accept: string=, dataType: string=}} settings
   * @return {!Promise<{data: *, jqXHR: Object}>} rejects with {error, message, status}
   */
  _api(path, opts, {method = 'GET', data, accept, dataType} = {}) {
    const url = path.startsWith('http')
      ? path
      : `${GH_API}/repos/${opts.repo.username}/${opts.repo.reponame}${path}`;
    const cfg = {url, method, cache: false, headers: {}};

    if (opts.token) cfg.headers.Authorization = 'token ' + opts.token;
    if (accept) cfg.headers.Accept = accept;
    if (dataType) cfg.dataType = dataType;
    if (data !== undefined) {
      cfg.data = JSON.stringify(data);
      cfg.contentType = 'application/json';
    }

    return new Promise((resolve, reject) => {
      $.ajax(cfg)
        .done((res, textStatus, jqXHR) => resolve({data: res, jqXHR}))
        .fail((jqXHR) => this._handleError(cfg, jqXHR, (err) => {
          // Keep the API's own message (e.g. validation errors), it's more useful than the generic one
          const apiMessage = jqXHR.responseJSON && jqXHR.responseJSON.message;
          const details = jqXHR.responseJSON && jqXHR.responseJSON.errors;
          reject(Object.assign(err, {apiMessage, details}));
        }));
    });
  }

  /**
   * Gets all pages of a list endpoint.
   */
  async _getAll(path, opts) {
    const items = [];
    let url = `${path}${path.includes('?') ? '&' : '?'}per_page=100`;

    for (let page = 0; url && page < GH_MAX_PAGES; page++) {
      const {data, jqXHR} = await this._api(url, opts);
      items.push(...data);
      url = this._getNextPageUrl(jqXHR);
    }

    return items;
  }

  async _graphql(query, variables, opts) {
    const {data} = await this._api(`${GH_API}/graphql`, opts, {method: 'POST', data: {query, variables}});
    if (data.errors && data.errors.length) {
      throw {error: 'Error: GraphQL', message: data.errors[0].message, apiMessage: data.errors[0].message};
    }
    return data.data;
  }

  /**
   * Gets all nodes of a paginated connection of a pull request.
   */
  async _graphqlAll(query, connection, opts) {
    const {repo} = opts;
    const nodes = [];
    let cursor = null;

    for (let page = 0; page < GH_MAX_PAGES; page++) {
      const data = await this._graphql(query, {
        owner: repo.username,
        name: repo.reponame,
        number: parseInt(repo.pullNumber, 10),
        cursor
      }, opts);
      const result = data.repository.pullRequest[connection];
      nodes.push(...result.nodes);
      if (!result.pageInfo.hasNextPage) break;
      cursor = result.pageInfo.endCursor;
    }

    return nodes;
  }

  // @override
  _getSubmodules(tree, opts, cb) {
    const item = tree.filter((item) => /^\.gitmodules$/i.test(item.path))[0];
    if (!item) return cb();

    this._get(`/git/blobs/${item.sha}`, opts, (err, res) => {
      if (err) return cb(err);
      const data = atob(res.content.replace(/\n/g, ''));
      cb(null, parseGitmodules(data));
    });
  }

  _get(path, opts, cb) {
    let url;

    if (path && path.startsWith('http')) {
      url = path;
    } else {
      url = `${GH_API}/repos/${opts.repo.username}/${opts.repo.reponame}${path || ''}`;
    }

    const cfg = {url, method: 'GET', cache: false};

    if (opts.token) {
      cfg.headers = {Authorization: 'token ' + opts.token};
    }

    $.ajax(cfg)
      .done((data, textStatus, jqXHR) => {
        (async () => {
          if (path && path.indexOf('/git/trees') === 0 && data.truncated) {
            try {
              const hugeRepos = await extStore.get(STORE.HUGE_REPOS);
              const repo = `${opts.repo.username}/${opts.repo.reponame}`;
              const repos = Object.keys(hugeRepos).filter((hugeRepoKey) => isValidTimeStamp(hugeRepos[hugeRepoKey]));
              if (!hugeRepos[repo]) {
                // If there are too many repos memoized, delete the oldest one
                if (repos.length >= GH_MAX_HUGE_REPOS_SIZE) {
                  const oldestRepo = repos.reduce((min, p) => (hugeRepos[p] < hugeRepos[min] ? p : min));
                  delete hugeRepos[oldestRepo];
                }
                hugeRepos[repo] = new Date().getTime();
                await extStore.set(STORE.HUGE_REPOS, hugeRepos);
              }
            } catch (ignored) {
            } finally {
              await this._handleError(cfg, {status: 206}, cb);
            }
          } else {
            cb(null, data, jqXHR);
          }
        })();
      })
      .fail((jqXHR) => this._handleError(cfg, jqXHR, cb));
  }
}
