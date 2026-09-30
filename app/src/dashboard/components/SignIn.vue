<script setup lang="ts">
import {ref} from 'vue';
import {DEV_LOGIN} from '../../config.ts';
import logo from '../../../../icons/icon128.png';
import {busy, request, state} from '../store.ts';
import CredentialProblemCard from './CredentialProblemCard.vue';
import Octicon from './Octicon.vue';

const devLogin = ref('');
const hideProblem = ref(false);

function signIn() {
  void request('signIn', {type: 'treehub:signIn'});
}

function devSignIn() {
  void request('signIn', {type: 'treehub:signIn', devLogin: devLogin.value.trim()});
}
</script>

<template>
  <section class="signin">
    <CredentialProblemCard
      v-if="state.signinProblem && !hideProblem"
      :problem="state.signinProblem"
      dismissible
      class="signin-problem"
      @dismiss="hideProblem = true"
    />
    <img :src="logo" alt="" width="64" height="64" />
    <h1>Welcome to TreeHub</h1>
    <p class="lead">
      Bookmark repositories and keep a review queue of pull requests, with what changed for you since your last look:
      review requests, new commits since your review, replies, mentions, checks and more.
    </p>
    <button type="button" class="btn btn-primary btn-large" :disabled="busy.signIn" @click="signIn">
      <Octicon name="mark-github" />
      {{ busy.signIn ? 'Waiting for GitHub…' : 'Sign in with GitHub' }}
    </button>
    <ul class="facts">
      <li><Octicon name="person" /> Your GitHub handle identifies you, and TreeHub computes statuses for it.</li>
      <li>
        <Octicon name="bookmark" /> The TreeHub server keeps your bookmarks, your queued pull requests and when you last
        opened them, so they follow you across browsers.
      </li>
      <li>
        <Octicon name="lock" /> Your GitHub token stays in this browser: statuses are computed here, straight from GitHub.
      </li>
    </ul>
    <form v-if="DEV_LOGIN" class="dev-signin" @submit.prevent="devSignIn">
      <label for="dev-login" class="muted">Development sign-in (server with DEV_AUTH)</label>
      <div>
        <input id="dev-login" v-model="devLogin" type="text" placeholder="GitHub handle" autocomplete="off" />
        <button type="submit" class="btn" :disabled="busy.signIn">Sign in</button>
      </div>
    </form>
  </section>
</template>
