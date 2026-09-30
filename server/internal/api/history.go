package api

import (
	"context"
	"encoding/base64"
	"errors"
	"fmt"
	"net/http"
	"strconv"
	"strings"
	"time"

	treehubv1 "github.com/peterxcli/treehub/server/gen/go/treehub/v1"
	"github.com/peterxcli/treehub/server/internal/db"
)

// The history remembers which repositories and pull requests the user viewed
// on GitHub (first and last time, how often) for the user's retention, counted
// from the last view. The extension records the views while signed in.

// Kinds of entries as stored and returned (the paths say "repos" and "pulls").
const (
	historyRepo = "repo"
	historyPull = "pull"
)

const (
	defaultHistoryPageSize = 50
	maxHistoryPageSize     = 100
	maxHistoryRetention    = 365 // days
)

// historyTimeLayout is RFC 3339 in UTC with milliseconds. The fixed width makes
// the timestamps sort chronologically as text, which the listing order, its
// cursor and the retention rely on.
const historyTimeLayout = "2006-01-02T15:04:05.000Z"

func historyTime(t time.Time) string {
	return t.UTC().Format(historyTimeLayout)
}

// retentionStart is the oldest last view the user's retention keeps.
func retentionStart(u *db.User, now time.Time) string {
	return historyTime(now.Add(-time.Duration(u.HistoryRetentionDays) * 24 * time.Hour))
}

// pruneHistory deletes the rows past the user's retention.
func (s *Server) pruneHistory(ctx context.Context, u *db.User, now time.Time) error {
	return s.Q.PruneHistory(ctx, db.PruneHistoryParams{Login: u.Login, Before: retentionStart(u, now)})
}

// historyKey reads the entry from the path: owner/name, and for a pull request
// its number (0 for a repository).
func historyKey(r *http.Request, kind string) (repo string, number int64, err error) {
	if kind == historyPull {
		return queueKey(r) // owner/name/number, as for the queue
	}
	repo, err = repoParam(r)
	return repo, 0, err
}

// recordView handles PUT /api/history/{repos,pulls}/...: the user viewed the
// repository or pull request now. A title in the body replaces the stored one;
// a bare PUT keeps it. Nothing is stored while the history is paused.
func (s *Server) recordView(kind string) func(*http.Request) (any, error) {
	return func(r *http.Request) (any, error) {
		u := userFrom(r.Context())
		repo, number, err := historyKey(r, kind)
		if err != nil {
			return nil, err
		}
		var body treehubv1.RecordViewRequest
		if err := readJSON(r, &body); err != nil {
			return nil, badRequest("invalid_body", err)
		}
		if u.HistoryPaused != 0 {
			return &treehubv1.RecordViewResponse{Paused: true}, nil
		}
		ctx, now := r.Context(), s.now()
		var row db.History
		if body.Title != nil {
			row, err = s.Q.RecordViewWithTitle(ctx, db.RecordViewWithTitleParams{
				Login: u.Login, Kind: kind, Repo: repo, Number: number, Title: normalizeTitle(*body.Title), ViewedAt: historyTime(now),
			})
		} else {
			row, err = s.Q.RecordView(ctx, db.RecordViewParams{
				Login: u.Login, Kind: kind, Repo: repo, Number: number, ViewedAt: historyTime(now),
			})
		}
		if err != nil {
			return nil, err
		}
		if err := s.pruneHistory(ctx, u, now); err != nil {
			return nil, err
		}
		// Only a new row (view_count 1; a repeated view counts at least 2) can
		// take the history past its cap. The oldest rows make room rather than
		// the view being refused. Trimming reads up to the cap, hence not on
		// every view.
		if row.ViewCount == 1 {
			if err := s.Q.TrimHistory(ctx, db.TrimHistoryParams{Login: u.Login, MaxRows: s.Cfg.maxHistoryItems()}); err != nil {
				return nil, err
			}
		}
		return &treehubv1.RecordViewResponse{Item: historyItemProto(row)}, nil
	}
}

// listHistory handles GET /api/history?limit=&cursor=&kind=: one page, last
// viewed first. Paging is by keyset: next_cursor is the position of the page's
// last row and the next page starts after it, so views recorded meanwhile land
// before it and never repeat rows on the following pages.
func (s *Server) listHistory(r *http.Request) (any, error) {
	u := userFrom(r.Context())
	q := r.URL.Query()
	pageSize := int64(defaultHistoryPageSize)
	if v := q.Get("limit"); v != "" {
		n, ok := parsePositive(v)
		if !ok || n > maxHistoryPageSize {
			return nil, badRequest("invalid_request", fmt.Errorf("limit must be between 1 and %d", maxHistoryPageSize))
		}
		pageSize = n
	}
	kind := q.Get("kind")
	if kind != "" && kind != historyRepo && kind != historyPull {
		return nil, badRequest("invalid_request", errors.New(`kind must be "repo" or "pull"`))
	}
	ctx := r.Context()
	since := retentionStart(u, s.now())
	// One row more than the page tells whether another page follows.
	var rows []db.History
	var err error
	if c := q.Get("cursor"); c == "" {
		rows, err = s.Q.ListHistory(ctx, db.ListHistoryParams{Login: u.Login, Since: since, Kind: kind, PageSize: pageSize + 1})
	} else {
		after, ok := parseHistoryCursor(c)
		if !ok {
			return nil, badRequest("invalid_request", errors.New("malformed cursor"))
		}
		rows, err = s.Q.ListHistoryAfter(ctx, db.ListHistoryAfterParams{
			Login: u.Login, Since: since, Kind: kind, PageSize: pageSize + 1,
			AfterViewedAt: after.viewedAt, AfterKind: after.kind, AfterRepo: after.repo, AfterNumber: after.number,
		})
	}
	if err != nil {
		return nil, err
	}
	res := &treehubv1.ListHistoryResponse{}
	if int64(len(rows)) > pageSize {
		rows = rows[:pageSize]
		next := historyCursor(rows[len(rows)-1])
		res.NextCursor = &next
	}
	res.Items = make([]*treehubv1.HistoryItem, 0, len(rows))
	for _, h := range rows {
		res.Items = append(res.Items, historyItemProto(h))
	}
	return res, nil
}

// historyCursor encodes the position of a row in the listing order as
// base64url("<last_viewed_at> <kind> <repo> <number>"). Clients pass it back
// as is. (No field can contain a space.)
func historyCursor(h db.History) string {
	pos := h.LastViewedAt + " " + h.Kind + " " + h.Repo + " " + strconv.FormatInt(h.Number, 10)
	return base64.RawURLEncoding.EncodeToString([]byte(pos))
}

type historyPosition struct {
	viewedAt, kind, repo string
	number               string // decimal, as ListHistoryAfter takes it
}

// parseHistoryCursor accepts exactly what historyCursor produces.
func parseHistoryCursor(s string) (historyPosition, bool) {
	raw, err := base64.RawURLEncoding.Strict().DecodeString(s)
	if err != nil {
		return historyPosition{}, false
	}
	f := strings.Split(string(raw), " ")
	if len(f) != 4 {
		return historyPosition{}, false
	}
	p := historyPosition{viewedAt: f[0], kind: f[1], repo: f[2], number: f[3]}
	// Compared as text in SQL, so it must be spelled like historyTime writes it.
	if t, err := time.Parse(historyTimeLayout, p.viewedAt); err != nil || historyTime(t) != p.viewedAt {
		return historyPosition{}, false
	}
	if owner, name, _ := strings.Cut(p.repo, "/"); !validLogin(owner) || !validRepoName(name) {
		return historyPosition{}, false
	}
	switch p.kind {
	case historyRepo:
		return p, p.number == "0"
	case historyPull:
		_, ok := parsePositive(p.number)
		return p, ok
	}
	return historyPosition{}, false
}

// deleteHistoryItem removes one entry; removing a missing one succeeds.
func (s *Server) deleteHistoryItem(kind string) func(*http.Request) (any, error) {
	return func(r *http.Request) (any, error) {
		u := userFrom(r.Context())
		repo, number, err := historyKey(r, kind)
		if err != nil {
			return nil, err
		}
		if err := s.Q.DeleteHistoryItem(r.Context(), db.DeleteHistoryItemParams{Login: u.Login, Kind: kind, Repo: repo, Number: number}); err != nil {
			return nil, err
		}
		return &treehubv1.OkResponse{Ok: true}, nil
	}
}

// clearHistory deletes all of the user's history; the settings stay.
func (s *Server) clearHistory(r *http.Request) (any, error) {
	if err := s.Q.ClearHistory(r.Context(), userFrom(r.Context()).Login); err != nil {
		return nil, err
	}
	return &treehubv1.OkResponse{Ok: true}, nil
}

func (s *Server) getHistorySettings(r *http.Request) (any, error) {
	return historySettingsProto(userFrom(r.Context())), nil
}

// putHistorySettings stores both settings and prunes with the new retention
// right away, so a shorter one deletes what it no longer keeps.
func (s *Server) putHistorySettings(r *http.Request) (any, error) {
	u := userFrom(r.Context())
	var body treehubv1.HistorySettings
	if err := readJSON(r, &body); err != nil {
		return nil, badRequest("invalid_body", err)
	}
	// proto3 JSON leaves out zero values: a missing retention_days reads as 0
	// and is refused, a missing paused means false.
	if body.RetentionDays < 1 || body.RetentionDays > maxHistoryRetention {
		return nil, badRequest("invalid_body", fmt.Errorf("retention_days must be between 1 and %d", maxHistoryRetention))
	}
	var paused int64
	if body.Paused {
		paused = 1
	}
	ctx := r.Context()
	updated, err := s.Q.SetHistorySettings(ctx, db.SetHistorySettingsParams{
		HistoryRetentionDays: int64(body.RetentionDays), HistoryPaused: paused, GithubID: u.GithubID,
	})
	if err != nil {
		return nil, err
	}
	if err := s.pruneHistory(ctx, &updated, s.now()); err != nil {
		return nil, err
	}
	return historySettingsProto(&updated), nil
}
