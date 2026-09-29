// Package auth implements the GitHub OAuth login, the signed OAuth state and
// the JWT sessions used by the API.
package auth

import (
	"crypto/rand"
	"encoding/binary"
	"errors"
	"net/http"
	"strings"
	"time"

	"github.com/golang-jwt/jwt/v5"
)

const (
	sessionTTL = 30 * 24 * time.Hour
	// MinSecretLength is the shortest SESSION_SECRET accepted (HS256 key).
	MinSecretLength = 32
)

// ErrNoSession is returned by Parse for a request without a bearer token.
var ErrNoSession = errors.New("no session token")

// Sessions signs and verifies session tokens (and OAuth states, see state.go)
// with SESSION_SECRET. The client is a browser extension, not a same-origin
// page, so the session travels as "Authorization: Bearer <jwt>", never as a
// cookie.
type Sessions struct {
	secret []byte
	// Now is the clock; nil means time.Now. Tests move it to expire tokens.
	Now func() time.Time
}

func NewSessions(secret string) (*Sessions, error) {
	if len(secret) < MinSecretLength {
		return nil, errors.New("SESSION_SECRET is missing or shorter than 32 characters")
	}
	return &Sessions{secret: []byte(secret)}, nil
}

func (s *Sessions) now() time.Time {
	if s.Now != nil {
		return s.Now()
	}
	return time.Now()
}

// Claims of a session. The user is found by UID (the GitHub id) because a
// GitHub handle can be renamed; Subject (the handle at issue time) is only
// informative. Ver must equal users.token_version, so bumping the version
// revokes every earlier session.
type Claims struct {
	UID int64 `json:"uid"`
	Ver int64 `json:"ver"`
	jwt.RegisteredClaims
}

// Issue returns a signed session token valid for 30 days.
func (s *Sessions) Issue(login string, githubID, version int64) (string, error) {
	now := s.now()
	claims := Claims{
		UID: githubID,
		Ver: version,
		RegisteredClaims: jwt.RegisteredClaims{
			Subject:   login,
			IssuedAt:  jwt.NewNumericDate(now),
			ExpiresAt: jwt.NewNumericDate(now.Add(sessionTTL)),
		},
	}
	return jwt.NewWithClaims(jwt.SigningMethodHS256, claims).SignedString(s.secret)
}

// Parse verifies a session token (HS256 only, must carry an unexpired exp)
// and returns its claims. Whether the user still exists and the version still
// matches is up to the caller.
func (s *Sessions) Parse(token string) (*Claims, error) {
	if token == "" {
		return nil, ErrNoSession
	}
	claims := &Claims{}
	_, err := jwt.ParseWithClaims(token, claims, func(*jwt.Token) (any, error) { return s.secret, nil },
		jwt.WithValidMethods([]string{jwt.SigningMethodHS256.Alg()}),
		jwt.WithExpirationRequired(),
		jwt.WithTimeFunc(s.now))
	if err != nil {
		return nil, err
	}
	if claims.UID <= 0 {
		return nil, errors.New("session has no user id")
	}
	return claims, nil
}

// NewTokenVersion returns the token version a new account starts with. It is
// random (31 bits) rather than 0: after an account is deleted and the same
// GitHub user signs up again, the old sessions (same uid, old ver) must not
// come back to life.
func NewTokenVersion() (int64, error) {
	var b [4]byte
	if _, err := rand.Read(b[:]); err != nil {
		return 0, err
	}
	return int64(binary.BigEndian.Uint32(b[:]) >> 1), nil
}

// BearerToken returns the token of an "Authorization: Bearer <token>" header,
// or "" when there is none.
func BearerToken(r *http.Request) string {
	scheme, token, ok := strings.Cut(strings.TrimSpace(r.Header.Get("Authorization")), " ")
	if !ok || !strings.EqualFold(scheme, "Bearer") {
		return ""
	}
	return strings.TrimSpace(token)
}
