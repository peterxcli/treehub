package api

import (
	"database/sql"
	"errors"
	"fmt"
	"net/http"

	treehubv1 "github.com/peterxcli/treehub/server/gen/go/treehub/v1"
	"github.com/peterxcli/treehub/server/internal/db"
)

func (s *Server) listBookmarks(r *http.Request) (any, error) {
	u := userFrom(r.Context())
	rows, err := s.Q.ListBookmarks(r.Context(), u.Login)
	if err != nil {
		return nil, err
	}
	res := &treehubv1.ListBookmarksResponse{Bookmarks: make([]*treehubv1.Bookmark, 0, len(rows))}
	for _, b := range rows {
		res.Bookmarks = append(res.Bookmarks, bookmarkProto(b))
	}
	return res, nil
}

// putBookmark is idempotent: saving an existing bookmark keeps its created_at.
func (s *Server) putBookmark(r *http.Request) (any, error) {
	u := userFrom(r.Context())
	repo, err := repoParam(r)
	if err != nil {
		return nil, err
	}
	ctx := r.Context()
	// The limit only applies to new rows, so re-saving always works. Without
	// transactions (D1) concurrent requests can overshoot it slightly.
	_, err = s.Q.GetBookmark(ctx, db.GetBookmarkParams{Login: u.Login, Repo: repo})
	switch {
	case errors.Is(err, sql.ErrNoRows):
		n, err := s.Q.CountBookmarks(ctx, u.Login)
		if err != nil {
			return nil, err
		}
		if limit := s.Cfg.maxBookmarks(); n >= limit {
			return nil, limitReached(fmt.Errorf("at most %d bookmarks per user", limit))
		}
	case err != nil:
		return nil, err
	}
	b, err := s.Q.UpsertBookmark(ctx, db.UpsertBookmarkParams{Login: u.Login, Repo: repo})
	if err != nil {
		return nil, err
	}
	return bookmarkProto(b), nil
}

// deleteBookmark is idempotent: removing a missing bookmark succeeds.
func (s *Server) deleteBookmark(r *http.Request) (any, error) {
	u := userFrom(r.Context())
	repo, err := repoParam(r)
	if err != nil {
		return nil, err
	}
	if err := s.Q.DeleteBookmark(r.Context(), db.DeleteBookmarkParams{Login: u.Login, Repo: repo}); err != nil {
		return nil, err
	}
	return &treehubv1.OkResponse{Ok: true}, nil
}
