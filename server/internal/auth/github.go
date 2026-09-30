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

// Token is a GitHub user access token. An OAuth App can make its tokens
// expire (GitHub: 8 hours, renewed with a refresh token that is valid for 6
// months and replaced at every renewal): then ExpiresIn and the refresh token
// are set.
type Token struct {
	AccessToken           string  `json:"access_token"`
	ExpiresIn             seconds `json:"expires_in"` // 0: the token doesn't expire
	RefreshToken          string  `json:"refresh_token"`
	RefreshTokenExpiresIn seconds `json:"refresh_token_expires_in"`
}

// seconds is a duration GitHub may write as a number or a numeric string.
type seconds int64

func (s *seconds) UnmarshalJSON(b []byte) error {
	var n json.Number
	if err := json.Unmarshal(b, &n); err != nil {
		var text string
		if err := json.Unmarshal(b, &text); err != nil {
			return err
		}
		n = json.Number(text)
	}
	if n == "" {
		*s = 0
		return nil
	}
	v, err := n.Int64()
	*s = seconds(v)
	return err
}

// ErrBadRefreshToken is returned when GitHub refuses a refresh token: it
// expired, was used already or the authorization was revoked. Only signing in
// again gives a new one.
var ErrBadRefreshToken = errors.New("github refused the refresh token")

// Exchange trades the authorization code for a user access token.
func (g *GitHub) Exchange(ctx context.Context, redirectURI, code string) (*Token, error) {
	form := url.Values{}
	form.Set("client_id", g.ClientID)
	form.Set("client_secret", g.ClientSecret)
	form.Set("code", code)
	form.Set("redirect_uri", redirectURI)
	return g.token(ctx, form)
}

// Refresh renews an expiring user access token with its refresh token; GitHub
// answers with a new refresh token too.
func (g *GitHub) Refresh(ctx context.Context, refreshToken string) (*Token, error) {
	form := url.Values{}
	form.Set("client_id", g.ClientID)
	form.Set("client_secret", g.ClientSecret)
	form.Set("grant_type", "refresh_token")
	form.Set("refresh_token", refreshToken)
	return g.token(ctx, form)
}

// token calls GitHub's token endpoint. GitHub reports most failures as HTTP
// 200 with an "error" field. Errors never include the tokens.
func (g *GitHub) token(ctx context.Context, form url.Values) (*Token, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, githubTokenURL, strings.NewReader(form.Encode()))
	if err != nil {
		return nil, err
	}
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	req.Header.Set("Accept", "application/json")
	res, err := g.HTTP.Do(req)
	if err != nil {
		return nil, err
	}
	defer res.Body.Close()
	if res.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("github token: HTTP %d", res.StatusCode)
	}
	var tok struct {
		Token
		Error string `json:"error"`
	}
	if err := json.NewDecoder(io.LimitReader(res.Body, maxGitHubBody)).Decode(&tok); err != nil {
		return nil, fmt.Errorf("github token: %w", err)
	}
	if tok.Error == "bad_refresh_token" {
		return nil, ErrBadRefreshToken
	}
	if tok.Error != "" {
		return nil, fmt.Errorf("github token: %s", tok.Error)
	}
	if tok.AccessToken == "" {
		return nil, errors.New("github token: no access_token")
	}
	return &tok.Token, nil
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
