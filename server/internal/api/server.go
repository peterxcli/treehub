// Package api is the HTTP API of the TreeHub backend. It is plain net/http so
// it compiles both for the Worker (TinyGo/Wasm) and on the host for tests.
package api

import (
	"bytes"
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"io"
	"log"
	"net/http"
	"strings"
	"time"

	treehubv1 "github.com/peterxcli/treehub/server/gen/go/treehub/v1"
	"github.com/peterxcli/treehub/server/internal/auth"
	"github.com/peterxcli/treehub/server/internal/db"
)

// Per-user row limits. Bookmarks and queue items are checked before a new row
// is inserted; the history never refuses a view and drops its oldest rows
// instead.
const (
	DefaultMaxBookmarks    = 1000
	DefaultMaxQueueItems   = 500
	DefaultMaxHistoryItems = 5000
)

type Config struct {
	// AllowedExtensionIDs may receive a session: the login ends with a redirect
	// to https://<id>.chromiumapp.org/, which only that extension can read.
	AllowedExtensionIDs []string
	// DevAuth enables GET /auth/dev-login (local development only).
	DevAuth bool
	// Limits per user; zero means the default.
	MaxBookmarks    int64
	MaxQueueItems   int64
	MaxHistoryItems int64
}

func (c Config) maxBookmarks() int64 {
	if c.MaxBookmarks > 0 {
		return c.MaxBookmarks
	}
	return DefaultMaxBookmarks
}

func (c Config) maxQueueItems() int64 {
	if c.MaxQueueItems > 0 {
		return c.MaxQueueItems
	}
	return DefaultMaxQueueItems
}

func (c Config) maxHistoryItems() int64 {
	if c.MaxHistoryItems > 0 {
		return c.MaxHistoryItems
	}
	return DefaultMaxHistoryItems
}

type Server struct {
	Q        *db.Queries
	Sessions *auth.Sessions
	GitHub   *auth.GitHub
	Cfg      Config
	// Now is the clock of the history (its timestamps and retention); nil
	// means time.Now. Tests move it.
	Now func() time.Time
}

func (s *Server) now() time.Time {
	if s.Now != nil {
		return s.Now()
	}
	return time.Now()
}

// Handler returns the routed HTTP handler with CORS applied to every response.
func (s *Server) Handler() http.Handler {
	rt := &router{}

	health := func(w http.ResponseWriter, r *http.Request) {
		writeJSON(w, http.StatusOK, map[string]any{"ok": true, "service": "treehub"})
	}
	rt.handle("GET", "/", health)
	rt.handle("GET", "/api/health", health)

	rt.handle("GET", "/auth/github/start", s.handleGitHubStart)
	rt.handle("GET", "/auth/github/callback", s.handleGitHubCallback)
	rt.handle("GET", "/auth/dev-login", s.handleDevLogin)

	rt.handle("GET", "/api/me", s.authed(jsonEndpoint(s.me)))
	rt.handle("DELETE", "/api/me", s.authed(jsonEndpoint(s.deleteMe)))
	rt.handle("POST", "/api/logout-all", s.authed(jsonEndpoint(s.logoutAll)))

	rt.handle("GET", "/api/bookmarks", s.authed(jsonEndpoint(s.listBookmarks)))
	rt.handle("PUT", "/api/bookmarks/{owner}/{name}", s.authed(jsonEndpoint(s.putBookmark)))
	rt.handle("DELETE", "/api/bookmarks/{owner}/{name}", s.authed(jsonEndpoint(s.deleteBookmark)))

	rt.handle("GET", "/api/queue", s.authed(jsonEndpoint(s.listQueue)))
	rt.handle("PUT", "/api/queue/{owner}/{name}/{number}", s.authed(jsonEndpoint(s.putQueueItem)))
	rt.handle("DELETE", "/api/queue/{owner}/{name}/{number}", s.authed(jsonEndpoint(s.deleteQueueItem)))
	rt.handle("POST", "/api/queue/{owner}/{name}/{number}/seen", s.authed(jsonEndpoint(s.markQueueItemSeen)))

	rt.handle("GET", "/api/history", s.authed(jsonEndpoint(s.listHistory)))
	rt.handle("DELETE", "/api/history", s.authed(jsonEndpoint(s.clearHistory)))
	rt.handle("GET", "/api/history/settings", s.authed(jsonEndpoint(s.getHistorySettings)))
	rt.handle("PUT", "/api/history/settings", s.authed(jsonEndpoint(s.putHistorySettings)))
	rt.handle("PUT", "/api/history/repos/{owner}/{name}", s.authed(jsonEndpoint(s.recordView(historyRepo))))
	rt.handle("DELETE", "/api/history/repos/{owner}/{name}", s.authed(jsonEndpoint(s.deleteHistoryItem(historyRepo))))
	rt.handle("PUT", "/api/history/pulls/{owner}/{name}/{number}", s.authed(jsonEndpoint(s.recordView(historyPull))))
	rt.handle("DELETE", "/api/history/pulls/{owner}/{name}/{number}", s.authed(jsonEndpoint(s.deleteHistoryItem(historyPull))))

	return withCORS(rt)
}

// withCORS allows every origin on every response and answers preflights. This
// is safe because requests authenticate with a bearer token, never cookies, so
// a foreign page cannot act as the user without already holding the token.
func withCORS(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		h := w.Header()
		h.Set("Access-Control-Allow-Origin", "*")
		h.Set("Access-Control-Allow-Headers", "Authorization, Content-Type")
		h.Set("Access-Control-Allow-Methods", "GET, PUT, POST, DELETE, OPTIONS")
		h.Set("Access-Control-Max-Age", "86400")
		if r.Method == http.MethodOptions {
			w.WriteHeader(http.StatusNoContent)
			return
		}
		next.ServeHTTP(w, r)
	})
}

// Unavailable answers every request with 500 when the Worker cannot be set up
// (e.g. SESSION_SECRET missing), so the cause is visible to the client.
func Unavailable(reason string) http.Handler {
	return withCORS(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		writeError(w, http.StatusInternalServerError, "internal", reason)
	}))
}

// ---------- session middleware ----------

type userKey struct{}

// userFrom returns the signed-in user; only valid behind authed.
func userFrom(ctx context.Context) *db.User {
	u, _ := ctx.Value(userKey{}).(*db.User)
	return u
}

// authed admits requests with a valid bearer session. The user is loaded by
// GitHub id, so a renamed account keeps its sessions, and the token version
// must match, so "sign out everywhere" revokes older tokens.
func (s *Server) authed(next http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		claims, err := s.Sessions.Parse(auth.BearerToken(r))
		if err != nil {
			message := "invalid or expired session"
			if errors.Is(err, auth.ErrNoSession) {
				message = "missing bearer token"
			}
			writeError(w, http.StatusUnauthorized, "login_required", message)
			return
		}
		u, err := s.Q.GetUserByGithubID(r.Context(), claims.UID)
		switch {
		case errors.Is(err, sql.ErrNoRows):
			writeError(w, http.StatusUnauthorized, "login_required", "unknown user")
			return
		case err != nil:
			log.Printf("session lookup: %v", err)
			writeError(w, http.StatusInternalServerError, "internal", "")
			return
		case u.TokenVersion != claims.Ver:
			writeError(w, http.StatusUnauthorized, "login_required", "session revoked")
			return
		}
		next(w, r.WithContext(context.WithValue(r.Context(), userKey{}, &u)))
	}
}

// ---------- JSON helpers ----------
//
// The wire format is encoding/json over the protoc-gen-go structs: proto field
// names (snake_case) and enums as integers. The extension parses it with
// protoc-gen-es, so both sides share proto/treehub/v1/api.proto as the single
// spec. (protojson itself is not usable: protobuf-go's reflection needs
// reflect.Type.MethodByName, which TinyGo does not implement.)

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	if err := json.NewEncoder(w).Encode(v); err != nil {
		log.Printf("writeJSON: %v", err)
	}
}

func writeError(w http.ResponseWriter, status int, code, message string) {
	e := &treehubv1.ErrorResponse{Error: code}
	if message != "" {
		e.Message = &message
	}
	writeJSON(w, status, e)
}

const maxJSONBody = 64 << 10

// readJSON decodes an optional JSON body: an empty body leaves v untouched.
// (On Workers a request without a body has a nil Body.)
func readJSON(r *http.Request, v any) error {
	if r.Body == nil {
		return nil
	}
	body, err := io.ReadAll(io.LimitReader(r.Body, maxJSONBody+1))
	if err != nil {
		return err
	}
	if len(body) > maxJSONBody {
		return errors.New("body too large")
	}
	if len(bytes.TrimSpace(body)) == 0 {
		return nil
	}
	if ct := r.Header.Get("Content-Type"); ct != "" && !strings.HasPrefix(ct, "application/json") {
		return errors.New("expected application/json")
	}
	return json.Unmarshal(body, v)
}

// ---------- DB rows -> API messages ----------

func userProto(u *db.User) *treehubv1.User {
	return &treehubv1.User{
		Login: u.Login, GithubId: u.GithubID, Name: u.Name, AvatarUrl: u.AvatarUrl, CreatedAt: u.CreatedAt,
	}
}

func bookmarkProto(b db.Bookmark) *treehubv1.Bookmark {
	return &treehubv1.Bookmark{Repo: b.Repo, CreatedAt: b.CreatedAt}
}

func queueItemProto(q db.QueueItem) *treehubv1.QueueItem {
	return &treehubv1.QueueItem{
		Repo: q.Repo, Number: int32(q.Number), Title: q.Title, AddedAt: q.AddedAt, LastSeenAt: q.LastSeenAt,
	}
}

func historyItemProto(h db.History) *treehubv1.HistoryItem {
	return &treehubv1.HistoryItem{
		Kind: h.Kind, Repo: h.Repo, Number: int32(h.Number), Title: h.Title,
		FirstViewedAt: h.FirstViewedAt, LastViewedAt: h.LastViewedAt, ViewCount: int32(h.ViewCount),
	}
}

func historySettingsProto(u *db.User) *treehubv1.HistorySettings {
	return &treehubv1.HistorySettings{RetentionDays: int32(u.HistoryRetentionDays), Paused: u.HistoryPaused != 0}
}
