package api

import (
	"net/http"
	"net/url"
	"sort"
	"strconv"
	"strings"
	"testing"

	treehubv1 "github.com/peterxcli/treehub/server/gen/go/treehub/v1"
)

func TestNotes(t *testing.T) {
	e := newTestEnv(t, Config{})
	token := e.session("octocat", 1)
	bookmark := func(body string) *treehubv1.Bookmark {
		t.Helper()
		return decode[treehubv1.Bookmark](t, e.do("PUT", "/api/bookmarks/apache/ratis", token, body), http.StatusOK)
	}

	// A bookmark keeps its note when saved without one; an empty note removes it
	if b := bookmark(`{"note":"  Raft library  "}`); b.GetNote() != "Raft library" {
		t.Fatalf("note = %q", b.GetNote())
	}
	for _, body := range []string{"", "{}", `{"note":null}`} {
		if b := bookmark(body); b.GetNote() != "Raft library" {
			t.Fatalf("body %q: note = %q", body, b.GetNote())
		}
	}
	list := decode[treehubv1.ListBookmarksResponse](t, e.do("GET", "/api/bookmarks", token, ""), http.StatusOK)
	if len(list.Bookmarks) != 1 || list.Bookmarks[0].GetNote() != "Raft library" {
		t.Fatalf("bookmarks = %+v", list.Bookmarks)
	}
	if b := bookmark(`{"note":"   "}`); b.Note != nil {
		t.Fatalf("note = %q", b.GetNote())
	}
	wantError(t, e.do("PUT", "/api/bookmarks/apache/ratis", token, `{"note":"`+strings.Repeat("é", 2001)+`"}`),
		http.StatusBadRequest, "invalid_note")
	if b := bookmark(`{"note":"` + strings.Repeat("é", 2000) + `"}`); len([]rune(b.GetNote())) != 2000 {
		t.Fatalf("note of %d characters", len([]rune(b.GetNote())))
	}

	// A queued pull request: its title and note change independently
	path := "/api/queue/apache/ozone/11302"
	item := func(body string) *treehubv1.QueueItem {
		t.Helper()
		return decode[treehubv1.QueueItem](t, e.do("PUT", path, token, body), http.StatusOK)
	}
	if q := item(`{"title":"Refactor reads","note":"Check checksums"}`); q.GetTitle() != "Refactor reads" || q.GetNote() != "Check checksums" {
		t.Fatalf("item = %+v", q)
	}
	if q := item(`{"title":"Refactor streaming reads"}`); q.GetNote() != "Check checksums" {
		t.Fatalf("item = %+v", q)
	}
	if q := item(`{"note":"Look again"}`); q.GetTitle() != "Refactor streaming reads" || q.GetNote() != "Look again" {
		t.Fatalf("item = %+v", q)
	}
	seen := decode[treehubv1.QueueItem](t, e.do("POST", path+"/seen", token, ""), http.StatusOK)
	if seen.GetNote() != "Look again" || seen.GetTitle() != "Refactor streaming reads" {
		t.Fatalf("seen = %+v", seen)
	}
	queue := decode[treehubv1.ListQueueResponse](t, e.do("GET", "/api/queue", token, ""), http.StatusOK)
	if len(queue.Items) != 1 || queue.Items[0].GetNote() != "Look again" {
		t.Fatalf("queue = %+v", queue.Items)
	}

	// PATCH changes a queued pull request the same way, and only a queued one
	patch := func(body string) *treehubv1.QueueItem {
		t.Helper()
		return decode[treehubv1.QueueItem](t, e.do("PATCH", path, token, body), http.StatusOK)
	}
	if q := patch(`{"title":"  Refactor block reads  "}`); q.GetTitle() != "Refactor block reads" || q.GetNote() != "Look again" {
		t.Fatalf("patched = %+v", q)
	}
	if q := patch(`{"note":""}`); q.Note != nil || q.GetTitle() != "Refactor block reads" {
		t.Fatalf("patched = %+v", q)
	}
	if q := patch(""); q.GetTitle() != "Refactor block reads" || q.LastSeenAt == nil {
		t.Fatalf("patched = %+v", q)
	}
	wantError(t, e.do("PATCH", path, token, `{"note":"`+strings.Repeat("x", 2001)+`"}`), http.StatusBadRequest, "invalid_note")
	wantOK(t, e.do("DELETE", path, token, ""))
	wantError(t, e.do("PATCH", path, token, `{"title":"Back?"}`), http.StatusNotFound, "not_found")
	if n := e.count("SELECT COUNT(*) FROM queue_items"); n != 0 {
		t.Fatalf("PATCH queued it again: %d items", n)
	}
	wantError(t, e.do("PATCH", path, "", `{"title":"x"}`), http.StatusUnauthorized, "login_required")
}

func TestSearch(t *testing.T) {
	e := newTestEnv(t, Config{})
	token := e.session("octocat", 1)
	put := func(path, body string) {
		t.Helper()
		if rec := e.do("PUT", path, token, body); rec.Code != http.StatusOK {
			t.Fatalf("PUT %s: %d %s", path, rec.Code, rec.Body)
		}
	}
	put("/api/queue/apache/ozone/11302", `{"title":"Refactor streaming block reads","note":"Check the checksum verification before merging"}`)
	put("/api/queue/apache/ozone/11314", `{"title":"Add lock-free StreamBlock pread"}`)
	put("/api/bookmarks/apache/ratis", `{"note":"Raft library, 這個需要再看一次"}`)
	put("/api/bookmarks/apache/checksum-tools", "")
	search := func(token, q string) []*treehubv1.SearchResult {
		t.Helper()
		res := decode[treehubv1.SearchResponse](t, e.do("GET", "/api/search?q="+url.QueryEscape(q), token, ""), http.StatusOK)
		return res.Results
	}
	keys := func(results []*treehubv1.SearchResult) string {
		var k []string
		for _, r := range results {
			if r.Number != 0 {
				k = append(k, r.Kind+":"+r.Repo+"#"+strconv.Itoa(int(r.Number)))
			} else {
				k = append(k, r.Kind+":"+r.Repo)
			}
		}
		return strings.Join(k, " ")
	}

	// In a note, a title, a repository: the note counts most
	r := search(token, "checksum")
	if keys(r) != "queue:apache/ozone#11302 bookmark:apache/checksum-tools" {
		t.Fatalf("checksum: %s", keys(r))
	}
	if !strings.Contains(r[0].GetNoteMatch(), "\x02checksum\x03") || r[0].GetTitleMatch() != "Refactor streaming block reads" ||
		r[1].RepoMatch != "apache/\x02checksum\x03-tools" || r[1].TitleMatch != nil || r[1].NoteMatch != nil {
		t.Fatalf("matches: %+v / %+v", r[0], r[1])
	}
	// Other forms of the words (stemming), the start of the last one (searching while typing), all of them (in any
	// order here)
	sorted := func(k string) string {
		parts := strings.Fields(k)
		sort.Strings(parts)
		return strings.Join(parts, " ")
	}
	for q, want := range map[string]string{
		"checksums":            "queue:apache/ozone#11302 bookmark:apache/checksum-tools",
		"verif":                "queue:apache/ozone#11302",
		"stream":               "queue:apache/ozone#11302 queue:apache/ozone#11314",
		"streaming refactor":   "queue:apache/ozone#11302",
		"streaming lock":       "",
		"lock-free":            "queue:apache/ozone#11314",
		"apache/ratis":         "bookmark:apache/ratis",
		"RAFT":                 "bookmark:apache/ratis",
		"需要":                   "bookmark:apache/ratis",
		"再看":                   "bookmark:apache/ratis",
		"看再":                   "",
		"library 一次":           "bookmark:apache/ratis",
		"":                     "",
		"  !!! ":               "",
		`"`:                    "",
		`"checksum`:            "queue:apache/ozone#11302 bookmark:apache/checksum-tools",
		"NOT":                  "",
		"checksum OR":          "",
		"note:checksum":        "",
		"-checksum":            "queue:apache/ozone#11302 bookmark:apache/checksum-tools",
		"^checksum (verif":     "queue:apache/ozone#11302",
		"checksum*":            "queue:apache/ozone#11302 bookmark:apache/checksum-tools",
		"NEAR(checksum merge)": "",
	} {
		if got := keys(search(token, q)); sorted(got) != sorted(want) {
			t.Errorf("%q: %q, want %q", q, got, want)
		}
	}
	if m := search(token, "需要")[0].GetNoteMatch(); strings.Contains(m, zeroWidthSpace) || !strings.Contains(m, "\x02") ||
		strings.ReplaceAll(strings.ReplaceAll(m, "\x02", ""), "\x03", "") != "Raft library, 這個需要再看一次" {
		t.Fatalf("note match = %q", m)
	}

	// Another user doesn't find them
	if got := search(e.session("monalisa", 2), "checksum"); len(got) != 0 {
		t.Fatalf("monalisa: %s", keys(got))
	}
	// A renamed GitHub account keeps its search
	renamed := e.session("octocat-renamed", 1)
	if got := keys(search(renamed, "raft")); got != "bookmark:apache/ratis" {
		t.Fatalf("renamed: %q", got)
	}
	// Changes and removals show at once
	put("/api/queue/apache/ozone/11314", `{"note":"Benchmark the checksum path"}`)
	if got := keys(search(renamed, "checksum")); !strings.Contains(got, "11314") {
		t.Fatalf("after a note: %q", got)
	}
	if rec := e.do("PATCH", "/api/queue/apache/ozone/11314", renamed, `{"title":"Positional reads without locks"}`); rec.Code != http.StatusOK {
		t.Fatalf("PATCH: %d %s", rec.Code, rec.Body)
	}
	if got := keys(search(renamed, "positional")); got != "queue:apache/ozone#11314" {
		t.Fatalf("after a new title: %q", got)
	}
	if got := keys(search(renamed, "StreamBlock")); got != "" {
		t.Fatalf("the old title: %q", got)
	}
	wantOK(t, e.do("DELETE", "/api/queue/apache/ozone/11302", renamed, ""))
	if got := keys(search(renamed, "verification")); got != "" {
		t.Fatalf("after removing: %q", got)
	}
	// Deleting the account empties its part of the index
	wantOK(t, e.do("DELETE", "/api/me", renamed, ""))
	if n := e.count("SELECT COUNT(*) FROM search_keys"); n != 0 {
		t.Fatalf("%d keys left", n)
	}
	if n := e.count("SELECT COUNT(*) FROM search_index"); n != 0 {
		t.Fatalf("%d rows left in the index", n)
	}

	wantError(t, e.do("GET", "/api/search?q=raft", renamed, ""), http.StatusUnauthorized, "login_required")
	other := e.session("hubot", 3)
	wantError(t, e.do("GET", "/api/search?q=x&limit=51", other, ""), http.StatusBadRequest, "invalid_request")
	wantError(t, e.do("GET", "/api/search?q="+strings.Repeat("x", 201), other, ""), http.StatusBadRequest, "invalid_request")
	wantError(t, e.do("GET", "/api/search?q=x", "", ""), http.StatusUnauthorized, "login_required")
}

func TestFTSQuery(t *testing.T) {
	for in, want := range map[string]string{
		"checksum":        `"checksum"*`,
		"check the sum":   `"check" "the" "sum"*`,
		`say "hi"`:        `"say" """hi"""*`,
		"需要":              "\"​需​​要​\"*",
		"PR需要":            "\"PR​需​​要​\"*",
		"  -- !! ":        "",
		"a-b":             `"a-b"*`,
		"OR NOT":          `"OR" "NOT"*`,
		"column:value ^x": `"column:value" "^x"*`,
	} {
		if got := ftsQuery(in); got != want {
			t.Errorf("ftsQuery(%q) = %q, want %q", in, got, want)
		}
	}
}
