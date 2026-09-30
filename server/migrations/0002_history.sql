-- History of the repositories and pull requests each user viewed on GitHub, and its per-user settings.

-- One row per repository or pull request, updated on every view. Timestamps are RFC 3339 UTC with
-- milliseconds, written by the Worker, so they sort chronologically as text.
CREATE TABLE history (
  login TEXT NOT NULL REFERENCES users(login) ON UPDATE CASCADE ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('repo', 'pull')),
  repo TEXT NOT NULL COLLATE NOCASE, -- "owner/name"
  number INTEGER NOT NULL DEFAULT 0, -- pull request number, 0 for a repository
  title TEXT,
  first_viewed_at TEXT NOT NULL,
  last_viewed_at TEXT NOT NULL,
  view_count INTEGER NOT NULL DEFAULT 1,
  PRIMARY KEY (login, kind, repo, number)
);
-- The listing and its cursor: most recently viewed first
CREATE INDEX history_recent ON history (login, last_viewed_at DESC, kind DESC, repo DESC, number DESC);

-- Rows last viewed more than history_retention_days ago are hidden and pruned; nothing is recorded while
-- history_paused is 1.
ALTER TABLE users ADD COLUMN history_retention_days INTEGER NOT NULL DEFAULT 30;
ALTER TABLE users ADD COLUMN history_paused INTEGER NOT NULL DEFAULT 0;
