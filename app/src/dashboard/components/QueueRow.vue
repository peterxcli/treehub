<script setup lang="ts">
import {computed} from 'vue';
import {needsAttention, type PRState} from '../../lib/status.ts';
import type {QueueEntry} from '../../lib/storage.ts';
import {fullTime, timeAgo} from '../format.ts';
import type {OcticonName} from '../icons.ts';
import {clock} from '../store.ts';
import Octicon from './Octicon.vue';
import StatusChip from './StatusChip.vue';

const props = defineProps<{entry: QueueEntry; state?: PRState; busy?: boolean}>();
const emit = defineEmits<{remove: []; seen: []}>();

const url = computed(() => (props.state && props.state.url) || `https://github.com/${props.entry.repo}/pull/${props.entry.number}`);
const title = computed(() => (props.state && props.state.title) || props.entry.title || `Pull request #${props.entry.number}`);
const attention = computed(() => !!props.state && needsAttention(props.state));

const stateIcon = computed<{icon: OcticonName; label: string; className: string}>(() => {
  const state = props.state;
  if (!state) return {icon: 'git-pull-request', label: 'Loading', className: 'pending'};
  if (state.error) return {icon: 'alert', label: 'Unavailable', className: 'error'};
  switch (state.state) {
    case 'draft':
      return {icon: 'git-pull-request-draft', label: 'Draft', className: 'draft'};
    case 'merged':
      return {icon: 'git-merge', label: 'Merged', className: 'merged'};
    case 'closed':
      return {icon: 'git-pull-request-closed', label: 'Closed', className: 'closed'};
    default:
      return {icon: 'git-pull-request', label: 'Open', className: 'open'};
  }
});
</script>

<template>
  <li class="pr" :class="{attention, busy}">
    <span class="pr-state" :class="stateIcon.className" :title="stateIcon.label">
      <Octicon :name="stateIcon.icon" />
    </span>
    <div class="pr-main">
      <a class="pr-title" :href="url" target="_blank" rel="noopener">{{ title }}</a>
      <div class="pr-meta">
        <a :href="`https://github.com/${entry.repo}`" target="_blank" rel="noopener">{{ entry.repo }}</a>
        <span>#{{ entry.number }}</span>
        <template v-if="state && state.author">
          <span class="sep">·</span>
          <span>by {{ state.author }}</span>
        </template>
        <template v-if="state && !state.error">
          <span class="sep">·</span>
          <span :title="fullTime(state.updatedAt)">updated {{ timeAgo(state.updatedAt, clock) }}</span>
        </template>
        <span class="sep">·</span>
        <span :title="fullTime(entry.lastSeenAt)">{{ entry.lastSeenAt ? `seen ${timeAgo(entry.lastSeenAt, clock)}` : 'not opened yet' }}</span>
      </div>
      <div v-if="state && state.statuses.length" class="chips">
        <StatusChip v-for="status in state.statuses" :key="status.key" :status="status" />
      </div>
      <p v-if="state && state.error" class="pr-error">{{ state.error }}</p>
    </div>
    <div class="pr-actions">
      <button type="button" class="icon-button" title="Mark as seen" aria-label="Mark as seen" @click="emit('seen')">
        <Octicon name="eye" />
      </button>
      <button
        type="button"
        class="icon-button danger"
        title="Remove from the review queue"
        aria-label="Remove from the review queue"
        @click="emit('remove')"
      >
        <Octicon name="x" />
      </button>
    </div>
  </li>
</template>
