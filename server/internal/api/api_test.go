package api

import (
	"bytes"
	"database/sql"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"testing"
	"time"

	_ "modernc.org/sqlite" // pure-Go SQLite, test-only (the Worker uses D1)

	treehubv1 "github.com/peterxcli/treehub/server/gen/go/treehub/v1"
	"github.com/peterxcli/treehub/server/internal/auth"
	"github.com/peterxcli/treehub/server/internal/db"
)

const (
	testExt    = "kamkelclcngghlnfcejjkcckpcnkdaim"
	testNonce  = "nonce-0123456789_abcdef"
	testSecret = "test-session-secret-0123456789-abcdef"
	testCode   = "code-abc"
	testToken  = "gho_test_" + testCode // what the fake GitHub hands out for testCode
)

// testEnv is a Server on an in-memory SQLite database with the real
// migrations, a stubbed GitHub and a controllable clock.
type testEnv struct {
	t      *testing.T
	db     *sql.DB
	srv    *Server
	h      http.Handler
	github *fakeGitHub
	now    time.Time
}

func newTestEnv(t *testing.T, cfg Config) *testEnv {
	t.Helper()
	sessions, err := auth.NewSessions(testSecret)
	if err != nil {
		t.Fatal(err)
	}
	e := &testEnv{t: t, db: openTestDB(t), github: &fakeGitHub{}, now: time.Now().UTC().Truncate(time.Second)}
	sessions.Now = func() time.Time { return e.now }
	if cfg.AllowedExtensionIDs == nil {
		cfg.AllowedExtensionIDs = []string{testExt}
	}
	e.srv = &Server{
		Q:        db.New(e.db),
		Sessions: sessions,
		GitHub:   &auth.GitHub{ClientID: "client-id", ClientSecret: "client-secret", HTTP: &http.Client{Transport: e.github}},
		Cfg:      cfg,
		Now:      func() time.Time { return e.now },
	}
	e.h = e.srv.Handler()
	return e
}

func openTestDB(t *testing.T) *sql.DB {
	t.Helper()
	sqldb, err := sql.Open("sqlite", ":memory:")
	if err != nil {
		t.Fatal(err)
	}
	// Every new connection to :memory: is a new, empty database.
	sqldb.SetMaxOpenConns(1)
	t.Cleanup(func() { sqldb.Close() })
	// D1 enforces foreign keys; renames rely on ON UPDATE CASCADE.
	if _, err := sqldb.Exec("PRAGMA foreign_keys = ON"); err != nil {
		t.Fatal(err)
	}
	files, err := filepath.Glob("../../migrations/*.sql")
	if err != nil || len(files) == 0 {
		t.Fatalf("migrations: %v %v", files, err)
	}
	sort.Strings(files)
	for _, f := range files {
		schema, err := os.ReadFile(f)
		if err != nil {
			t.Fatal(err)
		}
		if _, err := sqldb.Exec(string(schema)); err != nil {
			t.Fatalf("%s: %v", f, err)
		}
	}
	return sqldb
}

// do sends a request through the handler. An empty token or body is omitted.
func (e *testEnv) do(method, target, token, body string) *httptest.ResponseRecorder {
	e.t.Helper()
	var rd io.Reader
	if body != "" {
		rd = strings.NewReader(body)
	}
	req := httptest.NewRequest(method, target, rd)
	if body != "" {
		req.Header.Set("Content-Type", "application/json")
	}
	if token != "" {
		req.Header.Set("Authorization", "Bearer "+token)
	}
	rec := httptest.NewRecorder()
	e.h.ServeHTTP(rec, req)
	return rec
}

// decode checks the status and decodes the JSON body.
func decode[T any](t *testing.T, rec *httptest.ResponseRecorder, status int) *T {
	t.Helper()
	if rec.Code != status {
		t.Fatalf("status = %d, want %d; body: %s", rec.Code, status, rec.Body)
	}
	if ct := rec.Header().Get("Content-Type"); !strings.HasPrefix(ct, "application/json") {
		t.Fatalf("content-type = %q", ct)
	}
	var v T
	if err := json.Unmarshal(rec.Body.Bytes(), &v); err != nil {
		t.Fatalf("decode %s: %v", rec.Body, err)
	}
	return &v
}

func wantError(t *testing.T, rec *httptest.ResponseRecorder, status int, code string) *treehubv1.ErrorResponse {
	t.Helper()
	res := decode[treehubv1.ErrorResponse](t, rec, status)
	if res.Error != code {
		t.Fatalf("error = %q (%s), want %q", res.Error, res.GetMessage(), code)
	}
	return res
}

func wantOK(t *testing.T, rec *httptest.ResponseRecorder) {
	t.Helper()
	if res := decode[treehubv1.OkResponse](t, rec, http.StatusOK); !res.Ok {
		t.Fatalf("ok = false: %s", rec.Body)
	}
}

// ---------- login helpers ----------

// startState runs /auth/github/start and returns the state sent to GitHub.
func (e *testEnv) startState() string {
	e.t.Helper()
	rec := e.do("GET", "/auth/github/start?ext="+testExt+"&nonce="+testNonce, "", "")
	if rec.Code != http.StatusFound {
		e.t.Fatalf("start: status %d: %s", rec.Code, rec.Body)
	}
	loc, err := url.Parse(rec.Header().Get("Location"))
	if err != nil {
		e.t.Fatal(err)
	}
	return loc.Query().Get("state")
}

// githubLogin runs the whole OAuth round trip as gh and returns the fragment
// of the redirect back to the extension.
func (e *testEnv) githubLogin(gh auth.GitHubUser) url.Values {
	e.t.Helper()
	e.github.user = gh
	rec := e.do("GET", "/auth/github/callback?code="+testCode+"&state="+url.QueryEscape(e.startState()), "", "")
	frag := extensionFragment(e.t, rec)
	if frag.Get("error") != "" || frag.Get("session") == "" {
		e.t.Fatalf("login failed: %v", frag)
	}
	return frag
}

// session signs in through GitHub and returns the session token.
func (e *testEnv) session(login string, githubID int64) string {
	e.t.Helper()
	return e.githubLogin(auth.GitHubUser{Login: login, ID: githubID}).Get("session")
}

// extensionFragment checks a redirect to the extension and parses its fragment.
func extensionFragment(t *testing.T, rec *httptest.ResponseRecorder) url.Values {
	t.Helper()
	if rec.Code != http.StatusFound {
		t.Fatalf("status = %d, want 302; body: %s", rec.Code, rec.Body)
	}
	loc := rec.Header().Get("Location")
	prefix := "https://" + testExt + ".chromiumapp.org/github#"
	if !strings.HasPrefix(loc, prefix) {
		t.Fatalf("Location = %q, want prefix %q", loc, prefix)
	}
	frag, err := url.ParseQuery(strings.TrimPrefix(loc, prefix))
	if err != nil {
		t.Fatal(err)
	}
	return frag
}

func (e *testEnv) me(token string) *treehubv1.User {
	e.t.Helper()
	res := decode[treehubv1.MeResponse](e.t, e.do("GET", "/api/me", token, ""), http.StatusOK)
	if res.User == nil {
		e.t.Fatal("me: no user")
	}
	return res.User
}

func (e *testEnv) bookmarkRepos(token string) []string {
	e.t.Helper()
	res := decode[treehubv1.ListBookmarksResponse](e.t, e.do("GET", "/api/bookmarks", token, ""), http.StatusOK)
	repos := []string{}
	for _, b := range res.Bookmarks {
		repos = append(repos, b.Repo)
	}
	return repos
}

func (e *testEnv) queueKeys(token string) []string {
	e.t.Helper()
	res := decode[treehubv1.ListQueueResponse](e.t, e.do("GET", "/api/queue", token, ""), http.StatusOK)
	keys := []string{}
	for _, q := range res.Items {
		keys = append(keys, fmt.Sprintf("%s#%d", q.Repo, q.Number))
	}
	return keys
}

// historyKeys lists the history (one page of up to 100) as "owner/name" for a
// repository and "owner/name#number" for a pull request.
func (e *testEnv) historyKeys(token string) []string {
	e.t.Helper()
	res := decode[treehubv1.ListHistoryResponse](e.t, e.do("GET", "/api/history?limit=100", token, ""), http.StatusOK)
	if res.NextCursor != nil {
		e.t.Fatal("history has more than one page")
	}
	return historyItemKeys(e.t, res.Items)
}

func historyItemKeys(t *testing.T, items []*treehubv1.HistoryItem) []string {
	t.Helper()
	keys := []string{}
	for _, h := range items {
		switch {
		case h.Kind == "repo" && h.Number == 0:
			keys = append(keys, h.Repo)
		case h.Kind == "pull" && h.Number > 0:
			keys = append(keys, fmt.Sprintf("%s#%d", h.Repo, h.Number))
		default:
			t.Fatalf("history item %v", h)
		}
	}
	return keys
}

func (e *testEnv) exec(query string, args ...any) {
	e.t.Helper()
	if _, err := e.db.Exec(query, args...); err != nil {
		e.t.Fatal(err)
	}
}

func (e *testEnv) count(query string, args ...any) int {
	e.t.Helper()
	var n int
	if err := e.db.QueryRow(query, args...).Scan(&n); err != nil {
		e.t.Fatal(err)
	}
	return n
}

func sameStrings(a, b []string) bool {
	return strings.Join(a, "\n") == strings.Join(b, "\n")
}

// ---------- fake GitHub ----------

// fakeGitHub answers the two GitHub endpoints the login uses and records
// what it was sent.
type fakeGitHub struct {
	user       auth.GitHubUser // GET /user answer
	tokenError string          // non-empty: the token endpoint reports this error
	userStatus int             // non-zero: GET /user fails with this status

	tokenForm   url.Values  // last token request body
	tokenHeader http.Header // last token request headers
	userHeader  http.Header // last GET /user headers
}

func (f *fakeGitHub) RoundTrip(req *http.Request) (*http.Response, error) {
	var body []byte
	if req.Body != nil {
		body, _ = io.ReadAll(req.Body)
		req.Body.Close()
	}
	switch req.Method + " " + req.URL.String() {
	case "POST https://github.com/login/oauth/access_token":
		f.tokenForm, _ = url.ParseQuery(string(body))
		f.tokenHeader = req.Header.Clone()
		if f.tokenError != "" {
			return jsonResponse(http.StatusOK, map[string]string{"error": f.tokenError, "error_description": "nope"})
		}
		return jsonResponse(http.StatusOK, map[string]string{
			"access_token": "gho_test_" + f.tokenForm.Get("code"), "token_type": "bearer", "scope": "repo",
		})
	case "GET https://api.github.com/user":
		f.userHeader = req.Header.Clone()
		if f.userStatus != 0 {
			return jsonResponse(f.userStatus, map[string]string{"message": "Bad credentials"})
		}
		return jsonResponse(http.StatusOK, f.user)
	}
	return nil, fmt.Errorf("unexpected request %s %s", req.Method, req.URL)
}

func jsonResponse(status int, v any) (*http.Response, error) {
	b, err := json.Marshal(v)
	if err != nil {
		return nil, err
	}
	return &http.Response{
		StatusCode: status,
		Header:     http.Header{"Content-Type": []string{"application/json"}},
		Body:       io.NopCloser(bytes.NewReader(b)),
	}, nil
}
