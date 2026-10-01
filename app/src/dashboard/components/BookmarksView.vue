<script setup lang="ts">
import {computed, onMounted, ref, watch} from 'vue';
import type {BookmarkEntry, RepoMeta} from '../../lib/storage.ts';
import {compactNumber, fullTime, parseRepository, timeAgo} from '../format.ts';
import {busy, clock, request, state, toast} from '../store.ts';
import NoteEditor from './NoteEditor.vue';
import Octicon from './Octicon.vue';

interface Card {
  bookmark: BookmarkEntry;
  owner: string;
  name: string;
  meta?: RepoMeta;
}

const cards = computed<Card[]>(() =>
  ((state.hub && state.hub.bookmarks) || []).map((bookmark) => {
    const [owner, name] = bookmark.repo.split('/');
    const meta = state.repos && state.repos.repos[bookmark.repo.toLowerCase()];
    return {bookmark, owner, name, meta};
  })
);

const search = ref('');
const visible = computed(() => {
  const words = search.value.toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return cards.value;
  return cards.value.filter((card) => {
    const text = `${card.bookmark.repo} ${card.bookmark.note || ''} ${(card.meta && card.meta.description) || ''} ${(card.meta && card.meta.language && card.meta.language.name) || ''}`.toLowerCase();
    return words.every((word) => text.includes(word));
  });
});

// Details of new bookmarks
const repoCount = computed(() => cards.value.length);
onMounted(() => void request('repos', {type: 'treehub:refreshRepos'}));
watch(repoCount, (count, previous) => {
  if (count > previous) void request('repos', {type: 'treehub:refreshRepos'});
});

const input = ref('');
const note = ref('');
// The bookmark whose note is being edited
const editingNote = ref<string | null>(null);

async function add() {
  const repo = parseRepository(input.value);
  if (!repo) {
    toast('Enter a repository as owner/name, or its URL.', {error: true});
    return;
  }
  if (cards.value.some((card) => card.bookmark.repo.toLowerCase() === repo.toLowerCase())) {
    toast(`${repo} is already bookmarked.`);
    // Keeps a note typed for it, to put it there
    if (!note.value.trim()) input.value = '';
    return;
  }
  const submitted = {input: input.value, note: note.value};
  const result = await request('add', {type: 'treehub:setBookmark', repo, on: true, note: note.value.trim() || undefined});
  if (result !== undefined) {
    // Unless the next one is being typed already
    if (input.value === submitted.input) input.value = '';
    if (note.value === submitted.note) note.value = '';
    toast(`Bookmarked ${repo}.`);
  }
}

async function saveNote(card: Card, text: string) {
  const {repo} = card.bookmark;
  const result = await request(`bookmark:${repo}`, {type: 'treehub:setNote', repo, note: text});
  if (result !== undefined) toast(text ? 'Note saved.' : 'Note removed.');
}

function submitOnCtrlEnter(event: KeyboardEvent) {
  if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
    event.preventDefault();
    void add();
  }
}

async function remove(card: Card) {
  const {repo} = card.bookmark;
  const result = await request(`bookmark:${repo}`, {type: 'treehub:setBookmark', repo, on: false});
  if (result === undefined) return;
  toast(`Removed the bookmark of ${repo}.`, {
    action: {label: 'Undo', run: () => void request('undo', {type: 'treehub:setBookmark', repo, on: true, note: card.bookmark.note})}
  });
}
</script>

<template>
  <section class="page">
    <div class="page-head">
      <div>
        <h1>Bookmarks</h1>
        <p class="muted">Repositories you bookmarked, from any browser you signed in to.</p>
      </div>
      <label v-if="cards.length > 6" class="search">
        <Octicon name="search" />
        <input v-model="search" type="search" placeholder="Filter bookmarks" aria-label="Filter bookmarks" />
      </label>
    </div>

    <form class="add" @submit.prevent="add">
      <div class="add-form">
        <Octicon name="plus" class="add-icon" />
        <input
          v-model="input"
          type="text"
          placeholder="Bookmark a repository: type owner/name or paste its URL"
          aria-label="Repository to bookmark"
          spellcheck="false"
          autocomplete="off"
        />
        <button type="submit" class="btn btn-primary" :disabled="busy.add || !input.trim()">Add</button>
      </div>
      <textarea
        v-if="input.trim() || note"
        v-model="note"
        class="add-note"
        rows="2"
        maxlength="2000"
        placeholder="Note (optional): what it is to you… You can search notes."
        aria-label="Note"
        @keydown="submitOnCtrlEnter"
      />
    </form>

    <div v-if="visible.length" class="cards">
      <article v-for="card in visible" :key="card.bookmark.repo" class="card" :class="{busy: busy[`bookmark:${card.bookmark.repo}`]}">
        <header>
          <Octicon :name="card.meta && card.meta.isPrivate ? 'lock' : card.meta && card.meta.isArchived ? 'archive' : 'repo'" class="muted" />
          <a class="repo-name" :href="`https://github.com/${card.bookmark.repo}`" target="_blank" rel="noopener">
            <span class="owner">{{ card.owner }} /</span> <strong>{{ card.name }}</strong>
          </a>
          <span v-if="card.meta && card.meta.isArchived" class="label">Archived</span>
          <span class="card-actions">
            <button
              type="button"
              class="icon-button"
              :class="{selected: editingNote === card.bookmark.repo}"
              :title="card.bookmark.note ? 'Edit the note' : 'Add a note'"
              :aria-label="card.bookmark.note ? 'Edit the note' : 'Add a note'"
              @click="editingNote = editingNote === card.bookmark.repo ? null : card.bookmark.repo"
            >
              <Octicon name="note" />
            </button>
            <button
              type="button"
              class="icon-button bookmarked"
              title="Remove bookmark"
              aria-label="Remove bookmark"
              @click="remove(card)"
            >
              <Octicon name="bookmark-fill" />
            </button>
          </span>
        </header>
        <p v-if="card.meta && card.meta.error" class="card-error">{{ card.meta.error }}</p>
        <p v-else class="description" :class="{muted: !card.meta || !card.meta.description}">
          {{ card.meta ? card.meta.description || 'No description' : 'Loading…' }}
        </p>
        <NoteEditor
          :editing="editingNote === card.bookmark.repo"
          :note="card.bookmark.note"
          :busy="busy[`bookmark:${card.bookmark.repo}`]"
          @update:editing="editingNote = $event ? card.bookmark.repo : null"
          @save="saveNote(card, $event)"
        />
        <footer v-if="card.meta && !card.meta.error">
          <span v-if="card.meta.language" class="language">
            <span class="language-color" :style="{backgroundColor: card.meta.language.color || '#8b949e'}" />
            {{ card.meta.language.name }}
          </span>
          <a :href="`https://github.com/${card.bookmark.repo}/stargazers`" target="_blank" rel="noopener" title="Stars">
            <Octicon name="star" /> {{ compactNumber(card.meta.stars) }}
          </a>
          <a :href="`https://github.com/${card.bookmark.repo}/pulls`" target="_blank" rel="noopener" title="Open pull requests">
            <Octicon name="git-pull-request" /> {{ compactNumber(card.meta.openPullRequests) }}
          </a>
          <a :href="`https://github.com/${card.bookmark.repo}/issues`" target="_blank" rel="noopener" title="Open issues">
            <Octicon name="issue-opened" /> {{ compactNumber(card.meta.openIssues) }}
          </a>
          <span v-if="card.meta.pushedAt" class="muted" :title="fullTime(card.meta.pushedAt)">
            Updated {{ timeAgo(card.meta.pushedAt, clock) }}
          </span>
        </footer>
      </article>
    </div>

    <div v-else-if="cards.length" class="blankslate">
      <h2>No bookmarks match “{{ search }}”</h2>
      <button type="button" class="btn" @click="search = ''">Clear filter</button>
    </div>

    <div v-else class="blankslate">
      <Octicon name="bookmark" :size="32" />
      <h2>No bookmarks yet</h2>
      <p>
        In a repository, click <Octicon name="bookmark" /> in the TreeHub sidebar to bookmark it, or type its name above.
      </p>
    </div>
  </section>
</template>
