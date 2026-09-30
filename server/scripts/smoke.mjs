#!/usr/bin/env node
// End-to-end check of a running Worker (local `wrangler dev` with DEV_AUTH=true):
//   node scripts/smoke.mjs http://localhost:8787
// Signs in through /auth/dev-login, exercises every API route, deletes the
// test account at the end and exits non-zero on the first failure. Tokens are
// never printed.

const base = (process.argv[2] || "http://localhost:8787").replace(/\/+$/, "");
const EXT = process.env.TREEHUB_EXT_ID || "kamkelclcngghlnfcejjkcckpcnkdaim";
const run = Date.now().toString(36);
const login = `smoke-${run}`; // a fresh user per run keeps the checks exact
const nonce = `smoke_nonce_${run}_${Math.random().toString(36).slice(2, 10)}`;

let step = 0;
function ok(msg) {
  console.log(`ok ${++step} - ${msg}`);
}
function check(cond, msg, detail) {
  if (!cond) {
    const extra = detail === undefined ? "" : `\n  ${typeof detail === "string" ? detail : JSON.stringify(detail)}`;
    throw new Error(`${msg}${extra}`);
  }
}

async function call(method, path, { token, body, headers = {} } = {}) {
  const init = { method, headers: { ...headers }, redirect: "manual" };
  if (token) init.headers.Authorization = `Bearer ${token}`;
  if (body !== undefined) {
    init.headers["Content-Type"] = "application/json";
    init.body = JSON.stringify(body);
  }
  const res = await fetch(base + path, init);
  const text = await res.text();
  let json;
  try {
    json = text ? JSON.parse(text) : undefined;
  } catch {
    json = undefined;
  }
  return { res, status: res.status, json, text };
}

async function expectJSON(method, path, status, opts) {
  const r = await call(method, path, opts);
  check(r.status === status, `${method} ${path}: status ${r.status}, want ${status}`, r.text);
  check(r.json !== undefined, `${method} ${path}: body is not JSON`, r.text);
  check(r.res.headers.get("access-control-allow-origin") === "*", `${method} ${path}: missing CORS header`);
  return r.json;
}

// devLogin signs in as handle and returns the session from the redirect's
// fragment (the redirect itself is not followed).
async function devLogin(handle) {
  const q = new URLSearchParams({ ext: EXT, nonce, login: handle });
  const r = await call("GET", `/auth/dev-login?${q}`);
  check(r.status === 302, `dev-login: status ${r.status}, want 302 (is DEV_AUTH=true in .dev.vars?)`, r.text);
  const location = r.res.headers.get("location") || "";
  const prefix = `https://${EXT}.chromiumapp.org/github#`;
  check(location.startsWith(prefix), "dev-login: redirect target", location.split("#")[0]);
  const frag = new URLSearchParams(location.slice(prefix.length));
  const session = frag.get("session");
  check(!frag.has("error"), "dev-login: error in fragment", frag.get("error"));
  check(session && session.split(".").length === 3, "dev-login: no session JWT in fragment");
  check(frag.get("login") === handle, "dev-login: login", frag.get("login"));
  check(frag.get("nonce") === nonce, "dev-login: nonce not echoed");
  check(!frag.has("github_token"), "dev-login: unexpected github_token");
  return session;
}

async function main() {
  console.log(`TreeHub smoke test against ${base} (user ${login})`);

  // Preflight.
  {
    const r = await call("OPTIONS", "/api/bookmarks/octo-org/hello-world", {
      headers: {
        Origin: `chrome-extension://${EXT}`,
        "Access-Control-Request-Method": "PUT",
        "Access-Control-Request-Headers": "authorization, content-type",
      },
    });
    check(r.status === 204, `OPTIONS: status ${r.status}, want 204`, r.text);
    const want = {
      "access-control-allow-origin": "*",
      "access-control-allow-headers": "Authorization, Content-Type",
      "access-control-allow-methods": "GET, PUT, POST, DELETE, OPTIONS",
      "access-control-max-age": "86400",
    };
    for (const [k, v] of Object.entries(want)) {
      check(r.res.headers.get(k) === v, `OPTIONS: ${k} = ${r.res.headers.get(k)}, want ${v}`);
    }
    ok("OPTIONS preflight answers 204 with CORS headers");
  }

  // Health.
  {
    const j = await expectJSON("GET", "/api/health", 200);
    check(j.ok === true && j.service === "treehub", "health body", j);
    ok("GET /api/health");
  }

  // 401 without a token.
  {
    const j = await expectJSON("GET", "/api/me", 401);
    check(j.error === "login_required", "error code", j);
    const b = await expectJSON("GET", "/api/bookmarks", 401);
    check(b.error === "login_required", "error code", b);
    const h = await expectJSON("PUT", "/api/history/repos/octo-org/hello-world", 401);
    check(h.error === "login_required", "error code", h);
    ok("401 login_required without a token");
  }

  // OAuth start and a cancelled callback: exercises the signed state without
  // calling GitHub. Needs GITHUB_CLIENT_ID/SECRET (any value); skipped otherwise.
  {
    const q = new URLSearchParams({ ext: EXT, nonce });
    const bad = await expectJSON("GET", `/auth/github/start?ext=${"a".repeat(32)}&nonce=${nonce}`, 400);
    check(bad.error === "invalid_request", "start with an unknown extension", bad);
    const r = await call("GET", `/auth/github/start?${q}`);
    if (r.status === 500 && r.json?.error === "oauth_not_configured") {
      ok("OAuth start rejects unknown extensions; round trip skipped (GITHUB_CLIENT_ID/SECRET not set)");
    } else {
      check(r.status === 302, `start: status ${r.status}, want 302`, r.text);
      const loc = new URL(r.res.headers.get("location"));
      check(loc.origin + loc.pathname === "https://github.com/login/oauth/authorize", "start: authorize URL", loc.origin + loc.pathname);
      check(loc.searchParams.get("scope") === "repo", "start: scope", loc.searchParams.get("scope"));
      check(loc.searchParams.get("redirect_uri") === `${base}/auth/github/callback`, "start: redirect_uri", loc.searchParams.get("redirect_uri"));
      const state = loc.searchParams.get("state") || "";
      const cancelled = await call("GET", `/auth/github/callback?error=access_denied&state=${encodeURIComponent(state)}`);
      const want = `https://${EXT}.chromiumapp.org/github#error=access_denied&nonce=${nonce}`;
      check(cancelled.status === 302 && cancelled.res.headers.get("location") === want, "cancelled callback redirect", cancelled.res.headers.get("location"));
      const tampered = (state[0] === "e" ? "f" : "e") + state.slice(1);
      const t = await expectJSON("GET", `/auth/github/callback?error=access_denied&state=${encodeURIComponent(tampered)}`, 400);
      check(t.error === "invalid_state", "tampered state", t);
      ok("OAuth start -> GitHub authorize URL; cancelled callback -> extension; tampered state -> 400");
    }
  }

  // Dev login: read the redirect, do not follow it.
  const session = await devLogin(login);
  ok(`dev-login redirects to the extension with a session (${session.length} chars, not shown)`);

  // Me.
  {
    const j = await expectJSON("GET", "/api/me", 200, { token: session });
    check(j.user && j.user.login === login && j.user.github_id > 0 && j.user.created_at, "me body", j);
    ok(`GET /api/me -> ${j.user.login} (github_id ${j.user.github_id})`);
  }

  // Bookmarks.
  {
    const repo = "octo-org/Hello.World";
    const b = await expectJSON("PUT", `/api/bookmarks/${repo}`, 200, { token: session });
    check(b.repo === repo && b.created_at, "PUT bookmark body", b);
    const again = await expectJSON("PUT", `/api/bookmarks/${repo}`, 200, { token: session });
    check(again.created_at === b.created_at, "PUT bookmark is idempotent", again);
    let list = await expectJSON("GET", "/api/bookmarks", 200, { token: session });
    check((list.bookmarks || []).length === 1 && list.bookmarks[0].repo === repo, "GET bookmarks", list);
    const del = await expectJSON("DELETE", "/api/bookmarks/OCTO-ORG/hello.world", 200, { token: session });
    check(del.ok === true, "DELETE bookmark", del);
    list = await expectJSON("GET", "/api/bookmarks", 200, { token: session });
    check((list.bookmarks || []).length === 0, "bookmark still listed after DELETE", list);
    const bad = await expectJSON("PUT", "/api/bookmarks/-bad/repo", 400, { token: session });
    check(bad.error === "invalid_repo", "invalid repo", bad);
    ok("bookmarks PUT / GET / DELETE (+ idempotency, case-insensitivity, validation)");
  }

  // Review queue.
  {
    const path = "/api/queue/octo-org/hello-world/42";
    const item = await expectJSON("PUT", path, 200, { token: session, body: { title: "  Smoke test PR  " } });
    check(item.repo === "octo-org/hello-world" && item.number === 42 && item.title === "Smoke test PR" && item.added_at, "PUT queue item", item);
    check(item.last_seen_at === undefined, "new item already seen", item);
    const kept = await expectJSON("PUT", path, 200, { token: session });
    check(kept.title === "Smoke test PR", "PUT without body keeps the title", kept);
    let list = await expectJSON("GET", "/api/queue", 200, { token: session });
    check((list.items || []).length === 1 && list.items[0].number === 42, "GET queue", list);
    const seen = await expectJSON("POST", `${path}/seen`, 200, { token: session });
    check(typeof seen.last_seen_at === "string" && !Number.isNaN(Date.parse(seen.last_seen_at)), "seen sets last_seen_at", seen);
    const missing = await expectJSON("POST", "/api/queue/octo-org/hello-world/43/seen", 404, { token: session });
    check(missing.error === "not_found", "seen on a missing item", missing);
    const del = await expectJSON("DELETE", path, 200, { token: session });
    check(del.ok === true, "DELETE queue item", del);
    list = await expectJSON("GET", "/api/queue", 200, { token: session });
    check((list.items || []).length === 0, "queue item still listed after DELETE", list);
    const badNumber = await expectJSON("PUT", "/api/queue/octo-org/hello-world/0", 400, { token: session });
    check(badNumber.error === "invalid_number", "invalid number", badNumber);
    ok("queue PUT / GET / seen / DELETE (+ title keep, 404, validation)");
  }

  // History. Timestamps come from the Worker's clock, so two quick views may
  // share a millisecond: the order is checked against the listing rule rather
  // than assumed.
  {
    const key = (i) => `${i.kind}:${i.repo}#${i.number ?? 0}`;
    const listedBefore = (a, b) =>
      a.last_viewed_at !== b.last_viewed_at
        ? a.last_viewed_at > b.last_viewed_at
        : a.kind !== b.kind
          ? a.kind > b.kind
          : a.repo.toLowerCase() !== b.repo.toLowerCase()
            ? a.repo.toLowerCase() > b.repo.toLowerCase()
            : (a.number ?? 0) > (b.number ?? 0);
    const stamp = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/;

    const settings = await expectJSON("GET", "/api/history/settings", 200, { token: session });
    check(settings.retention_days === 30 && settings.paused === undefined, "default history settings", settings);
    const repo = await expectJSON("PUT", "/api/history/repos/octo-org/Hello-World", 200, { token: session });
    const first = repo.item;
    check(repo.paused === undefined && first && first.kind === "repo" && first.repo === "octo-org/Hello-World" && first.number === undefined && first.view_count === 1, "record a repository view", repo);
    check(stamp.test(first.first_viewed_at) && first.last_viewed_at === first.first_viewed_at, "history timestamps", first);
    const pull = await expectJSON("PUT", "/api/history/pulls/octo-org/hello-world/42", 200, { token: session, body: { title: "  Smoke test PR  " } });
    check(pull.item && pull.item.kind === "pull" && pull.item.number === 42 && pull.item.title === "Smoke test PR" && pull.item.view_count === 1, "record a pull request view", pull);
    const again = await expectJSON("PUT", "/api/history/repos/OCTO-ORG/hello-world", 200, { token: session });
    check(
      again.item.view_count === 2 && again.item.repo === "OCTO-ORG/hello-world" && again.item.first_viewed_at === first.first_viewed_at && again.item.last_viewed_at >= first.last_viewed_at,
      "record the repository again",
      again,
    );
    const kept = await expectJSON("PUT", "/api/history/pulls/octo-org/hello-world/42", 200, { token: session });
    check(kept.item.view_count === 2 && kept.item.title === "Smoke test PR", "a view without a title keeps it", kept);
    await expectJSON("PUT", "/api/history/pulls/octo-org/hello-world/43", 200, { token: session, body: { title: "Another" } });
    ok("history PUT repos / pulls: record, record again (count, times, spelling, title kept)");

    const all = await expectJSON("GET", "/api/history", 200, { token: session });
    const keys = (all.items || []).map(key);
    check(all.next_cursor === undefined && keys.length === 3, "GET history", all);
    for (const k of ["repo:OCTO-ORG/hello-world#0", "pull:octo-org/hello-world#42", "pull:octo-org/hello-world#43"]) {
      check(keys.includes(k), `history lacks ${k}`, keys);
    }
    check(all.items.every((it, i) => i === 0 || listedBefore(all.items[i - 1], it)), "history order", all.items);
    const paged = [];
    let cursor;
    do {
      const q = new URLSearchParams({ limit: "1" });
      if (cursor) q.set("cursor", cursor);
      const page = await expectJSON("GET", `/api/history?${q}`, 200, { token: session });
      check((page.items || []).length === 1, "page of one", page);
      paged.push(key(page.items[0]));
      cursor = page.next_cursor;
    } while (cursor && paged.length <= keys.length);
    check(paged.join() === keys.join(), "pages of one add up to the list", { paged, keys });
    const pulls = await expectJSON("GET", "/api/history?kind=pull", 200, { token: session });
    check((pulls.items || []).length === 2 && pulls.items.every((i) => i.kind === "pull"), "kind=pull", pulls);
    const repos = await expectJSON("GET", "/api/history?kind=repo&limit=1", 200, { token: session });
    check((repos.items || []).length === 1 && repos.items[0].kind === "repo" && repos.next_cursor === undefined, "kind=repo", repos);
    for (const q of ["limit=0", "limit=101", "kind=issue", "cursor=!!"]) {
      const bad = await expectJSON("GET", `/api/history?${q}`, 400, { token: session });
      check(bad.error === "invalid_request", `GET /api/history?${q}`, bad);
    }
    ok("history GET: last viewed first, keyset pages of one, kind filter, 400 on bad parameters");

    const badSettings = await expectJSON("PUT", "/api/history/settings", 400, { token: session, body: { paused: true } });
    check(badSettings.error === "invalid_body", "settings without retention_days", badSettings);
    const paused = await expectJSON("PUT", "/api/history/settings", 200, { token: session, body: { retention_days: 7, paused: true } });
    check(paused.retention_days === 7 && paused.paused === true, "PUT history settings", paused);
    const stored = await expectJSON("GET", "/api/history/settings", 200, { token: session });
    check(stored.retention_days === 7 && stored.paused === true, "GET history settings", stored);
    const skipped = await expectJSON("PUT", "/api/history/pulls/octo-org/hello-world/44", 200, { token: session });
    check(skipped.paused === true && skipped.item === undefined, "a view while paused", skipped);
    const whilePaused = await expectJSON("GET", "/api/history", 200, { token: session });
    check((whilePaused.items || []).length === 3, "a view was stored while paused", whilePaused);
    const resumed = await expectJSON("PUT", "/api/history/settings", 200, { token: session, body: { retention_days: 30 } });
    check(resumed.retention_days === 30 && resumed.paused === undefined, "resume", resumed);
    ok("history settings: validation, pause (nothing recorded), resume");

    for (let i = 0; i < 2; i++) {
      const del = await expectJSON("DELETE", "/api/history/pulls/octo-org/hello-world/43", 200, { token: session });
      check(del.ok === true, "DELETE history pull request", del);
    }
    const delRepo = await expectJSON("DELETE", "/api/history/repos/octo-org/HELLO-WORLD", 200, { token: session });
    check(delRepo.ok === true, "DELETE history repository", delRepo);
    let list = await expectJSON("GET", "/api/history", 200, { token: session });
    check((list.items || []).map(key).join() === "pull:octo-org/hello-world#42", "history after DELETE", list);
    const cleared = await expectJSON("DELETE", "/api/history", 200, { token: session });
    check(cleared.ok === true, "DELETE /api/history", cleared);
    list = await expectJSON("GET", "/api/history", 200, { token: session });
    check((list.items || []).length === 0, "history after clearing", list);
    const badRepo = await expectJSON("PUT", "/api/history/repos/-bad/repo", 400, { token: session });
    check(badRepo.error === "invalid_repo", "invalid repo", badRepo);
    const badNumber = await expectJSON("DELETE", "/api/history/pulls/octo-org/hello-world/0", 400, { token: session });
    check(badNumber.error === "invalid_number", "invalid number", badNumber);
    ok("history DELETE one (idempotent, case-insensitive) and clear (+ validation)");
  }

  // A rename keeps data and sessions, which needs D1 to run ON UPDATE CASCADE.
  // The dev login id comes from the lowercased handle, so another spelling is
  // the same account renamed (a case-only rename, done through a parked name).
  {
    const repo = "octo-org/rename-check";
    await expectJSON("PUT", `/api/bookmarks/${repo}`, 200, { token: session });
    await expectJSON("PUT", "/api/queue/octo-org/rename-check/7", 200, { token: session, body: { title: "Rename check" } });
    await expectJSON("PUT", "/api/history/pulls/octo-org/rename-check/7", 200, { token: session, body: { title: "Rename check" } });
    const renamed = login.toUpperCase();
    await devLogin(renamed);
    const me = await expectJSON("GET", "/api/me", 200, { token: session });
    check(me.user.login === renamed, "old session after rename: login", me.user);
    const list = await expectJSON("GET", "/api/bookmarks", 200, { token: session });
    check((list.bookmarks || []).some((b) => b.repo === repo), "bookmark lost by the rename", list);
    const queue = await expectJSON("GET", "/api/queue", 200, { token: session });
    check((queue.items || []).some((q) => q.number === 7 && q.title === "Rename check"), "queue item lost by the rename", queue);
    const history = await expectJSON("GET", "/api/history", 200, { token: session });
    check((history.items || []).some((h) => h.kind === "pull" && h.number === 7 && h.title === "Rename check"), "history entry lost by the rename", history);
    await expectJSON("DELETE", `/api/bookmarks/${repo}`, 200, { token: session });
    await expectJSON("DELETE", "/api/queue/octo-org/rename-check/7", 200, { token: session });
    await expectJSON("DELETE", "/api/history/pulls/octo-org/rename-check/7", 200, { token: session });
    ok(`rename ${login} -> ${renamed} keeps the session, bookmarks, queue and history`);
  }

  // Sign out everywhere revokes the session.
  {
    const j = await expectJSON("POST", "/api/logout-all", 200, { token: session });
    check(j.ok === true, "logout-all", j);
    const after = await expectJSON("GET", "/api/me", 401, { token: session });
    check(after.error === "login_required", "revoked session still accepted", after);
    ok("POST /api/logout-all revokes the session");
  }

  // Deleting the account removes its data, and its sessions stay dead even
  // after the same user signs up again. This also removes the smoke user.
  {
    const before = await devLogin(login);
    await expectJSON("PUT", "/api/bookmarks/octo-org/delete-check", 200, { token: before });
    await expectJSON("PUT", "/api/queue/octo-org/delete-check/1", 200, { token: before, body: { title: "Delete check" } });
    await expectJSON("PUT", "/api/history/repos/octo-org/delete-check", 200, { token: before });
    await expectJSON("PUT", "/api/history/settings", 200, { token: before, body: { retention_days: 7, paused: true } });
    const del = await expectJSON("DELETE", "/api/me", 200, { token: before });
    check(del.ok === true, "DELETE /api/me", del);
    const gone = await expectJSON("GET", "/api/me", 401, { token: before });
    check(gone.error === "login_required", "session of a deleted account still accepted", gone);

    const fresh = await devLogin(login);
    const me = await expectJSON("GET", "/api/me", 200, { token: fresh });
    check(me.user.login === login, "fresh account", me);
    const list = await expectJSON("GET", "/api/bookmarks", 200, { token: fresh });
    check((list.bookmarks || []).length === 0, "fresh account has old bookmarks", list);
    const queue = await expectJSON("GET", "/api/queue", 200, { token: fresh });
    check((queue.items || []).length === 0, "fresh account has old queue items", queue);
    const history = await expectJSON("GET", "/api/history", 200, { token: fresh });
    check((history.items || []).length === 0, "fresh account has old history", history);
    const settings = await expectJSON("GET", "/api/history/settings", 200, { token: fresh });
    check(settings.retention_days === 30 && settings.paused === undefined, "fresh account has old history settings", settings);
    const still = await expectJSON("GET", "/api/me", 401, { token: before });
    check(still.error === "login_required", "old session revived by signing up again", still);
    await expectJSON("DELETE", "/api/me", 200, { token: fresh });
    ok("DELETE /api/me deletes the account and its data; old sessions stay dead after signing up again");
  }

  console.log(`\nall ${step} checks passed`);
}

main().catch((err) => {
  console.error(`not ok ${step + 1} - ${err.message}`);
  process.exit(1);
});
