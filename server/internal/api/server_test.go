package api

import (
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/peterxcli/treehub/server/internal/auth"
)

var corsHeaders = map[string]string{
	"Access-Control-Allow-Origin":  "*",
	"Access-Control-Allow-Headers": "Authorization, Content-Type",
	"Access-Control-Allow-Methods": "GET, PUT, PATCH, POST, DELETE, OPTIONS",
	"Access-Control-Max-Age":       "86400",
}

func wantCORS(t *testing.T, rec *httptest.ResponseRecorder) {
	t.Helper()
	for k, v := range corsHeaders {
		if got := rec.Header().Get(k); got != v {
			t.Errorf("%s = %q, want %q", k, got, v)
		}
	}
}

func TestHealth(t *testing.T) {
	e := newTestEnv(t, Config{})
	for _, path := range []string{"/", "/api/health"} {
		rec := e.do("GET", path, "", "")
		res := decode[map[string]any](t, rec, http.StatusOK)
		if (*res)["ok"] != true || (*res)["service"] != "treehub" || len(*res) != 2 {
			t.Fatalf("%s: %s", path, rec.Body)
		}
		wantCORS(t, rec)
	}
}

func TestPreflight(t *testing.T) {
	e := newTestEnv(t, Config{})
	// Any OPTIONS request is a preflight, known path or not, without a token.
	for _, path := range []string{"/api/bookmarks/octo-org/tools", "/api/queue/octo-org/tools/1/seen", "/api/me", "/nowhere"} {
		req := httptest.NewRequest("OPTIONS", path, nil)
		req.Header.Set("Origin", "https://github.com")
		req.Header.Set("Access-Control-Request-Method", "PUT")
		req.Header.Set("Access-Control-Request-Headers", "authorization, content-type")
		rec := httptest.NewRecorder()
		e.h.ServeHTTP(rec, req)
		if rec.Code != http.StatusNoContent || rec.Body.Len() != 0 {
			t.Fatalf("%s: status %d body %q", path, rec.Code, rec.Body)
		}
		wantCORS(t, rec)
	}
}

func TestRouting(t *testing.T) {
	e := newTestEnv(t, Config{})
	token := e.session("octocat", 1)

	wantCORS(t, wantErrorRec(t, e.do("GET", "/api/nope", token, ""), http.StatusNotFound, "not_found"))
	wantErrorRec(t, e.do("GET", "/api/bookmarks/octo-org", token, ""), http.StatusNotFound, "not_found")
	wantErrorRec(t, e.do("GET", "/api/queue/octo-org/tools/1/unseen", token, ""), http.StatusNotFound, "not_found")
	wantErrorRec(t, e.do("PUT", "/api/me", token, ""), http.StatusMethodNotAllowed, "method_not_allowed")
	wantErrorRec(t, e.do("POST", "/api/bookmarks", token, ""), http.StatusMethodNotAllowed, "method_not_allowed")
	wantErrorRec(t, e.do("GET", "/api/queue/octo-org/tools/1/seen", token, ""), http.StatusMethodNotAllowed, "method_not_allowed")
	wantErrorRec(t, e.do("GET", "/api/logout-all", token, ""), http.StatusMethodNotAllowed, "method_not_allowed")
	// A trailing slash is the same path.
	decode[map[string]any](t, e.do("GET", "/api/bookmarks/", token, ""), http.StatusOK)
	decode[map[string]any](t, e.do("GET", "/api/health/", "", ""), http.StatusOK)
}

func wantErrorRec(t *testing.T, rec *httptest.ResponseRecorder, status int, code string) *httptest.ResponseRecorder {
	t.Helper()
	wantError(t, rec, status, code)
	return rec
}

func TestUnavailable(t *testing.T) {
	_, err := auth.NewSessions("too-short")
	if err == nil {
		t.Fatal("short SESSION_SECRET accepted")
	}
	rec := httptest.NewRecorder()
	Unavailable(err.Error()).ServeHTTP(rec, httptest.NewRequest("GET", "/api/health", nil))
	if res := wantError(t, rec, http.StatusInternalServerError, "internal"); res.GetMessage() != err.Error() {
		t.Fatalf("message = %q", res.GetMessage())
	}
	wantCORS(t, rec)
}
