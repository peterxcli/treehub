<script setup lang="ts">
import {computed, onBeforeUnmount, onMounted, ref, watch} from 'vue';
import type {HistoryEntry, HistorySettings} from '../../lib/storage.ts';
import {fullTime, groupByDay} from '../format.ts';
import {busy, clock, request, toast} from '../store.ts';
import Octicon from './Octicon.vue';

type Kind = 'all' | 'pull' | 'repo';

const KINDS: Array<{id: Kind; label: string}> = [
  {id: 'all', label: 'All'},
  {id: 'pull', label: 'Pull requests'},
  {id: 'repo', label: 'Repositories'}
];
const RETENTIONS = [7, 14, 30, 60, 90, 180, 365];
const PAGE_SIZE = 50;

const kind = ref<Kind>('all');
const entries = ref<HistoryEntry[]>([]);
const nextCursor = ref<string | undefined>();
const loading = ref(false);
const loaded = ref(false);
const settings = ref<HistorySettings | null>(null);

let lastLoad = 0;

/** Loads the first page again (replacing any load in progress), or the next page. */
async function load(more = false) {
  if (more && (loading.value || !nextCursor.value)) return;
  const id = ++lastLoad;
  loading.value = true;
  const page = await request<{entries: HistoryEntry[]; nextCursor?: string}>('history', {
    type: 'treehub:listHistory',
    limit: PAGE_SIZE,
    cursor: more ? nextCursor.value : undefined,
    kind: kind.value === 'all' ? undefined : kind.value
  });
  // A newer load (e.g. another filter) replaced this one
  if (id !== lastLoad) return;
  loading.value = false;
  loaded.value = true;
  if (!page) return;
  entries.value = more ? [...entries.value, ...page.entries] : page.entries;
  nextCursor.value = page.nextCursor;
}

// Pages opened meanwhile show when coming back to the dashboard
const onVisibilityChange = () => {
  if (document.visibilityState === 'visible') void load();
};

onMounted(async () => {
  document.addEventListener('visibilitychange', onVisibilityChange);
  const [stored] = await Promise.all([
    request<HistorySettings>('historySettings', {type: 'treehub:getHistorySettings'}),
    load()
  ]);
  settings.value = stored || null;
});
onBeforeUnmount(() => document.removeEventListener('visibilitychange', onVisibilityChange));
watch(kind, () => void load());

const groups = computed(() => groupByDay(entries.value, (entry) => entry.lastViewedAt, clock.value));

const url = (entry: HistoryEntry) =>
  `https://github.com/${entry.repo}${entry.kind === 'pull' ? `/pull/${entry.number}` : ''}`;
const time = (iso: string) => new Date(iso).toLocaleTimeString(undefined, {hour: '2-digit', minute: '2-digit'});
const views = (count: number) => (count === 1 ? 'viewed once' : `viewed ${count} times`);

async function remove(entry: HistoryEntry) {
  const {kind: entryKind, repo, number} = entry;
  const result = await request('historyEntry', {type: 'treehub:deleteHistoryEntry', kind: entryKind, repo, number});
  if (result !== undefined) entries.value = entries.value.filter((e) => e !== entry);
}

async function clearAll() {
  const confirmed = window.confirm(
    'Clear your TreeHub history?\n\nEvery repository and pull request in it is deleted from the TreeHub server.'
  );
  if (!confirmed || (await request('clearHistory', {type: 'treehub:clearHistory'})) === undefined) return;
  entries.value = [];
  nextCursor.value = undefined;
  toast('History cleared.');
}

async function saveSettings(change: Partial<HistorySettings>) {
  if (!settings.value) return;
  const stored = await request<HistorySettings>('historySettings', {
    type: 'treehub:setHistorySettings',
    ...settings.value,
    ...change
  });
  if (!stored) return;
  settings.value = stored;
  // A shorter retention deletes older entries at once
  if (change.retentionDays !== undefined) await load();
}
</script>

<template>
  <section class="page">
    <div class="page-head">
      <div>
        <h1>History</h1>
        <p class="muted">
          Repositories and pull requests you opened on GitHub, most recent first.
          <template v-if="settings">Each is kept {{ settings.retentionDays }} days after you last opened it.</template>
        </p>
      </div>
      <div v-if="settings" class="history-settings">
        <label class="sort">
          <span class="muted">Keep for</span>
          <select
            :value="settings.retentionDays"
            :disabled="busy.historySettings"
            @change="saveSettings({retentionDays: Number(($event.target as HTMLSelectElement).value)})"
          >
            <option v-for="days in RETENTIONS" :key="days" :value="days">{{ days }} days</option>
          </select>
        </label>
        <button type="button" class="btn" :disabled="busy.historySettings" @click="saveSettings({paused: !settings.paused})">
          {{ settings.paused ? 'Resume recording' : 'Pause recording' }}
        </button>
        <button type="button" class="btn" :disabled="busy.clearHistory || !entries.length" @click="clearAll">
          <Octicon name="trash" /> Clear
        </button>
      </div>
    </div>

    <div v-if="settings && settings.paused" class="flash">
      <Octicon name="history" />
      <span>Recording is paused: the pages you open aren't added to your history.</span>
    </div>

    <div class="queue-controls">
      <div class="segmented" role="tablist" aria-label="Show">
        <button
          v-for="item in KINDS"
          :key="item.id"
          type="button"
          role="tab"
          :aria-selected="kind === item.id"
          :class="{selected: kind === item.id}"
          @click="kind = item.id"
        >
          {{ item.label }}
        </button>
      </div>
    </div>

    <div v-for="group in groups" :key="group.label" class="history-group">
      <h2 class="history-day">{{ group.label }}</h2>
      <ul class="pr-list">
        <li v-for="entry in group.items" :key="`${entry.kind}:${entry.repo}#${entry.number}`" class="pr history-row">
          <span class="pr-state" :class="entry.kind === 'pull' ? 'open' : ''">
            <Octicon :name="entry.kind === 'pull' ? 'git-pull-request' : 'repo'" />
          </span>
          <div class="pr-main">
            <a class="pr-title" :href="url(entry)" target="_blank" rel="noopener">
              {{ entry.kind === 'pull' ? entry.title || `Pull request #${entry.number}` : entry.repo }}
            </a>
            <div class="pr-meta">
              <template v-if="entry.kind === 'pull'">
                <a :href="`https://github.com/${entry.repo}`" target="_blank" rel="noopener">{{ entry.repo }}</a>
                <span>#{{ entry.number }}</span>
                <span class="sep">·</span>
              </template>
              <span :title="`First opened ${fullTime(entry.firstViewedAt)}`">{{ views(entry.viewCount) }}</span>
            </div>
          </div>
          <div class="pr-actions">
            <time class="history-time muted" :datetime="entry.lastViewedAt" :title="fullTime(entry.lastViewedAt)">
              {{ time(entry.lastViewedAt) }}
            </time>
            <button
              type="button"
              class="icon-button danger"
              title="Remove from your history"
              aria-label="Remove from your history"
              @click="remove(entry)"
            >
              <Octicon name="x" />
            </button>
          </div>
        </li>
      </ul>
    </div>

    <div v-if="nextCursor" class="load-more">
      <button type="button" class="btn" :disabled="loading" @click="load(true)">
        {{ loading ? 'Loading…' : 'Show older' }}
      </button>
    </div>

    <div v-if="loaded && !entries.length" class="blankslate">
      <Octicon name="history" :size="32" />
      <h2>No history{{ kind === 'all' ? ' yet' : ' here' }}</h2>
      <p>
        While you are signed in, TreeHub remembers the repositories and pull requests you open on GitHub, so that you
        can find them again here.
      </p>
    </div>
  </section>
</template>
