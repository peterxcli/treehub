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

  // A rename keeps data and sessions, which needs D1 to run ON UPDATE CASCADE.
  // The dev login id comes from the lowercased handle, so another spelling is
  // the same account renamed (a case-only rename, done through a parked name).
  {
    const repo = "octo-org/rename-check";
    await expectJSON("PUT", `/api/bookmarks/${repo}`, 200, { token: session });
    await expectJSON("PUT", "/api/queue/octo-org/rename-check/7", 200, { token: session, body: { title: "Rename check" } });
    const renamed = login.toUpperCase();
    await devLogin(renamed);
    const me = await expectJSON("GET", "/api/me", 200, { token: session });
    check(me.user.login === renamed, "old session after rename: login", me.user);
    const list = await expectJSON("GET", "/api/bookmarks", 200, { token: session });
    check((list.bookmarks || []).some((b) => b.repo === repo), "bookmark lost by the rename", list);
    const queue = await expectJSON("GET", "/api/queue", 200, { token: session });
    check((queue.items || []).some((q) => q.number === 7 && q.title === "Rename check"), "queue item lost by the rename", queue);
    await expectJSON("DELETE", `/api/bookmarks/${repo}`, 200, { token: session });
    await expectJSON("DELETE", "/api/queue/octo-org/rename-check/7", 200, { token: session });
    ok(`rename ${login} -> ${renamed} keeps the session, bookmarks and queue`);
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
