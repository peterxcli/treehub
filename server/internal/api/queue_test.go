package api

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
	"unicode/utf8"

	treehubv1 "github.com/peterxcli/treehub/server/gen/go/treehub/v1"
)

func TestQueue(t *testing.T) {
	e := newTestEnv(t, Config{})
	token := e.session("octocat", 1)
	const path = "/api/queue/Octo-Org/tools/42"

	item := decode[treehubv1.QueueItem](t, e.do("PUT", path, token, `{"title":"  Fix the tree  "}`), http.StatusOK)
	if item.Repo != "Octo-Org/tools" || item.Number != 42 || item.GetTitle() != "Fix the tree" || item.LastSeenAt != nil {
		t.Fatalf("item = %+v", item)
	}
	if _, err := time.Parse(time.RFC3339, item.AddedAt); err != nil {
		t.Fatalf("added_at = %q", item.AddedAt)
	}
	e.exec("UPDATE queue_items SET added_at = '2020-01-02T03:04:05Z'")

	// Without a title (no body, empty object, null) the cached one stays.
	for _, body := range []string{"", "{}", `{"title":null}`, "  "} {
		got := decode[treehubv1.QueueItem](t, e.do("PUT", "/api/queue/octo-org/TOOLS/42", token, body), http.StatusOK)
		if got.GetTitle() != "Fix the tree" || got.AddedAt != "2020-01-02T03:04:05Z" {
			t.Fatalf("body %q: item = %+v", body, got)
		}
	}
	// A title replaces it; an empty one clears it.
	if got := decode[treehubv1.QueueItem](t, e.do("PUT", path, token, `{"title":"Fix the tree, take 2"}`), http.StatusOK); got.GetTitle() != "Fix the tree, take 2" {
		t.Fatalf("title = %q", got.GetTitle())
	}
	if got := decode[treehubv1.QueueItem](t, e.do("PUT", path, token, `{"title":"   "}`), http.StatusOK); got.Title != nil {
		t.Fatalf("title = %q", got.GetTitle())
	}
	// Titles are cut to 300 characters (not bytes).
	long := strings.Repeat("é", 400)
	got := decode[treehubv1.QueueItem](t, e.do("PUT", path, token, `{"title":"`+long+`"}`), http.StatusOK)
	if utf8.RuneCountInString(got.GetTitle()) != 300 || got.GetTitle() != long[:600] {
		t.Fatalf("title has %d characters", utf8.RuneCountInString(got.GetTitle()))
	}
	if n := e.count("SELECT COUNT(*) FROM queue_items"); n != 1 {
		t.Fatalf("%d rows", n)
	}

	// Seen.
	seen := decode[treehubv1.QueueItem](t, e.do("POST", path+"/seen", token, ""), http.StatusOK)
	if seen.LastSeenAt == nil || seen.Number != 42 {
		t.Fatalf("seen = %+v", seen)
	}
	if _, err := time.Parse(time.RFC3339, seen.GetLastSeenAt()); err != nil {
		t.Fatalf("last_seen_at = %q", seen.GetLastSeenAt())
	}
	if again := decode[treehubv1.QueueItem](t, e.do("PUT", path, token, ""), http.StatusOK); again.GetLastSeenAt() != seen.GetLastSeenAt() {
		t.Fatal("PUT reset last_seen_at")
	}
	wantError(t, e.do("POST", "/api/queue/octo-org/tools/43/seen", token, ""), http.StatusNotFound, "not_found")
	wantError(t, e.do("POST", path+"/seen", e.session("hubot", 2), ""), http.StatusNotFound, "not_found")

	// Newest first, then delete (idempotent).
	decode[treehubv1.QueueItem](t, e.do("PUT", "/api/queue/octo-org/tools/1", token, ""), http.StatusOK)
	decode[treehubv1.QueueItem](t, e.do("PUT", "/api/queue/other/repo/2147483647", token, ""), http.StatusOK)
	if keys := e.queueKeys(token); !sameStrings(keys, []string{"other/repo#2147483647", "octo-org/tools#1", "Octo-Org/tools#42"}) {
		t.Fatalf("queue = %v", keys)
	}
	wantOK(t, e.do("DELETE", "/api/queue/octo-org/tools/42", token, ""))
	wantOK(t, e.do("DELETE", "/api/queue/octo-org/tools/42", token, ""))
	wantError(t, e.do("POST", path+"/seen", token, ""), http.StatusNotFound, "not_found")
	if keys := e.queueKeys(token); !sameStrings(keys, []string{"other/repo#2147483647", "octo-org/tools#1"}) {
		t.Fatalf("queue after delete = %v", keys)
	}
	if keys := e.queueKeys(e.session("hubot", 2)); len(keys) != 0 {
		t.Fatalf("hubot sees %v", keys)
	}
}

func TestQueueValidation(t *testing.T) {
	e := newTestEnv(t, Config{})
	token := e.session("octocat", 1)

	for _, number := range []string{"0", "-1", "+1", "01", "1.5", "1e3", "abc", "2147483648", "99999999999"} {
		for _, req := range [][2]string{
			{"PUT", "/api/queue/octo/repo/" + number},
			{"DELETE", "/api/queue/octo/repo/" + number},
			{"POST", "/api/queue/octo/repo/" + number + "/seen"},
		} {
			wantError(t, e.do(req[0], req[1], token, ""), http.StatusBadRequest, "invalid_number")
		}
	}
	wantError(t, e.do("PUT", "/api/queue/octo_org/repo/1", token, ""), http.StatusBadRequest, "invalid_repo")
	wantError(t, e.do("POST", "/api/queue/octo/../1/seen", token, ""), http.StatusBadRequest, "invalid_repo")

	for _, body := range []string{"{", "[1]", `{"title":5}`, `"title"`} {
		wantError(t, e.do("PUT", "/api/queue/octo/repo/1", token, body), http.StatusBadRequest, "invalid_body")
	}
	req := httptest.NewRequest("PUT", "/api/queue/octo/repo/1", strings.NewReader(`{"title":"x"}`))
	req.Header.Set("Authorization", "Bearer "+token)
	req.Header.Set("Content-Type", "text/plain")
	rec := httptest.NewRecorder()
	e.h.ServeHTTP(rec, req)
	wantError(t, rec, http.StatusBadRequest, "invalid_body")

	if n := e.count("SELECT COUNT(*) FROM queue_items"); n != 0 {
		t.Fatalf("invalid requests stored %d rows", n)
	}
}

func TestQueueLimit(t *testing.T) {
	e := newTestEnv(t, Config{MaxQueueItems: 2})
	token := e.session("octocat", 1)
	decode[treehubv1.QueueItem](t, e.do("PUT", "/api/queue/a/b/1", token, ""), http.StatusOK)
	decode[treehubv1.QueueItem](t, e.do("PUT", "/api/queue/a/b/2", token, ""), http.StatusOK)
	wantError(t, e.do("PUT", "/api/queue/a/b/3", token, `{"title":"three"}`), http.StatusConflict, "limit_reached")
	// Updating a queued item is not a new row.
	if got := decode[treehubv1.QueueItem](t, e.do("PUT", "/api/queue/A/B/1", token, `{"title":"one"}`), http.StatusOK); got.GetTitle() != "one" {
		t.Fatalf("title = %q", got.GetTitle())
	}
	wantOK(t, e.do("DELETE", "/api/queue/a/b/2", token, ""))
	decode[treehubv1.QueueItem](t, e.do("PUT", "/api/queue/a/b/3", token, ""), http.StatusOK)
	if keys := e.queueKeys(token); !sameStrings(keys, []string{"a/b#3", "A/B#1"}) {
		t.Fatalf("queue = %v", keys)
	}
}
