<script setup lang="ts">
import {computed, onBeforeUnmount, onMounted, ref, watch} from 'vue';
import logo from '../../../icons/icon48.png';
import {STALE_MS} from '../config.ts';
import {needsAttention, prKey} from '../lib/status.ts';
import AccountMenu from './components/AccountMenu.vue';
import BookmarksView from './components/BookmarksView.vue';
import Octicon from './components/Octicon.vue';
import QueueView from './components/QueueView.vue';
import SignIn from './components/SignIn.vue';
import Toasts from './components/Toasts.vue';
import {init, loaded, request, state} from './store.ts';

type View = 'queue' | 'bookmarks';
const readView = (): View => (location.hash === '#bookmarks' ? 'bookmarks' : 'queue');
const view = ref<View>(readView());
const onHashChange = () => (view.value = readView());

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
  document.addEventListener('visibilitychange', onVisibilityChange);
  await init();
  refreshIfStale();
});
onBeforeUnmount(() => {
  window.removeEventListener('hashchange', onHashChange);
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
  ([count]) => (document.title = `${count ? `(${count}) ` : ''}${view.value === 'bookmarks' ? 'Bookmarks' : 'Review queue'} · TreeHub`),
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
    </nav>
    <div class="spacer" />
    <AccountMenu v-if="account" :account="account" />
  </header>

  <main>
    <template v-if="loaded">
      <SignIn v-if="!account" />
      <BookmarksView v-else-if="view === 'bookmarks'" />
      <QueueView v-else />
    </template>
  </main>

  <Toasts />
</template>
