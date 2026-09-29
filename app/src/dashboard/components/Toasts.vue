<script setup lang="ts">
import {dismiss, toasts, type Toast} from '../store.ts';
import Octicon from './Octicon.vue';

function run(toast: Toast) {
  dismiss(toast.id);
  if (toast.action) toast.action.run();
}
</script>

<template>
  <div class="toasts" aria-live="polite">
    <div v-for="toast in toasts" :key="toast.id" class="toast" :class="{error: toast.error}" role="status">
      <Octicon :name="toast.error ? 'alert' : 'check'" />
      <span class="toast-message">{{ toast.message }}</span>
      <button v-if="toast.action" type="button" class="link" @click="run(toast)">{{ toast.action.label }}</button>
      <button type="button" class="icon-button" aria-label="Dismiss" @click="dismiss(toast.id)">
        <Octicon name="x" />
      </button>
    </div>
  </div>
</template>
