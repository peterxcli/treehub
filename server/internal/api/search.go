package api

import (
	"database/sql"
	"fmt"
	"net/http"
	"strings"
	"unicode"
	"unicode/utf8"

	treehubv1 "github.com/peterxcli/treehub/server/gen/go/treehub/v1"
)

// Notes on bookmarks and queued pull requests, and searching the bookmarks and
// the queue. Triggers keep the full-text index (search_index, FTS5) up to date
// with the *_terms columns, which the handlers fill from searchTerms (see
// migrations/0003_notes.sql).

const (
	maxNoteLength      = 2000 // characters
	maxSearchLength    = 200  // characters
	defaultSearchLimit = 20
	maxSearchLimit     = 50
)

// zeroWidthSpace separates the characters of Chinese, Japanese and Korean text
// in the index and in queries: the tokenizer (unicode61) would take a run of
// them as one word, and this character separates words (it isn't a letter or a
// number). A search for 需要 is then the phrase 需 要. It is invisible, and
// removed from the highlights anyway.
const zeroWidthSpace = "​"

func isCJK(r rune) bool {
	return unicode.In(r, unicode.Han, unicode.Hiragana, unicode.Katakana, unicode.Hangul)
}

// searchTerms is text as the index takes it: each character of Chinese,
// Japanese or Korean a word.
func searchTerms(text string) string {
	var b strings.Builder
	for _, r := range text {
		if isCJK(r) {
			b.WriteString(zeroWidthSpace)
			b.WriteRune(r)
			b.WriteString(zeroWidthSpace)
		} else {
			b.WriteRune(r)
		}
	}
	return b.String()
}

// terms returns the indexed form of an optional text, nil for nil.
func terms(text *string) *string {
	if text == nil {
		return nil
	}
	t := searchTerms(*text)
	return &t
}

// noteParam validates the note of a request: nil keeps the item's note, ""
// removes it.
func noteParam(note *string) (*string, error) {
	if note == nil {
		return nil, nil
	}
	n := strings.TrimSpace(*note)
	if utf8.RuneCountInString(n) > maxNoteLength {
		return nil, badRequest("invalid_note", fmt.Errorf("a note has at most %d characters", maxNoteLength))
	}
	return &n, nil
}

// nonEmpty is a stored note or title as the API returns it: none for ""
// (removed; NULL in an upsert would keep the old one).
func nonEmpty(text *string) *string {
	if text == nil || *text == "" {
		return nil
	}
	return text
}

// ftsQuery turns what the user typed into an FTS5 query: every word must
// match (in the repository, the title or the note), and the last one may be
// the start of a word, to search while typing. Quoted, words are taken
// literally rather than as FTS5's syntax (AND, OR, NOT, NEAR, column filters,
// -, ^). Empty when there is nothing to search for.
func ftsQuery(text string) string {
	var words []string
	for _, word := range strings.Fields(searchTerms(text)) {
		if !strings.ContainsFunc(word, func(r rune) bool { return unicode.IsLetter(r) || unicode.IsNumber(r) }) {
			continue
		}
		words = append(words, `"`+strings.ReplaceAll(word, `"`, `""`)+`"`)
	}
	if len(words) == 0 {
		return ""
	}
	words[len(words)-1] += "*"
	return strings.Join(words, " ")
}

// The note counts most, then the title, then the repository (weights of
// bm25(), which is lower for better matches). Highlights mark the matches
// with U+0002 and U+0003, and the note is cut to about 32 words around them.
const searchQuery = `SELECT k.kind, k.repo, k.number,
  highlight(search_index, 0, char(2), char(3)),
  highlight(search_index, 1, char(2), char(3)),
  snippet(search_index, 2, char(2), char(3), '…', 32)
FROM search_index JOIN search_keys k ON k.id = search_index.rowid
WHERE search_index MATCH ? AND k.login = ?
ORDER BY bm25(search_index, 1.0, 2.0, 4.0)
LIMIT ?`

// search handles GET /api/search?q=&limit=: the user's bookmarks and queued
// pull requests matching every word of q, best first.
func (s *Server) search(r *http.Request) (any, error) {
	u := userFrom(r.Context())
	q := r.URL.Query()
	limit := int64(defaultSearchLimit)
	if v := q.Get("limit"); v != "" {
		n, ok := parsePositive(v)
		if !ok || n > maxSearchLimit {
			return nil, badRequest("invalid_request", fmt.Errorf("limit must be between 1 and %d", maxSearchLimit))
		}
		limit = n
	}
	text := q.Get("q")
	if utf8.RuneCountInString(text) > maxSearchLength {
		return nil, badRequest("invalid_request", fmt.Errorf("search at most %d characters", maxSearchLength))
	}
	res := &treehubv1.SearchResponse{Results: []*treehubv1.SearchResult{}}
	match := ftsQuery(text)
	if match == "" {
		return res, nil
	}

	rows, err := s.DB.QueryContext(r.Context(), searchQuery, match, u.Login, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	visible := func(v sql.NullString) *string {
		if !v.Valid || v.String == "" {
			return nil
		}
		t := strings.ReplaceAll(v.String, zeroWidthSpace, "")
		return &t
	}
	for rows.Next() {
		var kind, repo string
		var number int64
		var repoMatch, titleMatch, noteMatch sql.NullString
		if err := rows.Scan(&kind, &repo, &number, &repoMatch, &titleMatch, &noteMatch); err != nil {
			return nil, err
		}
		result := &treehubv1.SearchResult{Kind: kind, Repo: repo, Number: int32(number), RepoMatch: repo,
			TitleMatch: visible(titleMatch), NoteMatch: visible(noteMatch)}
		if m := visible(repoMatch); m != nil {
			result.RepoMatch = *m
		}
		res.Results = append(res.Results, result)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	return res, nil
}
