<script setup lang="ts">
import {onBeforeUnmount, onMounted, ref} from 'vue';
import type {Account} from '../../lib/storage.ts';
import {request} from '../store.ts';
import Octicon from './Octicon.vue';

defineProps<{account: Account}>();

const open = ref(false);
const root = ref<HTMLElement | null>(null);

const onDocumentClick = (event: MouseEvent) => {
  if (root.value && !root.value.contains(event.target as Node)) open.value = false;
};
const onKeydown = (event: KeyboardEvent) => {
  if (event.key === 'Escape') open.value = false;
};
onMounted(() => {
  document.addEventListener('click', onDocumentClick);
  document.addEventListener('keydown', onKeydown);
});
onBeforeUnmount(() => {
  document.removeEventListener('click', onDocumentClick);
  document.removeEventListener('keydown', onKeydown);
});

function signOut(everywhere: boolean) {
  open.value = false;
  void request('signOut', {type: 'treehub:signOut', everywhere});
}

function deleteAccount() {
  open.value = false;
  const confirmed = window.confirm(
    'Delete your TreeHub account?\n\nYour bookmarks and review queue are deleted from the TreeHub server, and you ' +
      'are signed out everywhere. Your GitHub account is not affected.'
  );
  if (confirmed) void request('deleteAccount', {type: 'treehub:deleteAccount'});
}
</script>

<template>
  <div ref="root" class="account">
    <button
      type="button"
      class="account-button"
      :aria-expanded="open"
      aria-haspopup="menu"
      :title="`Signed in as ${account.login}`"
      @click="open = !open"
    >
      <img v-if="account.avatarUrl" :src="account.avatarUrl" alt="" class="avatar" width="24" height="24" />
      <Octicon v-else name="person" />
      <span class="account-login">{{ account.login }}</span>
      <Octicon name="triangle-down" />
    </button>
    <div v-if="open" class="menu" role="menu">
      <div class="menu-header">
        Signed in as <strong>{{ account.login }}</strong>
        <div v-if="account.name" class="muted">{{ account.name }}</div>
      </div>
      <a class="menu-item" role="menuitem" :href="`https://github.com/${account.login}`" target="_blank" rel="noopener">
        <Octicon name="mark-github" /> Your GitHub profile
      </a>
      <div class="menu-divider" />
      <button type="button" class="menu-item" role="menuitem" @click="signOut(false)">
        <Octicon name="sign-out" /> Sign out
      </button>
      <button
        type="button"
        class="menu-item"
        role="menuitem"
        title="Ends your TreeHub sessions in every browser"
        @click="signOut(true)"
      >
        <Octicon name="sign-out" /> Sign out everywhere
      </button>
      <div class="menu-divider" />
      <button type="button" class="menu-item danger" role="menuitem" @click="deleteAccount">
        <Octicon name="trash" /> Delete account…
      </button>
    </div>
  </div>
</template>
