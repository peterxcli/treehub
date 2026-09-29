package auth

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
)

// Minimal GitHub OAuth App (authorization-code) flow using only net/http.
// Docs: https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/authorizing-oauth-apps
const (
	githubAuthorizeURL = "https://github.com/login/oauth/authorize"
	githubTokenURL     = "https://github.com/login/oauth/access_token"
	githubUserURL      = "https://api.github.com/user"
	// The extension reads (private) repositories and pull requests with the token.
	githubScope   = "repo"
	maxGitHubBody = 1 << 20
)

// GitHubUser is the part of GET /user the server keeps.
type GitHubUser struct {
	Login     string  `json:"login"`
	ID        int64   `json:"id"`
	Name      *string `json:"name"`
	AvatarURL *string `json:"avatar_url"`
}

type GitHub struct {
	ClientID     string
	ClientSecret string
	// HTTP is the outbound client: fetch-backed on Workers, stubbed in tests.
	HTTP *http.Client
}

func (g *GitHub) Configured() bool { return g != nil && g.ClientID != "" && g.ClientSecret != "" }

func (g *GitHub) AuthURL(redirectURI, state string) string {
	q := url.Values{}
	q.Set("client_id", g.ClientID)
	q.Set("redirect_uri", redirectURI)
	q.Set("scope", githubScope)
	q.Set("state", state)
	return githubAuthorizeURL + "?" + q.Encode()
}

// Exchange trades the authorization code for a user access token. GitHub
// reports most failures as HTTP 200 with an "error" field. Errors never
// include the token.
func (g *GitHub) Exchange(ctx context.Context, redirectURI, code string) (string, error) {
	form := url.Values{}
	form.Set("client_id", g.ClientID)
	form.Set("client_secret", g.ClientSecret)
	form.Set("code", code)
	form.Set("redirect_uri", redirectURI)
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, githubTokenURL, strings.NewReader(form.Encode()))
	if err != nil {
		return "", err
	}
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	req.Header.Set("Accept", "application/json")
	res, err := g.HTTP.Do(req)
	if err != nil {
		return "", err
	}
	defer res.Body.Close()
	if res.StatusCode != http.StatusOK {
		return "", fmt.Errorf("github token exchange: HTTP %d", res.StatusCode)
	}
	var tok struct {
		AccessToken string `json:"access_token"`
		Error       string `json:"error"`
	}
	if err := json.NewDecoder(io.LimitReader(res.Body, maxGitHubBody)).Decode(&tok); err != nil {
		return "", fmt.Errorf("github token exchange: %w", err)
	}
	if tok.Error != "" {
		return "", fmt.Errorf("github token exchange: %s", tok.Error)
	}
	if tok.AccessToken == "" {
		return "", errors.New("github token exchange: no access_token")
	}
	return tok.AccessToken, nil
}

// User returns the account the token belongs to.
func (g *GitHub) User(ctx context.Context, token string) (*GitHubUser, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, githubUserURL, nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("Authorization", "Bearer "+token)
	req.Header.Set("Accept", "application/vnd.github+json")
	// The REST API rejects requests without a User-Agent.
	req.Header.Set("User-Agent", "treehub")
	res, err := g.HTTP.Do(req)
	if err != nil {
		return nil, err
	}
	defer res.Body.Close()
	if res.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("github user: HTTP %d", res.StatusCode)
	}
	var u GitHubUser
	if err := json.NewDecoder(io.LimitReader(res.Body, maxGitHubBody)).Decode(&u); err != nil {
		return nil, fmt.Errorf("github user: %w", err)
	}
	if u.Login == "" || u.ID <= 0 {
		return nil, errors.New("github user: missing login or id")
	}
	u.Name, u.AvatarURL = nonEmpty(u.Name), nonEmpty(u.AvatarURL)
	return &u, nil
}

func nonEmpty(s *string) *string {
	if s == nil || *s == "" {
		return nil
	}
	return s
}
