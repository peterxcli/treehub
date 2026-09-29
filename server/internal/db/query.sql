-- Queries compiled by sqlc (see sqlc.yaml). Engine: SQLite (Cloudflare D1).
-- Timestamps are RFC 3339 UTC strings, the same format as the column defaults.

-- ---------- users ----------

-- name: GetUserByGithubID :one
SELECT * FROM users WHERE github_id = ?;

-- name: GetUserByLogin :one
SELECT * FROM users WHERE login = ?;

-- New accounts start at a random token version (see auth.NewTokenVersion).
-- name: InsertUser :exec
INSERT INTO users (login, github_id, token_version) VALUES (?, ?, ?);

-- Moves the account (and, through ON UPDATE CASCADE, its bookmarks and queue)
-- to another handle.
-- name: RenameUser :exec
UPDATE users SET login = ? WHERE github_id = ?;

-- name: TouchUserLogin :one
UPDATE users
SET name = ?,
    avatar_url = ?,
    last_login_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now')
WHERE github_id = ?
RETURNING *;

-- Revokes every session issued so far (they carry the old version).
-- name: BumpTokenVersion :exec
UPDATE users SET token_version = token_version + 1 WHERE github_id = ?;

-- Deletes the account; ON DELETE CASCADE removes its bookmarks and queue.
-- name: DeleteUser :exec
DELETE FROM users WHERE github_id = ?;

-- ---------- bookmarks ----------

-- rowid breaks ties between rows created in the same second.
-- name: ListBookmarks :many
SELECT * FROM bookmarks WHERE login = ? ORDER BY created_at DESC, rowid DESC;

-- name: GetBookmark :one
SELECT * FROM bookmarks WHERE login = ? AND repo = ?;

-- name: CountBookmarks :one
SELECT COUNT(*) FROM bookmarks WHERE login = ?;

-- An existing row keeps its created_at; only the spelling of the repo follows the request.
-- name: UpsertBookmark :one
INSERT INTO bookmarks (login, repo) VALUES (?, ?)
ON CONFLICT (login, repo) DO UPDATE SET repo = excluded.repo
RETURNING *;

-- name: DeleteBookmark :exec
DELETE FROM bookmarks WHERE login = ? AND repo = ?;

-- ---------- review queue ----------

-- name: ListQueueItems :many
SELECT * FROM queue_items WHERE login = ? ORDER BY added_at DESC, rowid DESC;

-- name: GetQueueItem :one
SELECT * FROM queue_items WHERE login = ? AND repo = ? AND number = ?;

-- name: CountQueueItems :one
SELECT COUNT(*) FROM queue_items WHERE login = ?;

-- Used when the request carries a title.
-- name: UpsertQueueItem :one
INSERT INTO queue_items (login, repo, number, title) VALUES (?, ?, ?, ?)
ON CONFLICT (login, repo, number) DO UPDATE SET repo = excluded.repo, title = excluded.title
RETURNING *;

-- Used when the request has no title: a queued item keeps the one it has.
-- name: EnsureQueueItem :one
INSERT INTO queue_items (login, repo, number) VALUES (?, ?, ?)
ON CONFLICT (login, repo, number) DO UPDATE SET repo = excluded.repo
RETURNING *;

-- name: MarkQueueItemSeen :one
UPDATE queue_items
SET last_seen_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now')
WHERE login = ? AND repo = ? AND number = ?
RETURNING *;

-- name: DeleteQueueItem :exec
DELETE FROM queue_items WHERE login = ? AND repo = ? AND number = ?;
