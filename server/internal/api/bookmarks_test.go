package api

import (
	"net/http"
	"strings"
	"testing"
	"time"

	treehubv1 "github.com/peterxcli/treehub/server/gen/go/treehub/v1"
)

func TestBookmarks(t *testing.T) {
	e := newTestEnv(t, Config{})
	token := e.session("octocat", 1)
	if got := e.bookmarkRepos(token); len(got) != 0 {
		t.Fatalf("new user has bookmarks: %v", got)
	}

	// Stored as given.
	b := decode[treehubv1.Bookmark](t, e.do("PUT", "/api/bookmarks/Octo-Org/Hello.World", token, ""), http.StatusOK)
	if b.Repo != "Octo-Org/Hello.World" {
		t.Fatalf("repo = %q", b.Repo)
	}
	if _, err := time.Parse(time.RFC3339, b.CreatedAt); err != nil {
		t.Fatalf("created_at = %q", b.CreatedAt)
	}

	// Idempotent, keeps the original created_at, case-insensitive.
	e.exec("UPDATE bookmarks SET created_at = '2020-01-02T03:04:05Z'")
	for _, path := range []string{"/api/bookmarks/Octo-Org/Hello.World", "/api/bookmarks/octo-org/hello.world"} {
		again := decode[treehubv1.Bookmark](t, e.do("PUT", path, token, ""), http.StatusOK)
		if again.CreatedAt != "2020-01-02T03:04:05Z" {
			t.Fatalf("created_at changed to %q", again.CreatedAt)
		}
	}
	if got := e.bookmarkRepos(token); !sameStrings(got, []string{"octo-org/hello.world"}) {
		t.Fatalf("bookmarks = %v", got)
	}

	// Newest first; rows created in the same second keep insertion order.
	decode[treehubv1.Bookmark](t, e.do("PUT", "/api/bookmarks/a/one", token, ""), http.StatusOK)
	decode[treehubv1.Bookmark](t, e.do("PUT", "/api/bookmarks/a/two", token, ""), http.StatusOK)
	if got := e.bookmarkRepos(token); !sameStrings(got, []string{"a/two", "a/one", "octo-org/hello.world"}) {
		t.Fatalf("order = %v", got)
	}

	// Other users see their own list only.
	other := e.session("hubot", 2)
	if got := e.bookmarkRepos(other); len(got) != 0 {
		t.Fatalf("hubot sees %v", got)
	}
	wantOK(t, e.do("DELETE", "/api/bookmarks/a/one", other, ""))

	// Delete is idempotent and case-insensitive.
	wantOK(t, e.do("DELETE", "/api/bookmarks/OCTO-ORG/HELLO.WORLD", token, ""))
	wantOK(t, e.do("DELETE", "/api/bookmarks/octo-org/hello.world", token, ""))
	wantOK(t, e.do("DELETE", "/api/bookmarks/never/saved", token, ""))
	if got := e.bookmarkRepos(token); !sameStrings(got, []string{"a/two", "a/one"}) {
		t.Fatalf("after delete = %v", got)
	}
}

func TestBookmarkValidation(t *testing.T) {
	e := newTestEnv(t, Config{})
	token := e.session("octocat", 1)

	for _, repo := range []string{
		"-octo/repo", "octo_org/repo", "octo.org/repo", strings.Repeat("a", 40) + "/repo",
		"octo/.", "octo/..", "octo/re%20po", "octo/re$po", "octo/" + strings.Repeat("r", 101), "%C3%A9/repo",
	} {
		wantError(t, e.do("PUT", "/api/bookmarks/"+repo, token, ""), http.StatusBadRequest, "invalid_repo")
		wantError(t, e.do("DELETE", "/api/bookmarks/"+repo, token, ""), http.StatusBadRequest, "invalid_repo")
	}
	for _, repo := range []string{
		"a/b", "octo-/x", "0/1", strings.Repeat("a", 39) + "/" + strings.Repeat("r", 100),
		"octo/.github", "octo/a..b", "octo/_-.", "octo/...",
	} {
		decode[treehubv1.Bookmark](t, e.do("PUT", "/api/bookmarks/"+repo, token, ""), http.StatusOK)
	}
}

func TestBookmarkLimit(t *testing.T) {
	e := newTestEnv(t, Config{MaxBookmarks: 2})
	token := e.session("octocat", 1)
	decode[treehubv1.Bookmark](t, e.do("PUT", "/api/bookmarks/a/one", token, ""), http.StatusOK)
	decode[treehubv1.Bookmark](t, e.do("PUT", "/api/bookmarks/a/two", token, ""), http.StatusOK)
	wantError(t, e.do("PUT", "/api/bookmarks/a/three", token, ""), http.StatusConflict, "limit_reached")
	// Re-saving an existing bookmark is not a new row.
	decode[treehubv1.Bookmark](t, e.do("PUT", "/api/bookmarks/A/One", token, ""), http.StatusOK)
	// The limit is per user.
	decode[treehubv1.Bookmark](t, e.do("PUT", "/api/bookmarks/a/three", e.session("hubot", 2), ""), http.StatusOK)

	wantOK(t, e.do("DELETE", "/api/bookmarks/a/one", token, ""))
	decode[treehubv1.Bookmark](t, e.do("PUT", "/api/bookmarks/a/three", token, ""), http.StatusOK)
	if got := e.bookmarkRepos(token); !sameStrings(got, []string{"a/three", "a/two"}) {
		t.Fatalf("bookmarks = %v", got)
	}
}
