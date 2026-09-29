<script setup lang="ts">
import {OCTICONS, type OcticonName} from '../icons.ts';

withDefaults(defineProps<{name: OcticonName; size?: number; label?: string}>(), {size: 16});
</script>

<template>
  <svg
    class="octicon"
    viewBox="0 0 16 16"
    :width="size"
    :height="size"
    :aria-hidden="label ? undefined : 'true'"
    :aria-label="label"
    :role="label ? 'img' : undefined"
    v-html="OCTICONS[name]"
  />
</template>
