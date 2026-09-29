const NODE_PREFIX = 'treehub';
const ADDON_CLASS = 'treehub';
const SHOW_CLASS = 'treehub-show';
const PINNED_CLASS = 'treehub-pinned';
const DOCK_RIGHT_CLASS = 'treehub-dock-right';
const VIEWED_CLASS = 'treehub-viewed';

const STORE = {
  TOKEN: 'treehub.token',
  HOVEROPEN: 'treehub.hover_open',
  PR: 'treehub.prdiff_shown',
  COMMENTS: 'treehub.pr_comments_shown',
  VIEW_FULL: 'treehub.pr_view_full',
  PR_FILTER: 'treehub.pr_filter',
  DOCK: 'treehub.sidebar_dock',
  HOTKEYS: 'treehub.hotkeys',
  ICONS: 'treehub.icons',
  LAZYLOAD: 'treehub.lazyload',
  POPUP: 'treehub.popup_shown',
  WIDTH: 'treehub.sidebar_width',
  SHOWN: 'treehub.sidebar_shown',
  PINNED: 'treehub.sidebar_pinned',
  HUGE_REPOS: 'treehub.huge_repos'
};

const DEFAULTS = {
  TOKEN: '',
  HOVEROPEN: true,
  PR: true,
  COMMENTS: true,
  VIEW_FULL: true,
  PR_FILTER: 'all',
  DOCK: 'left',
  LAZYLOAD: false,
  HOTKEYS: '⌘+⇧+s, ⌃+⇧+s',
  ICONS: true,
  POPUP: false,
  WIDTH: 232,
  SHOWN: false,
  PINNED: false,
  HUGE_REPOS: {}
};

const EVENT = {
  TOGGLE: 'treehub:toggle',
  TOGGLE_PIN: 'treehub:pin',
  LOC_CHANGE: 'treehub:location',
  LAYOUT_CHANGE: 'treehub:layout',
  REQ_START: 'treehub:start',
  REQ_END: 'treehub:end',
  STORE_CHANGE: 'treehub:storeChange',
  VIEW_READY: 'treehub:ready',
  VIEW_CLOSE: 'treehub:close',
  VIEW_SHOW: 'treehub:show',
  FETCH_ERROR: 'treehub:error',
  SIDEBAR_HTML_INSERTED: 'treehub:sidebarHtmlInserted',
  REPO_LOADED: 'treehub:repoLoaded',
  VIEWED_CHANGE: 'treehub:viewedChange'
};

window.STORE = STORE;
window.DEFAULTS = DEFAULTS;
window.EVENT = EVENT;
