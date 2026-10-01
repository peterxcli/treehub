<script setup lang="ts">
import {computed, onBeforeUnmount, onMounted, ref, watch} from 'vue';
import logo from '../../../icons/icon48.png';
import {STALE_MS} from '../config.ts';
import {needsAttention, prKey} from '../lib/status.ts';
import AccountMenu from './components/AccountMenu.vue';
import BookmarksView from './components/BookmarksView.vue';
import CredentialProblemCard from './components/CredentialProblemCard.vue';
import HistoryView from './components/HistoryView.vue';
import Octicon from './components/Octicon.vue';
import QueueView from './components/QueueView.vue';
import SearchView from './components/SearchView.vue';
import SignIn from './components/SignIn.vue';
import Toasts from './components/Toasts.vue';
import {init, loaded, problem, request, state} from './store.ts';

type View = 'queue' | 'bookmarks' | 'history' | 'search';
const VIEW_TITLES: Record<View, string> = {queue: 'Review queue', bookmarks: 'Bookmarks', history: 'History', search: 'Search'};
// #queue, #bookmarks, #history, #search?q=…
const readView = (): View => {
  const hash = location.hash.slice(1).split('?')[0];
  return hash === 'bookmarks' || hash === 'history' || hash === 'search' ? hash : 'queue';
};
const readQuery = () => new URLSearchParams(location.hash.split('?')[1] || '').get('q') || '';
const view = ref<View>(readView());
const query = ref(readQuery());
const onHashChange = () => {
  view.value = readView();
  query.value = readQuery();
};
/** Keeps the search in the address, for reloading and going back to it (without a history entry per letter). */
function setQuery(text: string) {
  query.value = text;
  history.replaceState(null, '', text ? `#search?q=${encodeURIComponent(text)}` : '#search');
}
/** "/" searches, as on GitHub. */
function onKeydown(event: KeyboardEvent) {
  const target = event.target as HTMLElement;
  if (event.key !== '/' || event.metaKey || event.ctrlKey || event.altKey || !account.value) return;
  if (target.closest('input, textarea, select, [contenteditable]')) return;
  event.preventDefault();
  if (view.value === 'search') document.querySelector<HTMLInputElement>('.search-box input')?.focus();
  else location.hash = 'search';
}

const account = computed(() => state.auth && state.auth.account);
const queueCount = computed(() => (state.hub ? state.hub.queue.length : 0));
const bookmarkCount = computed(() => (state.hub ? state.hub.bookmarks.length : 0));
const attentionCount = computed(() => {
  const {hub, statuses, auth} = state;
  if (!hub || !statuses || !auth || statuses.login !== auth.account.login) return 0;
  return hub.queue.filter((entry) => {
    const pr = statuses.states[prKey(entry)];
    return !!pr && needsAttention(pr);
  }).length;
});

/** Brings statuses up to date when the page is opened or shown again. */
function refreshIfStale() {
  if (state.auth) void request('refresh', {type: 'treehub:refresh', ifOlderThanMs: STALE_MS});
}
const onVisibilityChange = () => {
  if (document.visibilityState === 'visible') refreshIfStale();
};

onMounted(async () => {
  window.addEventListener('hashchange', onHashChange);
  document.addEventListener('keydown', onKeydown);
  document.addEventListener('visibilitychange', onVisibilityChange);
  await init();
  refreshIfStale();
});
onBeforeUnmount(() => {
  window.removeEventListener('hashchange', onHashChange);
  document.removeEventListener('keydown', onKeydown);
  document.removeEventListener('visibilitychange', onVisibilityChange);
});

// Signing in (here or in the sidebar of another tab) shows fresh data
watch(
  () => account.value && account.value.login,
  (login, previous) => {
    if (login && previous !== undefined && login !== previous) refreshIfStale();
  }
);

watch(
  [attentionCount, view],
  ([count]) => (document.title = `${count ? `(${count}) ` : ''}${VIEW_TITLES[view.value]} · TreeHub`),
  {immediate: true}
);
</script>

<template>
  <header class="topbar">
    <a class="brand" href="#queue">
      <img :src="logo" alt="" width="24" height="24" />
      <span>TreeHub</span>
    </a>
    <nav v-if="account" class="tabs" aria-label="Sections">
      <a href="#queue" :class="{selected: view === 'queue'}" :aria-current="view === 'queue' ? 'page' : undefined">
        <Octicon name="code-review" />
        Review queue
        <span class="count" :class="{attention: attentionCount > 0}" :title="attentionCount ? `${attentionCount} need your attention` : undefined">
          {{ attentionCount || queueCount }}
        </span>
      </a>
      <a href="#bookmarks" :class="{selected: view === 'bookmarks'}" :aria-current="view === 'bookmarks' ? 'page' : undefined">
        <Octicon name="bookmark" />
        Bookmarks
        <span class="count">{{ bookmarkCount }}</span>
      </a>
      <a href="#history" :class="{selected: view === 'history'}" :aria-current="view === 'history' ? 'page' : undefined">
        <Octicon name="history" />
        History
      </a>
      <a href="#search" :class="{selected: view === 'search'}" :aria-current="view === 'search' ? 'page' : undefined" title="Search (/)">
        <Octicon name="search" />
        Search
      </a>
    </nav>
    <div class="spacer" />
    <AccountMenu v-if="account" :account="account" />
  </header>

  <main>
    <template v-if="loaded">
      <SignIn v-if="!account" />
      <BookmarksView v-else-if="view === 'bookmarks'" />
      <HistoryView v-else-if="view === 'history'" />
      <SearchView v-else-if="view === 'search'" :query="query" @query="setQuery" />
      <QueueView v-else />
    </template>
  </main>

  <Toasts />

  <div v-if="problem" class="modal-backdrop" @click.self="problem = null">
    <CredentialProblemCard :problem="problem" dismissible class="modal" @dismiss="problem = null" />
  </div>
</template>
