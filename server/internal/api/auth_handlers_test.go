package api

import (
	"encoding/base64"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"
	"time"

	"github.com/golang-jwt/jwt/v5"

	treehubv1 "github.com/peterxcli/treehub/server/gen/go/treehub/v1"
	"github.com/peterxcli/treehub/server/internal/auth"
)

func TestAuthRequired(t *testing.T) {
	e := newTestEnv(t, Config{})
	token := e.session("octocat", 1)
	if e.me(token).Login != "octocat" {
		t.Fatal("valid session rejected")
	}

	wantError(t, e.do("GET", "/api/me", "", ""), http.StatusUnauthorized, "login_required")
	for _, path := range []string{"/api/bookmarks", "/api/queue"} {
		wantError(t, e.do("GET", path, "", ""), http.StatusUnauthorized, "login_required")
	}
	wantError(t, e.do("PUT", "/api/bookmarks/octo-org/tools", "", ""), http.StatusUnauthorized, "login_required")
	wantError(t, e.do("POST", "/api/logout-all", "", ""), http.StatusUnauthorized, "login_required")

	// Not a bearer token.
	req := httptest.NewRequest("GET", "/api/me", nil)
	req.Header.Set("Authorization", "Basic "+token)
	rec := httptest.NewRecorder()
	e.h.ServeHTTP(rec, req)
	wantError(t, rec, http.StatusUnauthorized, "login_required")

	// The scheme is case-insensitive.
	req = httptest.NewRequest("GET", "/api/me", nil)
	req.Header.Set("Authorization", "bearer "+token)
	rec = httptest.NewRecorder()
	e.h.ServeHTTP(rec, req)
	decode[map[string]any](t, rec, http.StatusOK)

	wantError(t, e.do("GET", "/api/me", "not-a-jwt", ""), http.StatusUnauthorized, "login_required")

	// Bad signature: signed with another secret.
	other, err := auth.NewSessions(strings.Repeat("x", auth.MinSecretLength))
	if err != nil {
		t.Fatal(err)
	}
	forged, err := other.Issue("octocat", 1, 0)
	if err != nil {
		t.Fatal(err)
	}
	wantError(t, e.do("GET", "/api/me", forged, ""), http.StatusUnauthorized, "login_required")

	// Tampered claims keep the old signature.
	parts := strings.Split(token, ".")
	parts[1] = base64.RawURLEncoding.EncodeToString([]byte(`{"uid":2,"ver":0,"sub":"octocat","exp":4102444800}`))
	wantError(t, e.do("GET", "/api/me", strings.Join(parts, "."), ""), http.StatusUnauthorized, "login_required")

	// HS256 only, even with the right key; exp is required.
	exp := jwt.NewNumericDate(e.now.Add(time.Hour))
	hs512, _ := jwt.NewWithClaims(jwt.SigningMethodHS512, auth.Claims{UID: 1, RegisteredClaims: jwt.RegisteredClaims{ExpiresAt: exp}}).SignedString([]byte(testSecret))
	wantError(t, e.do("GET", "/api/me", hs512, ""), http.StatusUnauthorized, "login_required")
	noExp, _ := jwt.NewWithClaims(jwt.SigningMethodHS256, auth.Claims{UID: 1}).SignedString([]byte(testSecret))
	wantError(t, e.do("GET", "/api/me", noExp, ""), http.StatusUnauthorized, "login_required")

	// Sessions last 30 days.
	e.now = e.now.Add(29 * 24 * time.Hour)
	e.me(token)
	e.now = e.now.Add(2 * 24 * time.Hour)
	wantError(t, e.do("GET", "/api/me", token, ""), http.StatusUnauthorized, "login_required")
}

func TestLogoutAllRevokesSessions(t *testing.T) {
	e := newTestEnv(t, Config{})
	first := e.session("octocat", 1)
	second := e.session("octocat", 1)
	e.me(first)
	e.me(second)

	wantOK(t, e.do("POST", "/api/logout-all", second, ""))
	for _, token := range []string{first, second} {
		res := wantError(t, e.do("GET", "/api/me", token, ""), http.StatusUnauthorized, "login_required")
		if res.GetMessage() != "session revoked" {
			t.Fatalf("message = %q", res.GetMessage())
		}
	}
	// A new sign-in carries the new version.
	fresh := e.session("octocat", 1)
	before, err := e.srv.Sessions.Parse(first)
	if err != nil {
		t.Fatal(err)
	}
	claims, err := e.srv.Sessions.Parse(fresh)
	if err != nil || claims.Ver != before.Ver+1 {
		t.Fatalf("claims = %+v (before: ver %d), %v", claims, before.Ver, err)
	}
	e.me(fresh)

	// A deleted user is signed out too.
	e.exec("DELETE FROM users")
	wantError(t, e.do("GET", "/api/me", fresh, ""), http.StatusUnauthorized, "login_required")
}

func TestRefreshSession(t *testing.T) {
	e := newTestEnv(t, Config{})
	token := e.session("octocat", 1)
	issued := e.now
	old, err := e.srv.Sessions.Parse(token)
	if err != nil {
		t.Fatal(err)
	}

	// Past half its lifetime: a new session, valid 30 days from now, for the same user and token version
	e.now = e.now.Add(20 * 24 * time.Hour)
	res := decode[treehubv1.RefreshSessionResponse](t, e.do("POST", "/api/session/refresh", token, ""), http.StatusOK)
	claims, err := e.srv.Sessions.Parse(res.Session)
	if err != nil {
		t.Fatal(err)
	}
	if claims.IssuedAt.Unix() != e.now.Unix() || claims.ExpiresAt.Unix() != e.now.Add(30*24*time.Hour).Unix() {
		t.Fatalf("issued %v, expires %v (now %v)", claims.IssuedAt, claims.ExpiresAt, e.now)
	}
	if claims.UID != old.UID || claims.Ver != old.Ver || claims.Subject != "octocat" {
		t.Fatalf("claims = %+v, old = %+v", claims, old)
	}

	// The new session outlives the old one
	e.now = issued.Add(31 * 24 * time.Hour)
	wantError(t, e.do("GET", "/api/me", token, ""), http.StatusUnauthorized, "login_required")
	wantError(t, e.do("POST", "/api/session/refresh", token, ""), http.StatusUnauthorized, "login_required")
	e.me(res.Session)

	// Signing out everywhere revokes refreshed sessions, which can't be refreshed then
	wantOK(t, e.do("POST", "/api/logout-all", res.Session, ""))
	wantError(t, e.do("POST", "/api/session/refresh", res.Session, ""), http.StatusUnauthorized, "login_required")
}

func TestGitHubStart(t *testing.T) {
	e := newTestEnv(t, Config{AllowedExtensionIDs: []string{testExt, "not-a-chrome-extension-id"}})

	for name, query := range map[string]string{
		"unknown ext":   "ext=" + strings.Repeat("a", 32) + "&nonce=" + testNonce,
		"malformed ext": "ext=not-a-chrome-extension-id&nonce=" + testNonce,
		"no ext":        "nonce=" + testNonce,
		"no nonce":      "ext=" + testExt,
		"short nonce":   "ext=" + testExt + "&nonce=" + strings.Repeat("n", 15),
		"long nonce":    "ext=" + testExt + "&nonce=" + strings.Repeat("n", 65),
		"bad nonce":     "ext=" + testExt + "&nonce=" + url.QueryEscape("nonce.0123456789abcdef"),
	} {
		rec := e.do("GET", "/auth/github/start?"+query, "", "")
		wantError(t, rec, http.StatusBadRequest, "invalid_request")
		if rec.Header().Get("Location") != "" {
			t.Fatalf("%s: redirected", name)
		}
	}

	rec := e.do("GET", "/auth/github/start?ext="+testExt+"&nonce="+testNonce, "", "")
	if rec.Code != http.StatusFound {
		t.Fatalf("status = %d: %s", rec.Code, rec.Body)
	}
	loc, err := url.Parse(rec.Header().Get("Location"))
	if err != nil {
		t.Fatal(err)
	}
	q := loc.Query()
	if loc.Scheme+"://"+loc.Host+loc.Path != "https://github.com/login/oauth/authorize" ||
		q.Get("client_id") != "client-id" || q.Get("scope") != "repo" ||
		q.Get("redirect_uri") != "http://example.com/auth/github/callback" {
		t.Fatalf("Location = %s", loc)
	}
	st, err := e.srv.Sessions.ParseState(q.Get("state"))
	if err != nil {
		t.Fatal(err)
	}
	if st.Ext != testExt || st.Nonce != testNonce || st.Exp != e.now.Add(10*time.Minute).Unix() {
		t.Fatalf("state = %+v", st)
	}

	// Behind TLS the callback is https.
	req := httptest.NewRequest("GET", "https://treehub.example.workers.dev/auth/github/start?ext="+testExt+"&nonce="+testNonce, nil)
	rec = httptest.NewRecorder()
	e.h.ServeHTTP(rec, req)
	loc, _ = url.Parse(rec.Header().Get("Location"))
	if got := loc.Query().Get("redirect_uri"); got != "https://treehub.example.workers.dev/auth/github/callback" {
		t.Fatalf("redirect_uri = %q", got)
	}

	e.srv.GitHub.ClientSecret = ""
	wantError(t, e.do("GET", "/auth/github/start?ext="+testExt+"&nonce="+testNonce, "", ""), http.StatusInternalServerError, "oauth_not_configured")
}

func TestGitHubCallback(t *testing.T) {
	e := newTestEnv(t, Config{})
	name, avatar := "The Octocat", "https://avatars.githubusercontent.com/u/583231?v=4"
	e.github.user = auth.GitHubUser{Login: "octocat", ID: 583231, Name: &name, AvatarURL: &avatar}

	rec := e.do("GET", "/auth/github/callback?code="+testCode+"&state="+url.QueryEscape(e.startState()), "", "")
	if rec.Header().Get("Cache-Control") != "no-store" {
		t.Fatalf("Cache-Control = %q", rec.Header().Get("Cache-Control"))
	}
	frag := extensionFragment(t, rec)
	if len(frag) != 4 || frag.Get("session") == "" || frag.Get("github_token") != testToken ||
		frag.Get("login") != "octocat" || frag.Get("nonce") != testNonce {
		t.Fatalf("fragment = %v", frag)
	}

	// What GitHub was sent.
	f := e.github
	if f.tokenForm.Get("client_id") != "client-id" || f.tokenForm.Get("client_secret") != "client-secret" ||
		f.tokenForm.Get("code") != testCode || f.tokenForm.Get("redirect_uri") != "http://example.com/auth/github/callback" ||
		f.tokenHeader.Get("Accept") != "application/json" {
		t.Fatalf("token request = %v %v", f.tokenForm, f.tokenHeader)
	}
	if f.userHeader.Get("Authorization") != "Bearer "+testToken || f.userHeader.Get("Accept") != "application/vnd.github+json" ||
		f.userHeader.Get("User-Agent") != "treehub" {
		t.Fatalf("user request headers = %v", f.userHeader)
	}

	// The session JWT.
	claims, err := e.srv.Sessions.Parse(frag.Get("session"))
	if err != nil {
		t.Fatal(err)
	}
	if claims.Subject != "octocat" || claims.UID != 583231 ||
		claims.ExpiresAt.Sub(claims.IssuedAt.Time) != 30*24*time.Hour {
		t.Fatalf("claims = %+v", claims)
	}

	// The user row (the GitHub token is not stored anywhere).
	var login, gotName, gotAvatar, lastLogin string
	var githubID, version int64
	err = e.db.QueryRow("SELECT login, github_id, name, avatar_url, last_login_at, token_version FROM users").
		Scan(&login, &githubID, &gotName, &gotAvatar, &lastLogin, &version)
	if err != nil || login != "octocat" || githubID != 583231 || gotName != name || gotAvatar != avatar || lastLogin == "" {
		t.Fatalf("user row = %q %d %q %q %q, %v", login, githubID, gotName, gotAvatar, lastLogin, err)
	}
	if claims.Ver != version {
		t.Fatalf("ver = %d, token_version = %d", claims.Ver, version)
	}

	u := e.me(frag.Get("session"))
	if u.Login != "octocat" || u.GithubId != 583231 || u.GetName() != name || u.GetAvatarUrl() != avatar {
		t.Fatalf("me = %+v", u)
	}
	if _, err := time.Parse(time.RFC3339, u.CreatedAt); err != nil {
		t.Fatalf("created_at = %q", u.CreatedAt)
	}

	// Signing in again updates the profile (GitHub may drop the name).
	e.github.user = auth.GitHubUser{Login: "octocat", ID: 583231, AvatarURL: &avatar}
	e.githubLogin(e.github.user)
	if u := e.me(frag.Get("session")); u.Name != nil || e.count("SELECT COUNT(*) FROM users") != 1 {
		t.Fatalf("after second login: %+v", u)
	}
}

func TestGitHubCallbackExpiringToken(t *testing.T) {
	e := newTestEnv(t, Config{})
	e.github.expiring = true
	e.github.user = auth.GitHubUser{Login: "octocat", ID: 583231}

	frag := extensionFragment(t, e.do("GET", "/auth/github/callback?code="+testCode+"&state="+url.QueryEscape(e.startState()), "", ""))
	if len(frag) != 7 || frag.Get("github_token") != testToken || frag.Get("github_refresh_token") != "ghr_test_"+testCode ||
		frag.Get("github_expires_at") != e.now.Add(8*time.Hour).Format(time.RFC3339) ||
		frag.Get("github_refresh_expires_at") != e.now.Add(15897600*time.Second).Format(time.RFC3339) {
		t.Fatalf("fragment = %v", frag)
	}
}

func TestRefreshGitHubToken(t *testing.T) {
	e := newTestEnv(t, Config{})
	e.github.user = auth.GitHubUser{Login: "octocat", ID: 583231}
	token := e.session("octocat", 583231)

	res := decode[treehubv1.GitHubToken](t, e.do("POST", "/api/github/token", token, `{"refresh_token":"ghr_one"}`), http.StatusOK)
	if res.AccessToken != "gho_refreshed_1" || res.GetRefreshToken() != "ghr_refreshed_1" ||
		res.GetExpiresAt() != e.now.Add(8*time.Hour).Format(time.RFC3339) ||
		res.GetRefreshTokenExpiresAt() != e.now.Add(15897600*time.Second).Format(time.RFC3339) {
		t.Fatalf("token = %+v", res)
	}
	// What GitHub was sent: the refresh token with the app's credentials; then the new token read the user
	f := e.github
	if f.tokenForm.Get("grant_type") != "refresh_token" || f.tokenForm.Get("refresh_token") != "ghr_one" ||
		f.tokenForm.Get("client_id") != "client-id" || f.tokenForm.Get("client_secret") != "client-secret" {
		t.Fatalf("token request = %v", f.tokenForm)
	}
	if f.userHeader.Get("Authorization") != "Bearer gho_refreshed_1" {
		t.Fatalf("user request headers = %v", f.userHeader)
	}

	// GitHub refuses the refresh token: signing in again is the only way
	wantError(t, e.do("POST", "/api/github/token", token, `{"refresh_token":"expired"}`), http.StatusBadRequest, "github_refresh_refused")
	// A token of another GitHub account isn't handed out
	e.github.user = auth.GitHubUser{Login: "someone", ID: 1}
	wantError(t, e.do("POST", "/api/github/token", token, `{"refresh_token":"ghr_other"}`), http.StatusForbidden, "github_user_mismatch")
	// Signed in, with a refresh token
	wantError(t, e.do("POST", "/api/github/token", "", `{"refresh_token":"ghr_one"}`), http.StatusUnauthorized, "login_required")
	wantError(t, e.do("POST", "/api/github/token", token, `{}`), http.StatusBadRequest, "invalid_body")
}

func TestGitHubCallbackRejectsBadState(t *testing.T) {
	e := newTestEnv(t, Config{})
	e.github.user = auth.GitHubUser{Login: "octocat", ID: 1}
	state := e.startState()
	payload, sig, _ := strings.Cut(state, ".")

	raw, err := base64.RawURLEncoding.DecodeString(payload)
	if err != nil {
		t.Fatal(err)
	}
	otherNonce := strings.Replace(string(raw), testNonce, "attacker-nonce-0123456789", 1)
	other, _ := auth.NewSessions(strings.Repeat("y", 40))
	foreign, _ := other.NewState(testExt, testNonce)
	flipped := []byte(sig)
	flipped[0] ^= 1
	// The last character of a 32-byte signature carries 2 unused bits: setting
	// one gives another spelling of the same bytes, which strict decoding refuses.
	const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_"
	respelled := sig[:len(sig)-1] + string(alphabet[strings.IndexByte(alphabet, sig[len(sig)-1])^1])
	a, _ := base64.RawURLEncoding.DecodeString(sig)
	b, _ := base64.RawURLEncoding.DecodeString(respelled)
	if string(a) != string(b) {
		t.Fatal("respelled signature decodes differently")
	}

	for name, bad := range map[string]string{
		"missing":             "",
		"garbage":             "garbage",
		"payload changed":     base64.RawURLEncoding.EncodeToString([]byte(otherNonce)) + "." + sig,
		"signature changed":   payload + "." + string(flipped),
		"signature respelled": payload + "." + respelled,
		"no signature":        payload,
		"other secret":        foreign,
	} {
		rec := e.do("GET", "/auth/github/callback?code="+testCode+"&state="+url.QueryEscape(bad), "", "")
		wantError(t, rec, http.StatusBadRequest, "invalid_state")
		if rec.Header().Get("Location") != "" {
			t.Fatalf("%s: redirected", name)
		}
	}

	// States expire after 10 minutes.
	e.now = e.now.Add(10*time.Minute + time.Second)
	res := wantError(t, e.do("GET", "/auth/github/callback?code="+testCode+"&state="+url.QueryEscape(state), "", ""), http.StatusBadRequest, "invalid_state")
	if !strings.Contains(res.GetMessage(), "expired") {
		t.Fatalf("message = %q", res.GetMessage())
	}

	// An extension removed from the allow list no longer receives sessions.
	e.now = time.Now().UTC()
	fresh := e.startState()
	e.srv.Cfg.AllowedExtensionIDs = nil
	wantError(t, e.do("GET", "/auth/github/callback?code="+testCode+"&state="+url.QueryEscape(fresh), "", ""), http.StatusBadRequest, "invalid_state")

	if e.github.tokenForm != nil || e.count("SELECT COUNT(*) FROM users") != 0 {
		t.Fatal("a bad state reached GitHub or created a user")
	}
}

func TestGitHubCallbackFailuresRedirectToExtension(t *testing.T) {
	e := newTestEnv(t, Config{})
	callback := func(query string) url.Values {
		t.Helper()
		return extensionFragment(t, e.do("GET", "/auth/github/callback?"+query+"&state="+url.QueryEscape(e.startState()), "", ""))
	}

	// The user cancelled on GitHub.
	rec := e.do("GET", "/auth/github/callback?error=access_denied&error_description=The+user+has+denied&state="+url.QueryEscape(e.startState()), "", "")
	if got, want := rec.Header().Get("Location"), "https://"+testExt+".chromiumapp.org/github#error=access_denied&nonce="+testNonce; got != want {
		t.Fatalf("Location = %q, want %q", got, want)
	}

	wantFailure := func(frag url.Values, reason string) {
		t.Helper()
		if len(frag) != 2 || frag.Get("error") != reason || frag.Get("nonce") != testNonce {
			t.Fatalf("fragment = %v, want error=%s", frag, reason)
		}
	}
	wantFailure(callback("code="), "exchange")

	e.github.tokenError = "bad_verification_code"
	wantFailure(callback("code="+testCode), "exchange")

	e.github.tokenError = ""
	e.github.userStatus = http.StatusUnauthorized
	wantFailure(callback("code="+testCode), "user")

	e.github.userStatus = 0
	e.github.user = auth.GitHubUser{ID: 1} // no login
	wantFailure(callback("code="+testCode), "user")

	if n := e.count("SELECT COUNT(*) FROM users"); n != 0 {
		t.Fatalf("%d users created", n)
	}
}

func TestRenameKeepsDataAndSessions(t *testing.T) {
	e := newTestEnv(t, Config{})
	old := e.session("octocat", 1)
	decode[map[string]any](t, e.do("PUT", "/api/bookmarks/octo-org/tools", old, ""), http.StatusOK)
	decode[map[string]any](t, e.do("PUT", "/api/queue/octo-org/tools/7", old, `{"title":"Fix the tree"}`), http.StatusOK)
	decode[map[string]any](t, e.do("PUT", "/api/history/pulls/octo-org/tools/7", old, `{"title":"Fix the tree"}`), http.StatusOK)

	// The account was renamed on GitHub.
	frag := e.githubLogin(auth.GitHubUser{Login: "octo-renamed", ID: 1})
	if frag.Get("login") != "octo-renamed" {
		t.Fatalf("fragment = %v", frag)
	}
	for _, token := range []string{old, frag.Get("session")} {
		if got := e.me(token).Login; got != "octo-renamed" {
			t.Fatalf("login = %q", got)
		}
		if got := e.bookmarkRepos(token); !sameStrings(got, []string{"octo-org/tools"}) {
			t.Fatalf("bookmarks = %v", got)
		}
		if got := e.queueKeys(token); !sameStrings(got, []string{"octo-org/tools#7"}) {
			t.Fatalf("queue = %v", got)
		}
		if got := e.historyKeys(token); !sameStrings(got, []string{"octo-org/tools#7"}) {
			t.Fatalf("history = %v", got)
		}
	}
	if n := e.count("SELECT COUNT(*) FROM users"); n != 1 {
		t.Fatalf("%d users", n)
	}

	// Only the case changed: SQLite would skip the cascade for a NOCASE key,
	// so the rows must still follow.
	e.githubLogin(auth.GitHubUser{Login: "Octo-Renamed", ID: 1})
	if got := e.me(old).Login; got != "Octo-Renamed" {
		t.Fatalf("login = %q", got)
	}
	if got := e.bookmarkRepos(old); len(got) != 1 {
		t.Fatalf("bookmarks after case change = %v", got)
	}
	if got := e.queueKeys(old); len(got) != 1 {
		t.Fatalf("queue after case change = %v", got)
	}
	if got := e.historyKeys(old); len(got) != 1 {
		t.Fatalf("history after case change = %v", got)
	}
	if n := e.count("SELECT COUNT(*) FROM bookmarks WHERE login = 'Octo-Renamed' COLLATE BINARY"); n != 1 {
		t.Fatalf("bookmark rows with the new spelling: %d", n)
	}
	if n := e.count("SELECT COUNT(*) FROM queue_items WHERE login = 'Octo-Renamed' COLLATE BINARY"); n != 1 {
		t.Fatalf("queue rows with the new spelling: %d", n)
	}
	if n := e.count("SELECT COUNT(*) FROM history WHERE login = 'Octo-Renamed' COLLATE BINARY"); n != 1 {
		t.Fatalf("history rows with the new spelling: %d", n)
	}
}

func TestTakenOverHandleParksStaleUser(t *testing.T) {
	e := newTestEnv(t, Config{})
	first := e.session("octocat", 1)
	decode[map[string]any](t, e.do("PUT", "/api/bookmarks/first/repo", first, ""), http.StatusOK)

	// Account 1 renamed away on GitHub without signing in again, and
	// account 2 took the handle (spelled differently).
	second := e.session("OctoCat", 2)
	if u := e.me(second); u.Login != "OctoCat" || u.GithubId != 2 {
		t.Fatalf("second = %+v", u)
	}
	if got := e.bookmarkRepos(second); len(got) != 0 {
		t.Fatalf("second sees %v", got)
	}
	if got := e.me(first).Login; got != "octocat~1" {
		t.Fatalf("parked login = %q", got)
	}
	if got := e.bookmarkRepos(first); !sameStrings(got, []string{"first/repo"}) {
		t.Fatalf("first lost its bookmarks: %v", got)
	}

	// Account 1 signs in with its new handle and gets its data under it.
	e.githubLogin(auth.GitHubUser{Login: "octo-one", ID: 1})
	if got := e.me(first).Login; got != "octo-one" {
		t.Fatalf("login = %q", got)
	}
	if got := e.bookmarkRepos(first); !sameStrings(got, []string{"first/repo"}) {
		t.Fatalf("bookmarks = %v", got)
	}
}

func TestDevLogin(t *testing.T) {
	query := "/auth/dev-login?ext=" + testExt + "&nonce=" + testNonce

	off := newTestEnv(t, Config{})
	wantError(t, off.do("GET", query+"&login=octocat", "", ""), http.StatusNotFound, "not_found")
	if off.count("SELECT COUNT(*) FROM users") != 0 {
		t.Fatal("dev login created a user without DEV_AUTH")
	}

	e := newTestEnv(t, Config{DevAuth: true})
	frag := extensionFragment(t, e.do("GET", query, "", ""))
	if len(frag) != 3 || frag.Get("login") != "octocat" || frag.Get("nonce") != testNonce || frag.Has("github_token") {
		t.Fatalf("fragment = %v", frag)
	}
	u := e.me(frag.Get("session"))
	if u.Login != "octocat" || u.GithubId <= 0 || u.GithubId >= 1<<31 {
		t.Fatalf("me = %+v", u)
	}

	// The fake id is stable per handle, whatever the case.
	again := extensionFragment(t, e.do("GET", query+"&login=OctoCat", "", ""))
	if e.me(again.Get("session")).GithubId != u.GithubId {
		t.Fatal("dev login id is not stable")
	}
	other := extensionFragment(t, e.do("GET", query+"&login=hubot", "", ""))
	if e.me(other.Get("session")).GithubId == u.GithubId {
		t.Fatal("different handles share an id")
	}

	wantError(t, e.do("GET", "/auth/dev-login?ext="+strings.Repeat("b", 32)+"&nonce="+testNonce, "", ""), http.StatusBadRequest, "invalid_request")
	wantError(t, e.do("GET", "/auth/dev-login?ext="+testExt+"&nonce=short", "", ""), http.StatusBadRequest, "invalid_request")
	wantError(t, e.do("GET", query+"&login=-bad-", "", ""), http.StatusBadRequest, "invalid_request")
	wantError(t, e.do("GET", query+"&login=octo~cat", "", ""), http.StatusBadRequest, "invalid_request")
}

func TestDeleteAccount(t *testing.T) {
	e := newTestEnv(t, Config{})
	old := e.session("octocat", 1)
	other := e.session("hubot", 2)
	decode[map[string]any](t, e.do("PUT", "/api/bookmarks/octo-org/tools", old, ""), http.StatusOK)
	decode[map[string]any](t, e.do("PUT", "/api/queue/octo-org/tools/7", old, `{"title":"Fix the tree"}`), http.StatusOK)
	decode[map[string]any](t, e.do("PUT", "/api/history/pulls/octo-org/tools/7", old, ""), http.StatusOK)
	decode[map[string]any](t, e.do("PUT", "/api/history/settings", old, `{"retention_days":7,"paused":true}`), http.StatusOK)
	decode[map[string]any](t, e.do("PUT", "/api/bookmarks/octo-org/tools", other, ""), http.StatusOK)
	decode[map[string]any](t, e.do("PUT", "/api/history/repos/octo-org/tools", other, ""), http.StatusOK)

	wantError(t, e.do("DELETE", "/api/me", "", ""), http.StatusUnauthorized, "login_required")
	wantOK(t, e.do("DELETE", "/api/me", old, ""))

	// The account and its rows are gone; other accounts are untouched.
	for query, want := range map[string]int{
		"SELECT COUNT(*) FROM users WHERE github_id = 1":           0,
		"SELECT COUNT(*) FROM bookmarks WHERE login = 'octocat'":   0,
		"SELECT COUNT(*) FROM queue_items WHERE login = 'octocat'": 0,
		"SELECT COUNT(*) FROM history WHERE login = 'octocat'":     0,
		"SELECT COUNT(*) FROM bookmarks WHERE login = 'hubot'":     1,
		"SELECT COUNT(*) FROM history WHERE login = 'hubot'":       1,
	} {
		if got := e.count(query); got != want {
			t.Fatalf("%s = %d, want %d", query, got, want)
		}
	}
	res := wantError(t, e.do("GET", "/api/me", old, ""), http.StatusUnauthorized, "login_required")
	if res.GetMessage() != "unknown user" {
		t.Fatalf("message = %q", res.GetMessage())
	}
	wantError(t, e.do("DELETE", "/api/me", old, ""), http.StatusUnauthorized, "login_required")
	e.me(other)

	// Signing in again creates a fresh, empty account, and the old session
	// stays dead although it names the same GitHub id.
	fresh := e.githubLogin(auth.GitHubUser{Login: "octocat", ID: 1}).Get("session")
	if u := e.me(fresh); u.Login != "octocat" || u.GithubId != 1 {
		t.Fatalf("me = %+v", u)
	}
	if got := e.bookmarkRepos(fresh); len(got) != 0 {
		t.Fatalf("bookmarks = %v", got)
	}
	if got := e.queueKeys(fresh); len(got) != 0 {
		t.Fatalf("queue = %v", got)
	}
	if got := e.historyKeys(fresh); len(got) != 0 {
		t.Fatalf("history = %v", got)
	}
	if s := e.historySettings(fresh); s.RetentionDays != 30 || s.Paused {
		t.Fatalf("history settings = %v", s)
	}
	wantError(t, e.do("GET", "/api/me", old, ""), http.StatusUnauthorized, "login_required")
}
