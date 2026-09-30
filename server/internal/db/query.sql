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

-- Moves the account (and, through ON UPDATE CASCADE, its bookmarks, queue and
-- history) to another handle.
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

-- Deletes the account; ON DELETE CASCADE removes its bookmarks, queue and history.
-- name: DeleteUser :exec
DELETE FROM users WHERE github_id = ?;

-- name: SetHistorySettings :one
UPDATE users SET history_retention_days = ?, history_paused = ? WHERE github_id = ?
RETURNING *;

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

-- ---------- history ----------
-- The Worker passes the timestamps (RFC 3339 UTC with milliseconds) instead of
-- using SQLite's clock: milliseconds keep quick views in order, and the
-- retention cutoffs come from the same clock, which tests can move.

-- A view without a title: a new row starts with both times at viewed_at and
-- view_count 1; a known one counts the view, moves last_viewed_at, keeps its
-- title and takes the request's spelling of the repo.
-- name: RecordView :one
INSERT INTO history (login, kind, repo, number, first_viewed_at, last_viewed_at)
VALUES (@login, @kind, @repo, @number, @viewed_at, @viewed_at)
ON CONFLICT (login, kind, repo, number) DO UPDATE SET
  repo = excluded.repo,
  last_viewed_at = excluded.last_viewed_at,
  view_count = history.view_count + 1
RETURNING *;

-- The same with a title from the request, which replaces the stored one.
-- name: RecordViewWithTitle :one
INSERT INTO history (login, kind, repo, number, title, first_viewed_at, last_viewed_at)
VALUES (@login, @kind, @repo, @number, @title, @viewed_at, @viewed_at)
ON CONFLICT (login, kind, repo, number) DO UPDATE SET
  repo = excluded.repo,
  title = excluded.title,
  last_viewed_at = excluded.last_viewed_at,
  view_count = history.view_count + 1
RETURNING *;

-- The first page, last viewed first. Rows last viewed before since (the
-- retention) are left out even if they are not pruned yet. An empty kind lists
-- both kinds; written this way SQLite still reads history_recent in order,
-- while a plain "kind = ?" makes it sort part of the result in a temporary B-tree.
-- name: ListHistory :many
SELECT * FROM history
WHERE login = @login AND last_viewed_at >= @since AND (kind = @kind OR @kind = '')
ORDER BY last_viewed_at DESC, kind DESC, repo DESC, number DESC
LIMIT @page_size;

-- The page after a cursor (the last row of the previous page). The row value
-- comparison lets SQLite seek history_recent straight to the cursor. sqlc types
-- all its parameters like the first column (text); SQLite still compares
-- after_number as an integer (the column's affinity).
-- name: ListHistoryAfter :many
SELECT * FROM history
WHERE login = @login AND last_viewed_at >= @since AND (kind = @kind OR @kind = '')
  AND (last_viewed_at, kind, repo, number) < (@after_viewed_at, @after_kind, @after_repo, @after_number)
ORDER BY last_viewed_at DESC, kind DESC, repo DESC, number DESC
LIMIT @page_size;

-- Deletes the rows last viewed before the retention.
-- name: PruneHistory :exec
DELETE FROM history WHERE login = @login AND last_viewed_at < @before;

-- Keeps the user's max_rows most recently viewed rows and deletes the others.
-- name: TrimHistory :exec
DELETE FROM history WHERE rowid IN (
  SELECT h.rowid FROM history AS h WHERE h.login = @login
  ORDER BY h.last_viewed_at DESC, h.kind DESC, h.repo DESC, h.number DESC
  LIMIT -1 OFFSET @max_rows
);

-- name: DeleteHistoryItem :exec
DELETE FROM history WHERE login = ? AND kind = ? AND repo = ? AND number = ?;

-- name: ClearHistory :exec
DELETE FROM history WHERE login = ?;
