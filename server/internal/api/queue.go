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
// title, the user's note and when each was last opened; statuses are computed
// by the extension.

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

// queueItemBody reads the title and the note of a PUT or PATCH: nil keeps
// the item's, "" removes it.
func queueItemBody(r *http.Request) (title, note *string, err error) {
	var body treehubv1.PutQueueItemRequest
	if err := readJSON(r, &body); err != nil {
		return nil, nil, badRequest("invalid_body", err)
	}
	if note, err = noteParam(body.Note); err != nil {
		return nil, nil, err
	}
	if body.Title != nil {
		// An empty title removes the cached one ("": NULL would keep it)
		title = normalizeTitle(*body.Title)
		if title == nil {
			title = new(string)
		}
	}
	return title, note, nil
}

// putQueueItem adds a pull request (idempotent). The title and the note are
// only replaced when the body carries them, so a bare PUT never erases them.
func (s *Server) putQueueItem(r *http.Request) (any, error) {
	u := userFrom(r.Context())
	repo, number, err := queueKey(r)
	if err != nil {
		return nil, err
	}
	title, note, err := queueItemBody(r)
	if err != nil {
		return nil, err
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
	row, err := s.Q.UpsertQueueItem(ctx, db.UpsertQueueItemParams{
		Login: u.Login, Repo: repo, Number: number,
		Title: title, TitleTerms: terms(title), Note: note, NoteTerms: terms(note),
	})
	if err != nil {
		return nil, err
	}
	return queueItemProto(row), nil
}

// patchQueueItem changes the title or the note of a queued pull request, as
// putQueueItem does, but never queues one: the extension saves the titles it
// reads on GitHub with it, which mustn't add back a pull request removed
// meanwhile.
func (s *Server) patchQueueItem(r *http.Request) (any, error) {
	u := userFrom(r.Context())
	repo, number, err := queueKey(r)
	if err != nil {
		return nil, err
	}
	title, note, err := queueItemBody(r)
	if err != nil {
		return nil, err
	}
	row, err := s.Q.UpdateQueueItem(r.Context(), db.UpdateQueueItemParams{
		Login: u.Login, Repo: repo, Number: number,
		Title: title, TitleTerms: terms(title), Note: note, NoteTerms: terms(note),
	})
	if errors.Is(err, sql.ErrNoRows) {
		return nil, notFound(errors.New("pull request is not in the review queue"))
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
