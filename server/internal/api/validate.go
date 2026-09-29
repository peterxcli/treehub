package api

import (
	"errors"
	"math"
	"net/http"
	"strings"
	"unicode/utf8"
)

// Hand-written checks instead of regexp: they are exact and keep the Wasm small.

const maxTitleLength = 300 // characters

func isAlnum(c byte) bool {
	return 'a' <= c && c <= 'z' || 'A' <= c && c <= 'Z' || '0' <= c && c <= '9'
}

// validLogin follows GitHub's handle rules: an alphanumeric first character,
// then alphanumerics or hyphens, at most 39 characters. Repository owners are
// handles too.
func validLogin(s string) bool {
	if len(s) < 1 || len(s) > 39 {
		return false
	}
	for i := 0; i < len(s); i++ {
		if !isAlnum(s[i]) && (s[i] != '-' || i == 0) {
			return false
		}
	}
	return true
}

// validRepoName allows what GitHub allows in repository names.
func validRepoName(s string) bool {
	if len(s) < 1 || len(s) > 100 || s == "." || s == ".." {
		return false
	}
	for i := 0; i < len(s); i++ {
		if c := s[i]; !isAlnum(c) && c != '.' && c != '_' && c != '-' {
			return false
		}
	}
	return true
}

// validExtensionID matches Chrome extension IDs: 32 letters a-p.
func validExtensionID(s string) bool {
	if len(s) != 32 {
		return false
	}
	for i := 0; i < len(s); i++ {
		if s[i] < 'a' || s[i] > 'p' {
			return false
		}
	}
	return true
}

// validNonce accepts 16-64 base64url characters.
func validNonce(s string) bool {
	if len(s) < 16 || len(s) > 64 {
		return false
	}
	for i := 0; i < len(s); i++ {
		if c := s[i]; !isAlnum(c) && c != '_' && c != '-' {
			return false
		}
	}
	return true
}

func (c Config) extensionAllowed(ext string) bool {
	if !validExtensionID(ext) {
		return false
	}
	for _, id := range c.AllowedExtensionIDs {
		if id == ext {
			return true
		}
	}
	return false
}

// ParseList splits a comma-separated variable such as ALLOWED_EXTENSION_IDS.
func ParseList(s string) []string {
	var out []string
	for _, v := range strings.Split(s, ",") {
		if v = strings.TrimSpace(v); v != "" {
			out = append(out, v)
		}
	}
	return out
}

// repoParam returns "owner/name" from the path, spelled as given; the
// database compares repos case-insensitively (COLLATE NOCASE).
func repoParam(r *http.Request) (string, error) {
	owner, name := param(r, "owner"), param(r, "name")
	if !validLogin(owner) || !validRepoName(name) {
		return "", badRequest("invalid_repo", errors.New("expected /{owner}/{name} of a GitHub repository"))
	}
	return owner + "/" + name, nil
}

// numberParam returns the pull request number from the path: 1..2^31-1,
// digits only.
func numberParam(r *http.Request) (int64, error) {
	s := param(r, "number")
	invalid := badRequest("invalid_number", errors.New("expected a pull request number between 1 and 2147483647"))
	if len(s) < 1 || len(s) > 10 || s[0] == '0' {
		return 0, invalid
	}
	var n int64
	for i := 0; i < len(s); i++ {
		if s[i] < '0' || s[i] > '9' {
			return 0, invalid
		}
		n = n*10 + int64(s[i]-'0')
	}
	if n > math.MaxInt32 {
		return 0, invalid
	}
	return n, nil
}

// normalizeTitle trims a pull request title and cuts it to 300 characters;
// an empty title clears the stored one.
func normalizeTitle(s string) *string {
	s = strings.TrimSpace(s)
	if utf8.RuneCountInString(s) > maxTitleLength {
		s = strings.TrimSpace(string([]rune(s)[:maxTitleLength]))
	}
	if s == "" {
		return nil
	}
	return &s
}
