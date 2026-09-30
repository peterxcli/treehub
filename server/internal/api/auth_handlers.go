package api

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"hash/fnv"
	"log"
	"net/http"
	"net/url"
	"strconv"
	"strings"

	treehubv1 "github.com/peterxcli/treehub/server/gen/go/treehub/v1"
	"github.com/peterxcli/treehub/server/internal/auth"
	"github.com/peterxcli/treehub/server/internal/db"
)

// Login flow: the extension opens /auth/github/start in
// chrome.identity.launchWebAuthFlow; GitHub sends the user back to
// /auth/github/callback, which redirects to https://<ext>.chromiumapp.org/github
// with the result in the URL fragment (never sent to any server). The
// extension compares the nonce it chose with the one echoed back.

// origin reconstructs the public origin for the OAuth redirect URI.
func origin(r *http.Request) string {
	if r.URL.Scheme != "" && r.URL.Host != "" {
		return r.URL.Scheme + "://" + r.URL.Host
	}
	scheme := "http"
	if r.TLS != nil || r.Header.Get("x-forwarded-proto") == "https" {
		scheme = "https"
	}
	return scheme + "://" + r.Host
}

func callbackURI(r *http.Request) string { return origin(r) + "/auth/github/callback" }

// extensionURL builds the redirect back to the extension; kv are fragment
// key/value pairs, all query-escaped.
func extensionURL(ext string, kv ...string) string {
	var b strings.Builder
	b.WriteString("https://" + ext + ".chromiumapp.org/github#")
	for i := 0; i+1 < len(kv); i += 2 {
		if i > 0 {
			b.WriteByte('&')
		}
		b.WriteString(kv[i] + "=" + url.QueryEscape(kv[i+1]))
	}
	return b.String()
}

// redirect answers 302 without a body. The Location can carry the session and
// the GitHub token, so nothing may cache it.
func redirect(w http.ResponseWriter, location string) {
	w.Header().Set("Location", location)
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(http.StatusFound)
}

// checkLoginRequest validates the ext/nonce pair every login starts with.
func (s *Server) checkLoginRequest(ext, nonce string) error {
	if !s.Cfg.extensionAllowed(ext) {
		return errors.New("unknown extension id")
	}
	if !validNonce(nonce) {
		return errors.New("nonce must be 16-64 characters of A-Z a-z 0-9 _ -")
	}
	return nil
}

func (s *Server) handleGitHubStart(w http.ResponseWriter, r *http.Request) {
	q := r.URL.Query()
	ext, nonce := q.Get("ext"), q.Get("nonce")
	if err := s.checkLoginRequest(ext, nonce); err != nil {
		writeError(w, http.StatusBadRequest, "invalid_request", err.Error())
		return
	}
	if !s.GitHub.Configured() {
		writeError(w, http.StatusInternalServerError, "oauth_not_configured", "GITHUB_CLIENT_ID / GITHUB_CLIENT_SECRET are not set")
		return
	}
	state, err := s.Sessions.NewState(ext, nonce)
	if err != nil {
		log.Printf("oauth state: %v", err)
		writeError(w, http.StatusInternalServerError, "internal", "")
		return
	}
	redirect(w, s.GitHub.AuthURL(callbackURI(r), state))
}

func (s *Server) handleGitHubCallback(w http.ResponseWriter, r *http.Request) {
	q := r.URL.Query()
	st, err := s.Sessions.ParseState(q.Get("state"))
	if err != nil || !s.Cfg.extensionAllowed(st.Ext) {
		// Without a trustworthy state there is no safe place to redirect to.
		msg := "invalid OAuth state"
		if errors.Is(err, auth.ErrExpiredState) {
			msg = "OAuth state expired, start the login again"
		}
		writeError(w, http.StatusBadRequest, "invalid_state", msg)
		return
	}
	fail := func(reason string) {
		redirect(w, extensionURL(st.Ext, "error", reason, "nonce", st.Nonce))
	}
	if e := q.Get("error"); e != "" {
		fail(e) // e.g. access_denied when the user cancels on GitHub
		return
	}
	if !s.GitHub.Configured() {
		log.Print("oauth callback: GITHUB_CLIENT_ID / GITHUB_CLIENT_SECRET are not set")
		fail("internal")
		return
	}
	code := q.Get("code")
	if code == "" {
		fail("exchange")
		return
	}
	ctx := r.Context()
	// The GitHub token only passes through to the extension, which calls
	// GitHub with it directly; it is never stored or logged.
	token, err := s.GitHub.Exchange(ctx, callbackURI(r), code)
	if err != nil {
		log.Printf("oauth exchange: %v", err)
		fail("exchange")
		return
	}
	gh, err := s.GitHub.User(ctx, token)
	if err != nil {
		log.Printf("oauth user: %v", err)
		fail("user")
		return
	}
	u, session, err := s.signIn(ctx, gh)
	if err != nil {
		log.Printf("oauth sign-in: %v", err)
		fail("internal")
		return
	}
	redirect(w, extensionURL(st.Ext, "session", session, "github_token", token, "login", u.Login, "nonce", st.Nonce))
}

// handleDevLogin is local development only: sign in as any handle without
// GitHub (the extension then has no GitHub token). Guarded by DEV_AUTH=true,
// which must never be set in production.
func (s *Server) handleDevLogin(w http.ResponseWriter, r *http.Request) {
	if !s.Cfg.DevAuth {
		writeError(w, http.StatusNotFound, "not_found", "")
		return
	}
	q := r.URL.Query()
	ext, nonce := q.Get("ext"), q.Get("nonce")
	if err := s.checkLoginRequest(ext, nonce); err != nil {
		writeError(w, http.StatusBadRequest, "invalid_request", err.Error())
		return
	}
	login := q.Get("login")
	if login == "" {
		login = "octocat"
	}
	if !validLogin(login) {
		writeError(w, http.StatusBadRequest, "invalid_request", "login must be a GitHub handle")
		return
	}
	u, session, err := s.signIn(r.Context(), &auth.GitHubUser{Login: login, ID: devGitHubID(login)})
	if err != nil {
		log.Printf("dev login: %v", err)
		redirect(w, extensionURL(ext, "error", "internal", "nonce", nonce))
		return
	}
	redirect(w, extensionURL(ext, "session", session, "login", u.Login, "nonce", nonce))
}

// devGitHubID derives a stable fake GitHub id from the handle (31-bit FNV-1a).
func devGitHubID(login string) int64 {
	h := fnv.New32a()
	h.Write([]byte(strings.ToLower(login)))
	if id := int64(h.Sum32() & 0x7fffffff); id > 0 {
		return id
	}
	return 1
}

// signIn records the GitHub account and issues a session for it.
func (s *Server) signIn(ctx context.Context, gh *auth.GitHubUser) (*db.User, string, error) {
	u, err := s.upsertUser(ctx, gh)
	if err != nil {
		return nil, "", err
	}
	session, err := s.Sessions.Issue(u.Login, u.GithubID, u.TokenVersion)
	if err != nil {
		return nil, "", err
	}
	return &u, session, nil
}

// upsertUser stores a sign-in. The handle is the key and github_id is stable,
// so a renamed account is renamed here too and ON UPDATE CASCADE moves its
// bookmarks, queue and history. D1 has no transactions; every step is safe to
// redo on the next sign-in if a later one fails.
func (s *Server) upsertUser(ctx context.Context, gh *auth.GitHubUser) (db.User, error) {
	// A different account may still hold this handle: its owner renamed away
	// and the handle was taken over. Park that row under a name no GitHub
	// handle can have ("~" is not allowed); it gets its real name back when
	// its owner signs in again.
	holder, err := s.Q.GetUserByLogin(ctx, gh.Login)
	switch {
	case err == nil && holder.GithubID != gh.ID:
		if err := s.rename(ctx, holder.GithubID, parkedLogin(holder)); err != nil {
			return db.User{}, fmt.Errorf("park stale user: %w", err)
		}
	case err != nil && !errors.Is(err, sql.ErrNoRows):
		return db.User{}, err
	}

	cur, err := s.Q.GetUserByGithubID(ctx, gh.ID)
	switch {
	case errors.Is(err, sql.ErrNoRows):
		version, err := auth.NewTokenVersion()
		if err != nil {
			return db.User{}, err
		}
		if err := s.Q.InsertUser(ctx, db.InsertUserParams{Login: gh.Login, GithubID: gh.ID, TokenVersion: version}); err != nil {
			return db.User{}, fmt.Errorf("insert user: %w", err)
		}
	case err != nil:
		return db.User{}, err
	case cur.Login != gh.Login:
		if strings.EqualFold(cur.Login, gh.Login) {
			// Only the case changed. users.login is COLLATE NOCASE, so SQLite
			// treats the key as unchanged and skips ON UPDATE CASCADE; the
			// (case-sensitive) child rows would keep the old spelling. Go
			// through a different name so the cascade runs.
			if err := s.rename(ctx, cur.GithubID, parkedLogin(cur)); err != nil {
				return db.User{}, err
			}
		}
		if err := s.rename(ctx, cur.GithubID, gh.Login); err != nil {
			return db.User{}, err
		}
	}
	return s.Q.TouchUserLogin(ctx, db.TouchUserLoginParams{Name: gh.Name, AvatarUrl: gh.AvatarURL, GithubID: gh.ID})
}

func (s *Server) rename(ctx context.Context, githubID int64, login string) error {
	if err := s.Q.RenameUser(ctx, db.RenameUserParams{Login: login, GithubID: githubID}); err != nil {
		return fmt.Errorf("rename user %d: %w", githubID, err)
	}
	return nil
}

// parkedLogin is "<login>~<github_id>", unique per account.
func parkedLogin(u db.User) string {
	return u.Login + "~" + strconv.FormatInt(u.GithubID, 10)
}

func (s *Server) me(r *http.Request) (any, error) {
	return &treehubv1.MeResponse{User: userProto(userFrom(r.Context()))}, nil
}

// deleteMe deletes the account; ON DELETE CASCADE removes its bookmarks, queue
// and history. Its sessions fail from now on (the user is gone), and a later
// sign-in starts a new, empty account with a fresh token version.
func (s *Server) deleteMe(r *http.Request) (any, error) {
	if err := s.Q.DeleteUser(r.Context(), userFrom(r.Context()).GithubID); err != nil {
		return nil, err
	}
	return &treehubv1.OkResponse{Ok: true}, nil
}

// logoutAll revokes every session of the user, including the current one.
func (s *Server) logoutAll(r *http.Request) (any, error) {
	if err := s.Q.BumpTokenVersion(r.Context(), userFrom(r.Context()).GithubID); err != nil {
		return nil, err
	}
	return &treehubv1.OkResponse{Ok: true}, nil
}
