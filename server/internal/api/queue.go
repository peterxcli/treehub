package api

import (
	"database/sql"
	"errors"
	"fmt"
	"net/http"

	treehubv1 "github.com/peterxcli/treehub/server/gen/go/treehub/v1"
	"github.com/peterxcli/treehub/server/internal/db"
)

// The review queue only remembers which pull requests are queued, a cached
// title and when each was last opened; statuses are computed by the extension.

func (s *Server) listQueue(r *http.Request) (any, error) {
	u := userFrom(r.Context())
	rows, err := s.Q.ListQueueItems(r.Context(), u.Login)
	if err != nil {
		return nil, err
	}
	res := &treehubv1.ListQueueResponse{Items: make([]*treehubv1.QueueItem, 0, len(rows))}
	for _, q := range rows {
		res.Items = append(res.Items, queueItemProto(q))
	}
	return res, nil
}

// queueKey reads owner/name/number from the path.
func queueKey(r *http.Request) (repo string, number int64, err error) {
	if repo, err = repoParam(r); err != nil {
		return "", 0, err
	}
	if number, err = numberParam(r); err != nil {
		return "", 0, err
	}
	return repo, number, nil
}

// putQueueItem adds a pull request (idempotent). The title is only replaced
// when the body carries one, so a bare PUT never erases a cached title.
func (s *Server) putQueueItem(r *http.Request) (any, error) {
	u := userFrom(r.Context())
	repo, number, err := queueKey(r)
	if err != nil {
		return nil, err
	}
	var body treehubv1.PutQueueItemRequest
	if err := readJSON(r, &body); err != nil {
		return nil, badRequest("invalid_body", err)
	}
	ctx := r.Context()
	_, err = s.Q.GetQueueItem(ctx, db.GetQueueItemParams{Login: u.Login, Repo: repo, Number: number})
	switch {
	case errors.Is(err, sql.ErrNoRows):
		n, err := s.Q.CountQueueItems(ctx, u.Login)
		if err != nil {
			return nil, err
		}
		if limit := s.Cfg.maxQueueItems(); n >= limit {
			return nil, limitReached(fmt.Errorf("at most %d queued pull requests per user", limit))
		}
	case err != nil:
		return nil, err
	}
	var row db.QueueItem
	if body.Title != nil {
		row, err = s.Q.UpsertQueueItem(ctx, db.UpsertQueueItemParams{
			Login: u.Login, Repo: repo, Number: number, Title: normalizeTitle(*body.Title),
		})
	} else {
		row, err = s.Q.EnsureQueueItem(ctx, db.EnsureQueueItemParams{Login: u.Login, Repo: repo, Number: number})
	}
	if err != nil {
		return nil, err
	}
	return queueItemProto(row), nil
}

// deleteQueueItem is idempotent: removing a missing item succeeds.
func (s *Server) deleteQueueItem(r *http.Request) (any, error) {
	u := userFrom(r.Context())
	repo, number, err := queueKey(r)
	if err != nil {
		return nil, err
	}
	if err := s.Q.DeleteQueueItem(r.Context(), db.DeleteQueueItemParams{Login: u.Login, Repo: repo, Number: number}); err != nil {
		return nil, err
	}
	return &treehubv1.OkResponse{Ok: true}, nil
}

// markQueueItemSeen records that the user opened the pull request now.
func (s *Server) markQueueItemSeen(r *http.Request) (any, error) {
	u := userFrom(r.Context())
	repo, number, err := queueKey(r)
	if err != nil {
		return nil, err
	}
	row, err := s.Q.MarkQueueItemSeen(r.Context(), db.MarkQueueItemSeenParams{Login: u.Login, Repo: repo, Number: number})
	if errors.Is(err, sql.ErrNoRows) {
		return nil, notFound(errors.New("pull request is not in the review queue"))
	}
	if err != nil {
		return nil, err
	}
	return queueItemProto(row), nil
}
