-- Notes on bookmarked repositories and queued pull requests, and a full-text index to search the bookmarks and the
-- queue: their repository, title and note, ranked with BM25 (bm25() of FTS5).
--
-- Triggers keep the index up to date, so that writes cost the Worker no more statements (CPU time is short on the
-- Workers free plan). The columns *_terms hold what is indexed: the text as the server prepares it, with the
-- characters of Chinese, Japanese and Korean separated, which the tokenizer would take as one word.

ALTER TABLE bookmarks ADD COLUMN note TEXT;
ALTER TABLE bookmarks ADD COLUMN note_terms TEXT;
ALTER TABLE queue_items ADD COLUMN note TEXT;
ALTER TABLE queue_items ADD COLUMN note_terms TEXT;
ALTER TABLE queue_items ADD COLUMN title_terms TEXT;

-- The rows of search_index, one per bookmark or queued pull request: id is the rowid of the item's row there.
CREATE TABLE search_keys (
  id INTEGER PRIMARY KEY,
  kind TEXT NOT NULL, -- "bookmark" or "queue"
  login TEXT NOT NULL COLLATE NOCASE,
  repo TEXT NOT NULL COLLATE NOCASE,
  number INTEGER NOT NULL, -- 0 for a bookmark
  UNIQUE (kind, login, repo, number)
);

CREATE VIRTUAL TABLE search_index USING fts5(
  repo, title, note,
  tokenize = 'porter unicode61 remove_diacritics 2'
);

-- What there is already (without notes)
UPDATE queue_items SET title_terms = title;
INSERT INTO search_keys (kind, login, repo, number) SELECT 'bookmark', login, repo, 0 FROM bookmarks;
INSERT INTO search_keys (kind, login, repo, number) SELECT 'queue', login, repo, number FROM queue_items;
INSERT INTO search_index (rowid, repo, title, note)
  SELECT k.id, k.repo, q.title_terms, NULL
  FROM search_keys k
  LEFT JOIN queue_items q ON k.kind = 'queue' AND q.login = k.login AND q.repo = k.repo AND q.number = k.number;

-- Bookmarks. Updates of other columns (none yet) don't reindex.
CREATE TRIGGER bookmarks_search_insert AFTER INSERT ON bookmarks BEGIN
  INSERT INTO search_keys (kind, login, repo, number) VALUES ('bookmark', new.login, new.repo, 0);
  INSERT INTO search_index (rowid, repo, title, note) VALUES (last_insert_rowid(), new.repo, NULL, new.note_terms);
END;

CREATE TRIGGER bookmarks_search_update AFTER UPDATE OF login, repo, note_terms ON bookmarks BEGIN
  UPDATE search_keys SET login = new.login, repo = new.repo
    WHERE kind = 'bookmark' AND login = old.login AND repo = old.repo;
  DELETE FROM search_index
    WHERE rowid = (SELECT id FROM search_keys WHERE kind = 'bookmark' AND login = new.login AND repo = new.repo);
  INSERT INTO search_index (rowid, repo, title, note)
    SELECT id, new.repo, NULL, new.note_terms
    FROM search_keys WHERE kind = 'bookmark' AND login = new.login AND repo = new.repo;
END;

CREATE TRIGGER bookmarks_search_delete AFTER DELETE ON bookmarks BEGIN
  DELETE FROM search_index
    WHERE rowid = (SELECT id FROM search_keys WHERE kind = 'bookmark' AND login = old.login AND repo = old.repo);
  DELETE FROM search_keys WHERE kind = 'bookmark' AND login = old.login AND repo = old.repo;
END;

-- Queued pull requests. Marking one seen (last_seen_at) doesn't reindex.
CREATE TRIGGER queue_items_search_insert AFTER INSERT ON queue_items BEGIN
  INSERT INTO search_keys (kind, login, repo, number) VALUES ('queue', new.login, new.repo, new.number);
  INSERT INTO search_index (rowid, repo, title, note)
    VALUES (last_insert_rowid(), new.repo, new.title_terms, new.note_terms);
END;

CREATE TRIGGER queue_items_search_update AFTER UPDATE OF login, repo, title_terms, note_terms ON queue_items BEGIN
  UPDATE search_keys SET login = new.login, repo = new.repo
    WHERE kind = 'queue' AND login = old.login AND repo = old.repo AND number = old.number;
  DELETE FROM search_index
    WHERE rowid = (SELECT id FROM search_keys
                   WHERE kind = 'queue' AND login = new.login AND repo = new.repo AND number = new.number);
  INSERT INTO search_index (rowid, repo, title, note)
    SELECT id, new.repo, new.title_terms, new.note_terms
    FROM search_keys WHERE kind = 'queue' AND login = new.login AND repo = new.repo AND number = new.number;
END;

CREATE TRIGGER queue_items_search_delete AFTER DELETE ON queue_items BEGIN
  DELETE FROM search_index
    WHERE rowid = (SELECT id FROM search_keys
                   WHERE kind = 'queue' AND login = old.login AND repo = old.repo AND number = old.number);
  DELETE FROM search_keys WHERE kind = 'queue' AND login = old.login AND repo = old.repo AND number = old.number;
END;
