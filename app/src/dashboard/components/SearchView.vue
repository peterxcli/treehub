<script setup lang="ts">
// Searching the notes, titles and repositories of the bookmarks and the queue. The server ranks the results (BM25)
// and marks the matching words; searching while typing, the last word may be the start of one.
import {computed, nextTick, onMounted, ref, watch} from 'vue';
import type {SearchHit} from '../../lib/api.ts';
import {prKey} from '../../lib/status.ts';
import {markMatches} from '../format.ts';
import type {OcticonName} from '../icons.ts';
import {request, state} from '../store.ts';
import Octicon from './Octicon.vue';

const props = defineProps<{query: string}>();
const emit = defineEmits<{query: [text: string]}>();

const text = ref(props.query);
const hits = ref<SearchHit[] | null>(null);
const input = ref<HTMLInputElement | null>(null);
let timer: ReturnType<typeof setTimeout> | undefined;
let latest = 0;

async function search(query: string) {
  const id = ++latest;
  if (!query.trim()) {
    hits.value = null;
    return;
  }
  const result = await request<SearchHit[]>('search', {type: 'treehub:search', text: query});
  // Unless a newer search started meanwhile
  if (id === latest && result) hits.value = result;
}

watch(text, (query) => {
  emit('query', query);
  clearTimeout(timer);
  timer = setTimeout(() => void search(query), 200);
});
// Back or forward to another search
watch(
  () => props.query,
  (query) => {
    if (query !== text.value) text.value = query;
  }
);

onMounted(async () => {
  void search(text.value);
  await nextTick();
  input.value?.focus();
});

const PR_ICONS: Record<string, OcticonName> = {
  open: 'git-pull-request',
  draft: 'git-pull-request-draft',
  merged: 'git-merge',
  closed: 'git-pull-request-closed'
};

interface Result {
  hit: SearchHit;
  key: string;
  url: string;
  icon: OcticonName;
  // The color of the icon, as the queue's (or the bookmarks')
  iconClass: string;
  title: ReturnType<typeof markMatches>;
  repo: ReturnType<typeof markMatches>;
  note?: ReturnType<typeof markMatches>;
}

const results = computed<Result[]>(() =>
  (hits.value || []).map((hit) => {
    const queued = hit.kind === 'queue';
    const pr = queued && state.statuses ? state.statuses.states[prKey(hit)] : undefined;
    const prState = pr && !pr.error ? pr.state : undefined;
    return {
      hit,
      key: `${hit.kind}:${hit.repo}#${hit.number}`,
      url: queued ? (pr && pr.url) || `https://github.com/${hit.repo}/pull/${hit.number}` : `https://github.com/${hit.repo}`,
      icon: queued ? (prState && PR_ICONS[prState]) || 'git-pull-request' : 'repo',
      iconClass: queued ? prState || '' : 'bookmarked',
      title: hit.titleMatch ? markMatches(hit.titleMatch) : markMatches(queued ? `${hit.repoMatch}#${hit.number}` : hit.repoMatch),
      repo: markMatches(hit.repoMatch),
      note: hit.noteMatch ? markMatches(hit.noteMatch) : undefined
    };
  })
);
</script>

<template>
  <section class="page">
    <div class="page-head">
      <div>
        <h1>Search</h1>
        <p class="muted">Your notes, and the titles and repositories of your review queue and bookmarks.</p>
      </div>
    </div>

    <label class="add-form search-box">
      <Octicon name="search" class="add-icon" />
      <input
        ref="input"
        v-model="text"
        type="search"
        placeholder="Search notes, pull requests and repositories"
        aria-label="Search"
        spellcheck="false"
        autocomplete="off"
      />
    </label>

    <ul v-if="results.length" class="pr-list search-results">
      <li v-for="result in results" :key="result.key" class="pr">
        <span class="pr-state" :class="result.iconClass">
          <Octicon :name="result.icon" />
        </span>
        <div class="pr-main">
          <a class="pr-title" :href="result.url" target="_blank" rel="noopener">
            <template v-for="(part, i) in result.title" :key="i"><mark v-if="part.match">{{ part.text }}</mark><template v-else>{{ part.text }}</template></template>
          </a>
          <div class="pr-meta">
            <!-- A bookmark's title is its repository -->
            <template v-if="result.hit.kind === 'queue'">
              <span><template v-for="(part, i) in result.repo" :key="i"><mark v-if="part.match">{{ part.text }}</mark><template v-else>{{ part.text }}</template></template></span>
              <span>#{{ result.hit.number }}</span>
              <span class="sep">·</span>
            </template>
            <span class="search-kind">
              <Octicon :name="result.hit.kind === 'queue' ? 'code-review' : 'bookmark'" :size="12" />
              {{ result.hit.kind === 'queue' ? 'Review queue' : 'Bookmark' }}
            </span>
          </div>
          <div v-if="result.note" class="note">
            <Octicon name="note" class="note-icon" />
            <p class="note-text"><template v-for="(part, i) in result.note" :key="i"><mark v-if="part.match">{{ part.text }}</mark><template v-else>{{ part.text }}</template></template></p>
          </div>
        </div>
      </li>
    </ul>
    <div v-else-if="hits && text.trim()" class="blankslate">
      <h2>Nothing matches “{{ text.trim() }}”</h2>
      <p>Every word has to appear in a note, a pull request title or a repository name.</p>
    </div>
    <div v-else-if="!text.trim()" class="blankslate">
      <Octicon name="search" :size="32" />
      <h2>Search your notes</h2>
      <p>
        Add a note when you queue a pull request or bookmark a repository (or later, from the lists), then find it here.
        Results come best first, and the words are found in other forms too (“review” finds “reviewing”).
      </p>
    </div>
  </section>
</template>
