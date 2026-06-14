-- v0.5: add the slug column + prefix index to notes_fts so content search can
-- bm25-weight title (slug) hits above body-only hits (spec §1.1). External-content
-- FTS5 cannot ALTER in a column; the documented path is DROP + recreate + rebuild.
-- slug is NOT NULL + pre-populated (save-note.ts writes it every save), so the
-- in-SQL rebuild reads slug+body cleanly — no NULL-title / backfill-ordering risk.
-- @see https://www.sqlite.org/fts5.html#external_content_tables
-- @see src/main/db/migrations/0001_init.sql (the original notes_fts + triggers)

DROP TRIGGER IF EXISTS notes_ai;
DROP TRIGGER IF EXISTS notes_ad;
DROP TRIGGER IF EXISTS notes_au;
DROP TABLE IF EXISTS notes_fts;

CREATE VIRTUAL TABLE notes_fts USING fts5(
  slug, body, content='notes', content_rowid='rowid', prefix='2 3'
);

CREATE TRIGGER notes_ai AFTER INSERT ON notes BEGIN
  INSERT INTO notes_fts(rowid, slug, body) VALUES (new.rowid, new.slug, new.body);
END;
CREATE TRIGGER notes_ad AFTER DELETE ON notes BEGIN
  INSERT INTO notes_fts(notes_fts, rowid, slug, body) VALUES('delete', old.rowid, old.slug, old.body);
END;
CREATE TRIGGER notes_au AFTER UPDATE ON notes BEGIN
  INSERT INTO notes_fts(notes_fts, rowid, slug, body) VALUES('delete', old.rowid, old.slug, old.body);
  INSERT INTO notes_fts(rowid, slug, body) VALUES (new.rowid, new.slug, new.body);
END;

-- Repopulate the index from existing rows (reads slug+body from notes).
INSERT INTO notes_fts(notes_fts) VALUES('rebuild');
