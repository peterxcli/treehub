package auth

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"errors"
	"strings"
	"time"
)

const stateTTL = 10 * time.Minute

var (
	ErrInvalidState = errors.New("invalid OAuth state")
	ErrExpiredState = errors.New("expired OAuth state")
)

// State is what the OAuth round trip through GitHub has to remember: which
// extension started the login and the nonce it will check on return. It is
// signed instead of stored, so the Worker needs neither storage nor a cookie
// (the login runs in chrome.identity.launchWebAuthFlow, not on our origin).
type State struct {
	Ext   string `json:"ext"`
	Nonce string `json:"nonce"`
	Exp   int64  `json:"exp"` // unix seconds
}

// NewState returns base64url(json) + "." + base64url(HMAC-SHA256(secret, p)),
// where p is the encoded first part, valid for 10 minutes.
func (s *Sessions) NewState(ext, nonce string) (string, error) {
	payload, err := json.Marshal(State{Ext: ext, Nonce: nonce, Exp: s.now().Add(stateTTL).Unix()})
	if err != nil {
		return "", err
	}
	p := base64.RawURLEncoding.EncodeToString(payload)
	return p + "." + base64.RawURLEncoding.EncodeToString(s.mac(p)), nil
}

// ParseState checks the signature (in constant time) before looking at the
// payload, then the expiry.
func (s *Sessions) ParseState(v string) (*State, error) {
	p, sig, ok := strings.Cut(v, ".")
	if !ok {
		return nil, ErrInvalidState
	}
	// Strict: a signature has exactly one valid spelling.
	got, err := base64.RawURLEncoding.Strict().DecodeString(sig)
	if err != nil || !hmac.Equal(got, s.mac(p)) {
		return nil, ErrInvalidState
	}
	payload, err := base64.RawURLEncoding.DecodeString(p)
	if err != nil {
		return nil, ErrInvalidState
	}
	var st State
	if err := json.Unmarshal(payload, &st); err != nil || st.Ext == "" || st.Nonce == "" {
		return nil, ErrInvalidState
	}
	if s.now().Unix() >= st.Exp {
		return nil, ErrExpiredState
	}
	return &st, nil
}

func (s *Sessions) mac(payload string) []byte {
	m := hmac.New(sha256.New, s.secret)
	m.Write([]byte(payload))
	return m.Sum(nil)
}
