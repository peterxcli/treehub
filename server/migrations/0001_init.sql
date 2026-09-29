-- TreeHub accounts, bookmarks and review queue. D1 (SQLite) enforces foreign keys.

-- Users who signed in with GitHub. The handle (login) is the identifier; github_id is kept so
-- that a renamed GitHub account keeps its data (the login is updated and cascades).
CREATE TABLE users (
  login TEXT PRIMARY KEY COLLATE NOCASE,
  github_id INTEGER NOT NULL UNIQUE,
  name TEXT,
  avatar_url TEXT,
  -- Bumped to revoke every session of the user ("sign out everywhere").
  token_version INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
  last_login_at TEXT
);

CREATE TABLE bookmarks (
  login TEXT NOT NULL REFERENCES users(login) ON UPDATE CASCADE ON DELETE CASCADE,
  repo TEXT NOT NULL COLLATE NOCASE, -- "owner/name"
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
  PRIMARY KEY (login, repo)
);

CREATE TABLE queue_items (
  login TEXT NOT NULL REFERENCES users(login) ON UPDATE CASCADE ON DELETE CASCADE,
  repo TEXT NOT NULL COLLATE NOCASE, -- "owner/name"
  number INTEGER NOT NULL,
  title TEXT,
  added_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
  last_seen_at TEXT,
  PRIMARY KEY (login, repo, number)
);
