<script setup lang="ts">
import type {CredentialProblem} from '../../lib/credentials.ts';
import {busy, request} from '../store.ts';
import Octicon from './Octicon.vue';

defineProps<{problem: CredentialProblem; dismissible?: boolean}>();
const emit = defineEmits<{dismiss: []}>();

async function signIn() {
  if ((await request('signIn', {type: 'treehub:signIn'})) !== undefined) emit('dismiss');
}
</script>

<template>
  <section class="problem" role="alert">
    <header>
      <Octicon name="alert" />
      <h2>{{ problem.title }}</h2>
      <button v-if="dismissible" type="button" class="icon-button" aria-label="Dismiss" @click="emit('dismiss')">
        <Octicon name="x" />
      </button>
    </header>
    <p>{{ problem.summary }}</p>
    <dl v-if="problem.details.length">
      <template v-for="detail in problem.details" :key="detail.label">
        <dt>{{ detail.label }}</dt>
        <dd>
          <a v-if="detail.href" :href="detail.href" target="_blank" rel="noopener">{{ detail.value }}</a>
          <template v-else>{{ detail.value }}</template>
        </dd>
      </template>
    </dl>
    <div class="problem-actions">
      <slot />
      <template v-for="(action, index) in problem.actions" :key="action.label">
        <a
          v-if="action.href"
          class="btn"
          :class="{'btn-primary': index === 0}"
          :href="action.href"
          target="_blank"
          rel="noopener"
        >
          {{ action.label }}
        </a>
        <button
          v-else-if="action.action === 'signIn'"
          type="button"
          class="btn"
          :class="{'btn-primary': index === 0}"
          :disabled="busy.signIn"
          @click="signIn"
        >
          {{ busy.signIn ? 'Waiting for GitHub…' : action.label }}
        </button>
        <!-- The token field is in the sidebar on GitHub -->
        <span v-else class="problem-hint">
          <Octicon name="gear" /> Change the token in TreeHub's settings: the gear of the sidebar on GitHub
        </span>
      </template>
    </div>
  </section>
</template>
