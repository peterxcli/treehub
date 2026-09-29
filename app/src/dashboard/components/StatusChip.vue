<script setup lang="ts">
import {computed} from 'vue';
import type {Status, StatusKey} from '../../lib/status.ts';
import {fullTime, timeAgo} from '../format.ts';
import type {OcticonName} from '../icons.ts';
import {clock} from '../store.ts';
import Octicon from './Octicon.vue';

const props = defineProps<{status: Status}>();

const ICONS: Record<StatusKey, OcticonName> = {
  review_requested: 'code-review',
  new_commits: 'git-commit',
  replies: 'reply',
  mentioned: 'mention',
  updated: 'history',
  reviewed: 'comment',
  changes_requested: 'file-diff',
  approved: 'check-circle',
  approved_by_you: 'check-circle-fill',
  checks_failing: 'x-circle',
  checks_pending: 'dot-fill',
  checks_passing: 'check',
  conflicts: 'alert',
  draft: 'git-pull-request-draft',
  ready: 'git-pull-request',
  merged: 'git-merge',
  closed: 'git-pull-request-closed',
  yours: 'person'
};

// When you reviewed is in the tooltip only, to keep rows short
const OWN_REVIEW: StatusKey[] = ['reviewed', 'approved_by_you'];

const icon = computed<OcticonName>(() => {
  const {key, tone} = props.status;
  // The icon of your own review follows its outcome
  if (key === 'reviewed') return tone === 'danger' ? 'file-diff' : 'comment';
  return ICONS[key];
});

const tooltip = computed(() => {
  const {label, at, attention} = props.status;
  return [label, at && fullTime(at), attention && 'Needs your attention'].filter(Boolean).join(' · ');
});
</script>

<template>
  <component
    :is="status.url ? 'a' : 'span'"
    class="chip"
    :class="[`tone-${status.tone}`, {attention: status.attention}]"
    :href="status.url"
    :target="status.url ? '_blank' : undefined"
    :rel="status.url ? 'noopener' : undefined"
    :title="tooltip"
  >
    <Octicon :name="icon" :size="14" />
    <span>{{ status.label }}</span>
    <time v-if="status.at && !OWN_REVIEW.includes(status.key)" :datetime="status.at">{{ timeAgo(status.at, clock) }}</time>
  </component>
</template>
