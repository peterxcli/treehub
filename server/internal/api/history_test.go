package api

import (
	"context"
	"database/sql"
	"encoding/base64"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
	"unicode/utf8"

	"google.golang.org/protobuf/proto"

	treehubv1 "github.com/peterxcli/treehub/server/gen/go/treehub/v1"
	"github.com/peterxcli/treehub/server/internal/db"
)

// historyStart is where the history tests start the clock, so the expected
// timestamps can be spelled out.
var historyStart = time.Date(2026, 9, 30, 2, 30, 15, 123e6, time.UTC)

// newHistoryEnv starts the clock at historyStart and signs in as octocat.
func newHistoryEnv(t *testing.T, cfg Config) (*testEnv, string) {
	t.Helper()
	e := newTestEnv(t, cfg)
	e.now = historyStart
	return e, e.session("octocat", 1)
}

// view records a view: path is "repos/owner/name" or "pulls/owner/name/number".
func (e *testEnv) view(token, path, body string) *treehubv1.RecordViewResponse {
	e.t.Helper()
	return decode[treehubv1.RecordViewResponse](e.t, e.do("PUT", "/api/history/"+path, token, body), http.StatusOK)
}

func (e *testEnv) historyPage(token, query string) *treehubv1.ListHistoryResponse {
	e.t.Helper()
	return decode[treehubv1.ListHistoryResponse](e.t, e.do("GET", "/api/history"+query, token, ""), http.StatusOK)
}

func (e *testEnv) historySettings(token string) *treehubv1.HistorySettings {
	e.t.Helper()
	return decode[treehubv1.HistorySettings](e.t, e.do("GET", "/api/history/settings", token, ""), http.StatusOK)
}

func (e *testEnv) putHistorySettings(token, body string) *treehubv1.HistorySettings {
	e.t.Helper()
	return decode[treehubv1.HistorySettings](e.t, e.do("PUT", "/api/history/settings", token, body), http.StatusOK)
}

func wantItem(t *testing.T, res *treehubv1.RecordViewResponse, want *treehubv1.HistoryItem) {
	t.Helper()
	if res.Paused || !proto.Equal(res.Item, want) {
		t.Fatalf("recorded %v (paused %v), want %v", res.Item, res.Paused, want)
	}
}

func TestHistoryRecord(t *testing.T) {
	e, token := newHistoryEnv(t, Config{})
	if got := e.historyKeys(token); len(got) != 0 {
		t.Fatalf("new user has history: %v", got)
	}

	// A new row, stored as spelled; timestamps are RFC 3339 UTC with milliseconds.
	wantItem(t, e.view(token, "repos/Octo-Org/Tools", ""), &treehubv1.HistoryItem{
		Kind: "repo", Repo: "Octo-Org/Tools", ViewCount: 1,
		FirstViewedAt: "2026-09-30T02:30:15.123Z", LastViewedAt: "2026-09-30T02:30:15.123Z",
	})
	// Viewed again (case-insensitive): counted, last_viewed_at moves,
	// first_viewed_at stays, the repo takes the new spelling.
	e.now = e.now.Add(1500 * time.Millisecond)
	wantItem(t, e.view(token, "repos/octo-org/TOOLS", ""), &treehubv1.HistoryItem{
		Kind: "repo", Repo: "octo-org/TOOLS", ViewCount: 2,
		FirstViewedAt: "2026-09-30T02:30:15.123Z", LastViewedAt: "2026-09-30T02:30:16.623Z",
	})

	// A pull request, titled.
	e.now = e.now.Add(time.Millisecond)
	const pr = "pulls/octo-org/tools/42"
	title := "Fix the tree"
	wantItem(t, e.view(token, pr, `{"title":"  Fix the tree  "}`), &treehubv1.HistoryItem{
		Kind: "pull", Repo: "octo-org/tools", Number: 42, Title: &title, ViewCount: 1,
		FirstViewedAt: "2026-09-30T02:30:16.624Z", LastViewedAt: "2026-09-30T02:30:16.624Z",
	})
	// Without a title (no body, empty object, null, blank) the stored one stays.
	for i, body := range []string{"", "{}", `{"title":null}`, "  "} {
		e.now = e.now.Add(time.Millisecond)
		got := e.view(token, pr, body).Item
		if got.GetTitle() != "Fix the tree" || got.ViewCount != int32(i+2) ||
			got.FirstViewedAt != "2026-09-30T02:30:16.624Z" || got.LastViewedAt != historyTime(e.now) {
			t.Fatalf("body %q: item = %v", body, got)
		}
	}
	// A title replaces it, an empty one clears it, a long one is cut to 300
	// characters (not bytes).
	if got := e.view(token, pr, `{"title":"Fix the tree, take 2"}`).Item; got.GetTitle() != "Fix the tree, take 2" {
		t.Fatalf("title = %q", got.GetTitle())
	}
	if got := e.view(token, pr, `{"title":"   "}`).Item; got.Title != nil {
		t.Fatalf("title = %q", got.GetTitle())
	}
	long := strings.Repeat("é", 400)
	if got := e.view(token, pr, `{"title":"`+long+`"}`).Item; utf8.RuneCountInString(got.GetTitle()) != 300 || got.GetTitle() != long[:600] {
		t.Fatalf("title has %d characters", utf8.RuneCountInString(got.GetTitle()))
	}
	if n := e.count("SELECT COUNT(*) FROM history"); n != 2 {
		t.Fatalf("%d rows", n)
	}

	// Last viewed first; at the same time kind, repo (case-insensitive) and
	// number decide, all descending.
	e.now = e.now.Add(time.Second)
	for _, path := range []string{"pulls/a/b/9", "repos/a/b", "pulls/a/b/10", "pulls/A/c/2", "repos/octo-org/tools"} {
		e.view(token, path, "")
	}
	want := []string{"octo-org/tools", "a/b", "A/c#2", "a/b#10", "a/b#9", "octo-org/tools#42"}
	if got := e.historyKeys(token); !sameStrings(got, want) {
		t.Fatalf("history = %v, want %v", got, want)
	}

	// Other users see their own history only.
	if got := e.historyKeys(e.session("hubot", 2)); len(got) != 0 {
		t.Fatalf("hubot sees %v", got)
	}
}

// listedBefore is the listing order: last_viewed_at, kind, repo
// (case-insensitive) and number, all descending.
func listedBefore(a, b *treehubv1.HistoryItem) bool {
	if a.LastViewedAt != b.LastViewedAt {
		return a.LastViewedAt > b.LastViewedAt
	}
	if a.Kind != b.Kind {
		return a.Kind > b.Kind
	}
	if ra, rb := strings.ToLower(a.Repo), strings.ToLower(b.Repo); ra != rb {
		return ra > rb
	}
	return a.Number > b.Number
}

func TestHistoryPaging(t *testing.T) {
	e, token := newHistoryEnv(t, Config{})
	// 55 entries of both kinds in groups of four sharing a timestamp, so that
	// pages also end inside a group. Pull requests of one repository share
	// timestamps too, which leaves the number to order them.
	for i := 0; i < 55; i++ {
		if i%4 == 0 {
			e.now = e.now.Add(time.Millisecond)
		}
		path := fmt.Sprintf("pulls/octo/repo%d/%d", i%3, i+1)
		if i%5 == 0 {
			path = fmt.Sprintf("repos/octo/r%d", i)
		}
		e.view(token, path, "")
	}
	full := e.historyPage(token, "?limit=100")
	if len(full.Items) != 55 || full.NextCursor != nil {
		t.Fatalf("%d items, next_cursor %v", len(full.Items), full.NextCursor)
	}
	for i := 1; i < len(full.Items); i++ {
		if !listedBefore(full.Items[i-1], full.Items[i]) {
			t.Fatalf("out of order: %v before %v", full.Items[i-1], full.Items[i])
		}
	}
	all := historyItemKeys(t, full.Items)
	var pulls, repos []string
	for _, k := range all {
		if strings.Contains(k, "#") {
			pulls = append(pulls, k)
		} else {
			repos = append(repos, k)
		}
	}

	// walk follows next_cursor from the first page of query to the last.
	walk := func(query string, pageSize int) []string {
		t.Helper()
		var keys []string
		cursor := ""
		for pages := 1; ; pages++ {
			q := "?" + query
			if cursor != "" {
				q += "&cursor=" + cursor
			}
			res := e.historyPage(token, q)
			keys = append(keys, historyItemKeys(t, res.Items)...)
			if res.NextCursor == nil {
				if len(res.Items) == 0 && pages > 1 {
					t.Fatalf("%s: empty last page", query)
				}
				return keys
			}
			if len(res.Items) != pageSize || pages > 100 {
				t.Fatalf("%s: page %d has %d items and a next_cursor", query, pages, len(res.Items))
			}
			cursor = res.GetNextCursor()
		}
	}
	// No duplicates, no misses, same order as one big page, whatever the page
	// size; the last page never carries a cursor, even when it is full.
	for _, size := range []int{1, 2, 3, 4, 5, 7, 11, 54, 55, 100} {
		if got := walk(fmt.Sprintf("limit=%d", size), size); !sameStrings(got, all) {
			t.Fatalf("limit %d: %v\nwant %v", size, got, all)
		}
	}
	// 50 by default; empty parameters are absent ones.
	if got := walk("", 50); !sameStrings(got, all) {
		t.Fatalf("default page size: %v", got)
	}
	if res := e.historyPage(token, "?limit=&kind=&cursor="); len(res.Items) != 50 || res.NextCursor == nil {
		t.Fatalf("empty parameters: %d items, next_cursor %v", len(res.Items), res.NextCursor)
	}

	// The kind filter, paged too.
	if got := walk("kind=pull&limit=4", 4); !sameStrings(got, pulls) || len(pulls) != 44 {
		t.Fatalf("pulls = %v, want %v", got, pulls)
	}
	if got := walk("limit=4&kind=repo", 4); !sameStrings(got, repos) || len(repos) != 11 {
		t.Fatalf("repos = %v, want %v", got, repos)
	}

	// Views recorded between pages land before the cursor: the following
	// pages neither repeat nor lose rows.
	first := e.historyPage(token, "?limit=10")
	moved := pulls[len(pulls)-1] // on the last page until viewed again
	e.now = e.now.Add(time.Millisecond)
	e.view(token, "repos/octo/brand-new", "")
	e.view(token, "pulls/"+strings.Replace(moved, "#", "/", 1), "")
	var rest []string
	for cursor := first.GetNextCursor(); cursor != ""; {
		res := e.historyPage(token, "?limit=10&cursor="+cursor)
		rest = append(rest, historyItemKeys(t, res.Items)...)
		cursor = res.GetNextCursor()
	}
	var want []string
	for _, k := range all[10:] {
		if k != moved {
			want = append(want, k)
		}
	}
	if !sameStrings(rest, want) {
		t.Fatalf("pages after new views = %v\nwant %v", rest, want)
	}

	enc := func(s string) string { return base64.RawURLEncoding.EncodeToString([]byte(s)) }
	const at = "2026-09-30T02:30:15.123Z"
	for _, query := range []string{
		"limit=0", "limit=101", "limit=-1", "limit=abc", "limit=1.5", "limit=%2B5", "limit=05", "limit=1e2",
		"kind=issue", "kind=repos", "kind=REPO", "kind=pull,repo",
		"cursor=not*base64", "cursor=" + enc(at+" pull octo/repo 1") + "==",
		"cursor=" + base64.URLEncoding.EncodeToString([]byte(at+" pull octo/repo 1")),
		"cursor=" + enc(at+" pull octo/repo"),
		"cursor=" + enc(at+" pull octo/repo 1 x"),
		"cursor=" + enc(at+"  pull octo/repo 1"),
		"cursor=" + enc("2026-09-30T02:30:15Z pull octo/repo 1"),
		"cursor=" + enc("2026-09-30T2:30:15.123Z pull octo/repo 1"),
		"cursor=" + enc("2026-09-30T02:30:15.123+00:00 pull octo/repo 1"),
		"cursor=" + enc(at+" issue octo/repo 1"),
		"cursor=" + enc(at+" pull octo_org/repo 1"),
		"cursor=" + enc(at+" pull octo 1"),
		"cursor=" + enc(at+" pull octo/repo 0"),
		"cursor=" + enc(at+" pull octo/repo 01"),
		"cursor=" + enc(at+" pull octo/repo 2147483648"),
		"cursor=" + enc(at+" repo octo/repo 1"),
	} {
		wantError(t, e.do("GET", "/api/history?"+query, token, ""), http.StatusBadRequest, "invalid_request")
	}
	// A well-formed cursor is any position, even one no row has.
	if res := e.historyPage(token, "?cursor="+enc(at+" repo octo/repo 0")); len(res.Items) != 0 {
		t.Fatalf("rows before the first view: %v", res.Items)
	}
}

func TestHistoryRetention(t *testing.T) {
	e, token := newHistoryEnv(t, Config{})
	e.view(token, "repos/a/old", "")
	e.now = e.now.Add(10 * 24 * time.Hour)
	e.view(token, "repos/a/new", "")

	// The default retention keeps a row 30 days after its last view...
	e.now = historyStart.Add(30 * 24 * time.Hour)
	token = e.session("octocat", 1) // sessions last 30 days too
	if got := e.historyKeys(token); !sameStrings(got, []string{"a/new", "a/old"}) {
		t.Fatalf("history = %v", got)
	}
	// ...then the listing leaves it out, although only the next view deletes it.
	e.now = e.now.Add(time.Millisecond)
	if got := e.historyKeys(token); !sameStrings(got, []string{"a/new"}) {
		t.Fatalf("history = %v", got)
	}
	if res := e.historyPage(token, "?kind=repo"); len(res.Items) != 1 {
		t.Fatalf("kind=repo lists %d items", len(res.Items))
	}
	if n := e.count("SELECT COUNT(*) FROM history"); n != 2 {
		t.Fatalf("%d rows", n)
	}
	e.view(token, "pulls/a/new/1", "")
	if n := e.count("SELECT COUNT(*) FROM history WHERE repo = 'a/old'"); n != 0 {
		t.Fatal("a view did not prune the expired row")
	}

	// It counts from the last view: viewing a row again keeps it.
	e.now = e.now.Add(25 * 24 * time.Hour)
	e.view(token, "repos/a/new", "")
	e.now = e.now.Add(10 * 24 * time.Hour)
	token = e.session("octocat", 1)
	if got := e.historyKeys(token); !sameStrings(got, []string{"a/new"}) {
		t.Fatalf("history = %v", got)
	}
}

func TestHistorySettings(t *testing.T) {
	e, token := newHistoryEnv(t, Config{})
	if s := e.historySettings(token); s.RetentionDays != 30 || s.Paused {
		t.Fatalf("defaults = %v", s)
	}

	// retention_days is required (proto3 JSON omits zero values) and 1..365.
	for _, body := range []string{
		"", "{}", `{"paused":true}`, `{"retention_days":null}`, `{"retention_days":0}`, `{"retention_days":-1}`,
		`{"retention_days":366}`, `{"retention_days":2147483648}`, `{"retention_days":1.5}`, `{"retention_days":"30"}`,
		`{"retention_days":30,"paused":"true"}`, `{"retention_days":30,"paused":1}`, "[30]", "{",
	} {
		wantError(t, e.do("PUT", "/api/history/settings", token, body), http.StatusBadRequest, "invalid_body")
	}
	req := httptest.NewRequest("PUT", "/api/history/settings", strings.NewReader(`{"retention_days":7}`))
	req.Header.Set("Authorization", "Bearer "+token)
	req.Header.Set("Content-Type", "text/plain")
	rec := httptest.NewRecorder()
	e.h.ServeHTTP(rec, req)
	wantError(t, rec, http.StatusBadRequest, "invalid_body")
	if s := e.historySettings(token); s.RetentionDays != 30 || s.Paused {
		t.Fatalf("invalid requests changed the settings: %v", s)
	}

	// Stored and answered; a missing paused means false.
	if s := e.putHistorySettings(token, `{"retention_days":365,"paused":true}`); s.RetentionDays != 365 || !s.Paused {
		t.Fatalf("put = %v", s)
	}
	if s := e.historySettings(token); s.RetentionDays != 365 || !s.Paused {
		t.Fatalf("get = %v", s)
	}
	if s := e.putHistorySettings(token, `{"retention_days":1}`); s.RetentionDays != 1 || s.Paused {
		t.Fatalf("put = %v", s)
	}
	if s := e.historySettings(token); s.RetentionDays != 1 || s.Paused {
		t.Fatalf("get = %v", s)
	}
	if s := e.historySettings(e.session("hubot", 2)); s.RetentionDays != 30 || s.Paused {
		t.Fatalf("hubot's settings = %v", s)
	}

	// A shorter retention deletes what it no longer keeps at once; a longer
	// one does not bring it back.
	e.putHistorySettings(token, `{"retention_days":30}`)
	e.view(token, "repos/a/old", "")
	e.now = e.now.Add(8 * 24 * time.Hour)
	e.view(token, "repos/a/recent", "")
	if n := e.count("SELECT COUNT(*) FROM history"); n != 2 {
		t.Fatalf("%d rows", n)
	}
	e.putHistorySettings(token, `{"retention_days":7}`)
	if n := e.count("SELECT COUNT(*) FROM history"); n != 1 {
		t.Fatalf("%d rows after shortening the retention", n)
	}
	e.putHistorySettings(token, `{"retention_days":30}`)
	if got := e.historyKeys(token); !sameStrings(got, []string{"a/recent"}) {
		t.Fatalf("history = %v", got)
	}
}

func TestHistoryPaused(t *testing.T) {
	e, token := newHistoryEnv(t, Config{})
	e.view(token, "pulls/a/b/1", `{"title":"One"}`)
	e.putHistorySettings(token, `{"retention_days":30,"paused":true}`)

	// Nothing is recorded, not even for a known row.
	e.now = e.now.Add(time.Second)
	for _, req := range [][2]string{{"repos/a/b", ""}, {"pulls/a/b/2", `{"title":"Two"}`}, {"pulls/a/b/1", `{"title":"Changed"}`}} {
		rec := e.do("PUT", "/api/history/"+req[0], token, req[1])
		if res := decode[treehubv1.RecordViewResponse](t, rec, http.StatusOK); !res.Paused || res.Item != nil {
			t.Fatalf("%s: %s", req[0], rec.Body)
		}
	}
	res := e.historyPage(token, "")
	if len(res.Items) != 1 || res.Items[0].GetTitle() != "One" || res.Items[0].ViewCount != 1 ||
		res.Items[0].LastViewedAt != "2026-09-30T02:30:15.123Z" {
		t.Fatalf("history = %v", res.Items)
	}
	// Requests are still validated; listing and deleting still work.
	wantError(t, e.do("PUT", "/api/history/pulls/a/b/0", token, ""), http.StatusBadRequest, "invalid_number")
	wantOK(t, e.do("DELETE", "/api/history/pulls/a/b/1", token, ""))
	// Pausing is per user.
	if res := e.view(e.session("hubot", 2), "repos/a/b", ""); res.Paused || res.Item == nil {
		t.Fatalf("hubot: %v", res)
	}

	// Resumed.
	e.putHistorySettings(token, `{"retention_days":30}`)
	if res := e.view(token, "pulls/a/b/2", ""); res.Paused || res.Item.GetViewCount() != 1 {
		t.Fatalf("after resuming: %v", res)
	}
	if got := e.historyKeys(token); !sameStrings(got, []string{"a/b#2"}) {
		t.Fatalf("history = %v", got)
	}
}

func TestHistoryCap(t *testing.T) {
	e, token := newHistoryEnv(t, Config{MaxHistoryItems: 3})
	view := func(token, path string) {
		t.Helper()
		e.now = e.now.Add(time.Second)
		if res := e.view(token, path, ""); res.Item == nil { // never refused
			t.Fatalf("%s: %v", path, res)
		}
	}
	view(token, "repos/a/one")
	view(token, "repos/a/two")
	view(token, "repos/a/three")
	// Viewing a known row adds none: nothing goes.
	view(token, "repos/a/one")
	if got := e.historyKeys(token); !sameStrings(got, []string{"a/one", "a/three", "a/two"}) {
		t.Fatalf("history = %v", got)
	}
	// A new row pushes out the least recently viewed one.
	view(token, "pulls/a/one/1")
	if got := e.historyKeys(token); !sameStrings(got, []string{"a/one#1", "a/one", "a/three"}) {
		t.Fatalf("history = %v", got)
	}
	// Rows over a lowered cap go with the next new row.
	e.srv.Cfg.MaxHistoryItems = 1
	view(token, "repos/a/three")
	if n := e.count("SELECT COUNT(*) FROM history"); n != 3 {
		t.Fatalf("%d rows", n)
	}
	view(token, "repos/a/four")
	if got := e.historyKeys(token); !sameStrings(got, []string{"a/four"}) {
		t.Fatalf("history = %v", got)
	}
	// The cap is per user.
	e.srv.Cfg.MaxHistoryItems = 2
	other := e.session("hubot", 2)
	view(other, "repos/a/x")
	view(other, "repos/a/y")
	if got := e.historyKeys(token); !sameStrings(got, []string{"a/four"}) {
		t.Fatalf("octocat's history = %v", got)
	}
	if got := e.historyKeys(other); !sameStrings(got, []string{"a/y", "a/x"}) {
		t.Fatalf("hubot's history = %v", got)
	}
}

func TestHistoryDelete(t *testing.T) {
	e, token := newHistoryEnv(t, Config{})
	other := e.session("hubot", 2)
	for _, path := range []string{"repos/octo-org/tools", "pulls/octo-org/tools/7", "pulls/octo-org/tools/8"} {
		e.now = e.now.Add(time.Second)
		e.view(token, path, "")
	}
	e.view(other, "repos/octo-org/tools", "")

	// One entry (case-insensitive, idempotent); the repository's pull requests stay.
	wantOK(t, e.do("DELETE", "/api/history/repos/OCTO-ORG/TOOLS", token, ""))
	wantOK(t, e.do("DELETE", "/api/history/repos/octo-org/tools", token, ""))
	if got := e.historyKeys(token); !sameStrings(got, []string{"octo-org/tools#8", "octo-org/tools#7"}) {
		t.Fatalf("history = %v", got)
	}
	wantOK(t, e.do("DELETE", "/api/history/pulls/octo-org/tools/8", token, ""))
	wantOK(t, e.do("DELETE", "/api/history/pulls/never/viewed/1", token, ""))
	if got := e.historyKeys(token); !sameStrings(got, []string{"octo-org/tools#7"}) {
		t.Fatalf("history = %v", got)
	}

	// Clearing removes the rest of the user's own history, and keeps the settings.
	e.putHistorySettings(token, `{"retention_days":90}`)
	wantOK(t, e.do("DELETE", "/api/history", token, ""))
	wantOK(t, e.do("DELETE", "/api/history", token, ""))
	if got := e.historyKeys(token); len(got) != 0 {
		t.Fatalf("history after clearing = %v", got)
	}
	if s := e.historySettings(token); s.RetentionDays != 90 {
		t.Fatalf("settings after clearing = %v", s)
	}
	if got := e.historyKeys(other); !sameStrings(got, []string{"octo-org/tools"}) {
		t.Fatalf("hubot's history = %v", got)
	}
}

func TestHistoryValidation(t *testing.T) {
	e, token := newHistoryEnv(t, Config{})

	for _, method := range []string{"PUT", "DELETE"} {
		for _, repo := range []string{"-octo/repo", "octo_org/repo", strings.Repeat("a", 40) + "/repo", "octo/..", "octo/re%20po", "%C3%A9/repo"} {
			wantError(t, e.do(method, "/api/history/repos/"+repo, token, ""), http.StatusBadRequest, "invalid_repo")
			wantError(t, e.do(method, "/api/history/pulls/"+repo+"/1", token, ""), http.StatusBadRequest, "invalid_repo")
		}
		for _, number := range []string{"0", "-1", "+1", "01", "1.5", "abc", "2147483648"} {
			wantError(t, e.do(method, "/api/history/pulls/octo/repo/"+number, token, ""), http.StatusBadRequest, "invalid_number")
		}
	}
	for _, body := range []string{"{", "[1]", `{"title":5}`, `"title"`} {
		wantError(t, e.do("PUT", "/api/history/repos/octo/repo", token, body), http.StatusBadRequest, "invalid_body")
		wantError(t, e.do("PUT", "/api/history/pulls/octo/repo/1", token, body), http.StatusBadRequest, "invalid_body")
	}
	req := httptest.NewRequest("PUT", "/api/history/pulls/octo/repo/1", strings.NewReader(`{"title":"x"}`))
	req.Header.Set("Authorization", "Bearer "+token)
	req.Header.Set("Content-Type", "text/plain")
	rec := httptest.NewRecorder()
	e.h.ServeHTTP(rec, req)
	wantError(t, rec, http.StatusBadRequest, "invalid_body")
	if n := e.count("SELECT COUNT(*) FROM history"); n != 0 {
		t.Fatalf("invalid requests stored %d rows", n)
	}

	wantError(t, e.do("GET", "/api/history/repos/octo/repo", token, ""), http.StatusMethodNotAllowed, "method_not_allowed")
	wantError(t, e.do("POST", "/api/history", token, ""), http.StatusMethodNotAllowed, "method_not_allowed")
	wantError(t, e.do("DELETE", "/api/history/settings", token, ""), http.StatusMethodNotAllowed, "method_not_allowed")
	wantError(t, e.do("PUT", "/api/history/pulls/octo/repo", token, ""), http.StatusNotFound, "not_found")
	wantError(t, e.do("PUT", "/api/history/issues/octo/repo/1", token, ""), http.StatusNotFound, "not_found")

	for _, req := range [][2]string{
		{"GET", "/api/history"}, {"DELETE", "/api/history"},
		{"GET", "/api/history/settings"}, {"PUT", "/api/history/settings"},
		{"PUT", "/api/history/repos/octo/repo"}, {"DELETE", "/api/history/repos/octo/repo"},
		{"PUT", "/api/history/pulls/octo/repo/1"}, {"DELETE", "/api/history/pulls/octo/repo/1"},
	} {
		wantError(t, e.do(req[0], req[1], "", ""), http.StatusUnauthorized, "login_required")
	}
}

// queryLog is the test database as sqlc's DBTX, recording the statements the
// handlers run so that their plans can be checked.
type queryLog struct {
	*sql.DB
	queries []loggedQuery
}

type loggedQuery struct {
	sql  string
	args []any
}

func (l *queryLog) QueryContext(ctx context.Context, query string, args ...any) (*sql.Rows, error) {
	l.queries = append(l.queries, loggedQuery{query, args})
	return l.DB.QueryContext(ctx, query, args...)
}

func (l *queryLog) ExecContext(ctx context.Context, query string, args ...any) (sql.Result, error) {
	l.queries = append(l.queries, loggedQuery{query, args})
	return l.DB.ExecContext(ctx, query, args...)
}

// plan explains the last logged run of the sqlc query called name.
func (e *testEnv) plan(sqlLog *queryLog, name string) string {
	e.t.Helper()
	for i := len(sqlLog.queries) - 1; i >= 0; i-- {
		q := sqlLog.queries[i]
		if !strings.HasPrefix(q.sql, "-- name: "+name+" ") {
			continue
		}
		rows, err := e.db.Query("EXPLAIN QUERY PLAN "+q.sql, q.args...)
		if err != nil {
			e.t.Fatal(err)
		}
		defer rows.Close()
		var lines []string
		for rows.Next() {
			var id, parent, notUsed int
			var detail string
			if err := rows.Scan(&id, &parent, &notUsed, &detail); err != nil {
				e.t.Fatal(err)
			}
			lines = append(lines, detail)
		}
		if err := rows.Err(); err != nil {
			e.t.Fatal(err)
		}
		return strings.Join(lines, "\n")
	}
	e.t.Fatalf("%s did not run", name)
	return ""
}

func TestHistoryQueryPlans(t *testing.T) {
	e, token := newHistoryEnv(t, Config{})
	for i := 1; i <= 3; i++ {
		e.now = e.now.Add(time.Millisecond)
		e.view(token, fmt.Sprintf("pulls/octo/repo/%d", i), "")
	}
	cursor := e.historyPage(token, "?limit=1").GetNextCursor()
	sqlLog := &queryLog{DB: e.db}
	e.srv.Q = db.New(sqlLog)

	// Every listing reads history_recent in order: the ORDER BY needs no
	// temporary B-tree, and a cursor is a seek on all four columns.
	for _, query := range []string{"?limit=1", "?kind=pull", "?limit=1&cursor=" + cursor, "?kind=repo&cursor=" + cursor} {
		sqlLog.queries = nil
		e.historyPage(token, query)
		name, want := "ListHistory", "INDEX history_recent (login=? AND last_viewed_at>?)"
		if strings.Contains(query, "cursor=") {
			name, want = "ListHistoryAfter", "INDEX history_recent (login=? AND last_viewed_at>? AND (last_viewed_at,kind,repo,number)<(?,?,?,?))"
		}
		plan := e.plan(sqlLog, name)
		t.Logf("%s: %s", query, plan)
		if !strings.Contains(plan, want) || strings.Contains(plan, "TEMP B-TREE") {
			t.Errorf("%s: plan:\n%s\nwant %s and no temporary B-tree", query, plan, want)
		}
	}

	// So do the statements every new view runs.
	sqlLog.queries = nil
	e.view(token, "repos/octo/repo", "")
	for name, want := range map[string]string{
		"PruneHistory": "INDEX history_recent (login=? AND last_viewed_at<?)",
		"TrimHistory":  "INDEX history_recent (login=?)",
	} {
		plan := e.plan(sqlLog, name)
		t.Logf("%s: %s", name, plan)
		if !strings.Contains(plan, want) || strings.Contains(plan, "TEMP B-TREE") {
			t.Errorf("%s: plan:\n%s\nwant %s and no temporary B-tree", name, plan, want)
		}
	}
}
