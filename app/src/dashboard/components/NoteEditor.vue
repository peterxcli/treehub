<script setup lang="ts">
// The user's note on a bookmark or a queued pull request, and its editor (Cmd/Ctrl+Enter saves, Escape cancels).
// The parent opens the editor (v-model:editing) from its note button. Saving an empty note removes it.
import {computed, nextTick, ref, watch} from 'vue';
import Octicon from './Octicon.vue';

const MAX_LENGTH = 2000;

const props = defineProps<{note?: string; busy?: boolean}>();
const emit = defineEmits<{save: [note: string]}>();
const editing = defineModel<boolean>('editing', {default: false});

const draft = ref('');
const textarea = ref<HTMLTextAreaElement | null>(null);
const expanded = ref(false);
// Long notes show their first lines until expanded
const long = computed(() => !!props.note && (props.note.length > 280 || props.note.split('\n').length > 3));

watch(
  editing,
  async (on) => {
    if (!on) return;
    draft.value = props.note || '';
    await nextTick();
    textarea.value?.focus();
  },
  {immediate: true}
);

function save() {
  editing.value = false;
  const note = draft.value.trim();
  if (note !== (props.note || '')) emit('save', note);
}

function onKeydown(event: KeyboardEvent) {
  if (event.key === 'Escape') {
    event.stopPropagation();
    editing.value = false;
  } else if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
    event.preventDefault();
    save();
  }
}
</script>

<template>
  <form v-if="editing" class="note-form" @submit.prevent="save">
    <textarea
      ref="textarea"
      v-model="draft"
      rows="3"
      :maxlength="MAX_LENGTH"
      placeholder="A note for yourself: why you follow it, what to check… You can search notes."
      aria-label="Note"
      @keydown="onKeydown"
    />
    <div class="note-actions">
      <span v-if="draft.length > MAX_LENGTH - 200" class="muted">{{ MAX_LENGTH - draft.length }} characters left</span>
      <span v-else class="muted">{{ note ? 'Save it empty to remove it.' : '' }}</span>
      <button type="button" class="btn btn-sm" @click="editing = false">Cancel</button>
      <button type="submit" class="btn btn-sm btn-primary" :disabled="busy">Save</button>
    </div>
  </form>
  <div v-else-if="note" class="note">
    <Octicon name="note" class="note-icon" />
    <p class="note-text" :class="{clamped: long && !expanded}">{{ note }}</p>
    <button v-if="long" type="button" class="link note-more" @click="expanded = !expanded">
      {{ expanded ? 'Show less' : 'Show more' }}
    </button>
  </div>
</template>
