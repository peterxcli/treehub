<script setup lang="ts">
import {computed, ref, watch} from 'vue';
import {STATUS_FILTER_LABELS, STATUS_ORDER, needsAttention, prKey, type PRState, type StatusKey} from '../../lib/status.ts';
import type {QueueEntry} from '../../lib/storage.ts';
import {fullTime, parsePullRequest, timeAgo} from '../format.ts';
import {busy, clock, request, state, toast} from '../store.ts';
import CredentialProblemCard from './CredentialProblemCard.vue';
import Octicon from './Octicon.vue';
import QueueRow from './QueueRow.vue';

type Scope = 'attention' | 'open' | 'done' | 'all';
type Sort = 'activity' | 'updated' | 'added' | 'repo';

interface Row {
  key: string;
  entry: QueueEntry;
  state?: PRState;
}

const SCOPES: Array<{id: Scope; label: string}> = [
  {id: 'attention', label: 'Needs attention'},
  {id: 'open', label: 'Open'},
  {id: 'done', label: 'Done'},
  {id: 'all', label: 'All'}
];

const SORTS: Array<{id: Sort; label: string}> = [
  {id: 'activity', label: 'Needs attention first'},
  {id: 'updated', label: 'Recently updated'},
  {id: 'added', label: 'Recently added'},
  {id: 'repo', label: 'Repository'}
];

const remembered = (key: string) => {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
};
const remember = (key: string, value: string) => {
  try {
    localStorage.setItem(key, value);
  } catch {
    // Only a convenience
  }
};

const statuses = computed(() => {
  const {auth, statuses} = state;
  return auth && statuses && statuses.login === auth.account.login ? statuses : undefined;
});

const rows = computed<Row[]>(() =>
  ((state.hub && state.hub.queue) || []).map((entry) => {
    const key = prKey(entry);
    return {key, entry, state: statuses.value && statuses.value.states[key]};
  })
);

function inScope(row: Row, scope: Scope): boolean {
  const pr = row.state;
  switch (scope) {
    case 'attention':
      return !!pr && needsAttention(pr);
    case 'open':
      return !pr || !!pr.error || pr.state === 'open' || pr.state === 'draft';
    case 'done':
      return !!pr && !pr.error && (pr.state === 'merged' || pr.state === 'closed');
    default:
      return true;
  }
}

const counts = computed(() =>
  Object.fromEntries(SCOPES.map(({id}) => [id, rows.value.filter((row) => inScope(row, id)).length])) as Record<Scope, number>
);

// Until a scope is picked, show what needs attention, or else everything open
const chosenScope = ref<Scope | null>(remembered('treehub.queue.scope') as Scope | null);
const scope = computed<Scope>(() => chosenScope.value || (counts.value.attention ? 'attention' : 'open'));
function setScope(id: Scope) {
  chosenScope.value = id;
  remember('treehub.queue.scope', id);
}

const sort = ref<Sort>((remembered('treehub.queue.sort') as Sort | null) || 'activity');
watch(sort, (value) => remember('treehub.queue.sort', value));

// Statuses that rows must all have
const filters = ref<StatusKey[]>([]);
const scoped = computed(() => rows.value.filter((row) => inScope(row, scope.value)));
const hasStatus = (row: Row, key: StatusKey) => !!row.state && row.state.statuses.some((status) => status.key === key);

const available = computed(() =>
  STATUS_ORDER.map((key) => ({key, label: STATUS_FILTER_LABELS[key], count: scoped.value.filter((row) => hasStatus(row, key)).length}))
    .filter(({key, count}) => count > 0 || filters.value.includes(key))
);

function toggleFilter(key: StatusKey) {
  filters.value = filters.value.includes(key) ? filters.value.filter((k) => k !== key) : [...filters.value, key];
}

/** Latest time something happened on the pull request that TreeHub knows of. */
function activity(row: Row): number {
  const times = [row.entry.addedAt];
  if (row.state) {
    times.push(row.state.updatedAt);
    for (const status of row.state.statuses) if (status.at) times.push(status.at);
  }
  return Math.max(...times.map((time) => Date.parse(time) || 0));
}

const visible = computed(() => {
  const list = scoped.value.filter((row) => filters.value.every((key) => hasStatus(row, key)));
  const by = sort.value;
  return list.sort((a, b) => {
    if (by === 'activity') {
      const attention = Number(!!b.state && needsAttention(b.state)) - Number(!!a.state && needsAttention(a.state));
      return attention || activity(b) - activity(a);
    }
    if (by === 'updated') return activity(b) - activity(a);
    if (by === 'added') return Date.parse(b.entry.addedAt) - Date.parse(a.entry.addedAt);
    return a.entry.repo.localeCompare(b.entry.repo) || b.entry.number - a.entry.number;
  });
});

// ---------- Actions ----------

const input = ref('');

async function add() {
  const pr = parsePullRequest(input.value);
  if (!pr) {
    toast('Enter the URL of a pull request, or owner/repo#123.', {error: true});
    return;
  }
  if (rows.value.some((row) => row.key === prKey(pr))) {
    toast(`${pr.repo}#${pr.number} is already in your queue.`);
    input.value = '';
    return;
  }
  const result = await request('add', {type: 'treehub:setQueued', repo: pr.repo, number: pr.number, on: true});
  if (result !== undefined) {
    input.value = '';
    toast(`Added ${pr.repo}#${pr.number} to your queue.`);
  }
}

async function remove(row: Row) {
  const {repo, number, title} = row.entry;
  const result = await request(`row:${row.key}`, {type: 'treehub:setQueued', repo, number, on: false});
  if (result === undefined) return;
  toast(`Removed ${repo}#${number} from your queue.`, {
    action: {label: 'Undo', run: () => void request('undo', {type: 'treehub:setQueued', repo, number, on: true, title})}
  });
}

async function markSeen(row: Row) {
  const {repo, number} = row.entry;
  await request(`row:${row.key}`, {type: 'treehub:seen', repo, number, force: true});
}

async function refresh() {
  await request('refresh', {type: 'treehub:refresh'});
}
</script>

<template>
  <section class="page">
    <div class="page-head">
      <div>
        <h1>Review queue</h1>
        <p class="muted">
          Pull requests you are following, with what changed for you.
          <template v-if="statuses && statuses.refreshedAt">
            Updated <time :datetime="statuses.refreshedAt" :title="fullTime(statuses.refreshedAt)">{{ timeAgo(statuses.refreshedAt, clock) }}</time>.
          </template>
        </p>
      </div>
      <button type="button" class="btn" :disabled="busy.refresh" @click="refresh">
        <Octicon name="sync" :class="{spin: busy.refresh}" />
        {{ busy.refresh ? 'Refreshing…' : 'Refresh' }}
      </button>
    </div>

    <form class="add-form" @submit.prevent="add">
      <Octicon name="plus" class="add-icon" />
      <input
        v-model="input"
        type="text"
        placeholder="Add a pull request: paste its URL or type owner/repo#123"
        aria-label="Pull request to add"
        spellcheck="false"
        autocomplete="off"
      />
      <button type="submit" class="btn btn-primary" :disabled="busy.add || !input.trim()">Add</button>
    </form>

    <CredentialProblemCard v-if="statuses && statuses.problem" :problem="statuses.problem">
      <button type="button" class="btn" :disabled="busy.refresh" @click="refresh">Retry</button>
    </CredentialProblemCard>
    <div v-else-if="statuses && statuses.error" class="flash flash-error">
      <Octicon name="alert" />
      <span>{{ statuses.error }}</span>
      <button type="button" class="btn btn-sm" :disabled="busy.refresh" @click="refresh">Retry</button>
    </div>

    <template v-if="rows.length">
      <div class="queue-controls">
        <div class="segmented" role="tablist" aria-label="Show">
          <button
            v-for="item in SCOPES"
            :key="item.id"
            type="button"
            role="tab"
            :aria-selected="scope === item.id"
            :class="{selected: scope === item.id, attention: item.id === 'attention' && counts.attention > 0}"
            @click="setScope(item.id)"
          >
            {{ item.label }} <span class="count">{{ counts[item.id] }}</span>
          </button>
        </div>
        <label class="sort">
          <span class="muted">Sort</span>
          <select v-model="sort">
            <option v-for="item in SORTS" :key="item.id" :value="item.id">{{ item.label }}</option>
          </select>
        </label>
      </div>

      <div v-if="available.length" class="filters" aria-label="Filter by status">
        <Octicon name="filter" class="muted" />
        <button
          v-for="item in available"
          :key="item.key"
          type="button"
          class="filter"
          :class="{selected: filters.includes(item.key)}"
          :aria-pressed="filters.includes(item.key)"
          @click="toggleFilter(item.key)"
        >
          {{ item.label }} <span class="count">{{ item.count }}</span>
        </button>
        <button v-if="filters.length" type="button" class="link" @click="filters = []">Clear</button>
      </div>

      <ul v-if="visible.length" class="pr-list">
        <QueueRow
          v-for="row in visible"
          :key="row.key"
          :entry="row.entry"
          :state="row.state"
          :busy="busy[`row:${row.key}`]"
          @remove="remove(row)"
          @seen="markSeen(row)"
        />
      </ul>
      <div v-else class="blankslate">
        <template v-if="filters.length">
          <h2>No pull requests match these filters</h2>
          <button type="button" class="btn" @click="filters = []">Clear filters</button>
        </template>
        <template v-else-if="scope === 'attention'">
          <Octicon name="check-circle" :size="32" class="success" />
          <h2>You are all caught up</h2>
          <p>Nothing in your queue needs your attention right now.</p>
        </template>
        <template v-else>
          <h2>Nothing here</h2>
          <p>No pull requests of your queue are in this list.</p>
        </template>
      </div>
    </template>

    <div v-else class="blankslate">
      <Octicon name="code-review" :size="32" />
      <h2>Your review queue is empty</h2>
      <p>
        On a pull request, click <Octicon name="code-review" /> in the TreeHub sidebar to follow it here, or paste its
        link above. TreeHub then tells you about review requests, new commits since your review, replies, mentions and
        more.
      </p>
    </div>
  </section>
</template>
