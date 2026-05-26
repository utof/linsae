-- v0.1 schema. Once shipped, NEVER edit this file. Add 0002_*.sql instead.

CREATE TABLE notes (
  id         TEXT    PRIMARY KEY,
  slug       TEXT    NOT NULL,
  body       TEXT    NOT NULL,
  type       TEXT    NOT NULL DEFAULT 'claim',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  deleted_at INTEGER,

  status         TEXT,
  source_kind    TEXT,
  source_locator TEXT
);
CREATE UNIQUE INDEX idx_notes_slug_live ON notes(slug) WHERE deleted_at IS NULL;
CREATE INDEX idx_notes_created_at ON notes(created_at) WHERE deleted_at IS NULL;

CREATE TABLE note_aliases (
  note_id TEXT NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
  alias   TEXT NOT NULL,
  PRIMARY KEY (note_id, alias)
);
CREATE INDEX idx_note_aliases_alias ON note_aliases(alias);

CREATE TABLE links (
  from_note_id TEXT NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
  to_slug      TEXT NOT NULL,
  edge_type    TEXT NOT NULL DEFAULT 'reference',
  PRIMARY KEY (from_note_id, to_slug, edge_type)
);
CREATE INDEX idx_links_to_slug ON links(to_slug);

CREATE TABLE note_revisions (
  id         TEXT    PRIMARY KEY,
  note_id    TEXT    NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
  body       TEXT    NOT NULL,
  type       TEXT    NOT NULL,
  saved_at   INTEGER NOT NULL,
  supersedes TEXT    REFERENCES note_revisions(id)
);
CREATE INDEX idx_note_revisions_note ON note_revisions(note_id, saved_at);

CREATE TABLE topic_paths (
  note_id TEXT NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
  path    TEXT NOT NULL,
  PRIMARY KEY (note_id, path)
);

CREATE TABLE note_actions (
  id         TEXT    PRIMARY KEY,
  note_id    TEXT    NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
  type       TEXT    NOT NULL,
  label      TEXT,
  status     TEXT    NOT NULL DEFAULT 'open',
  created_at INTEGER NOT NULL,
  done_at    INTEGER
);
CREATE INDEX idx_note_actions_status ON note_actions(status, note_id);

CREATE VIRTUAL TABLE notes_fts USING fts5(
  body, content='notes', content_rowid='rowid'
);

CREATE TRIGGER notes_ai AFTER INSERT ON notes BEGIN
  INSERT INTO notes_fts(rowid, body) VALUES (new.rowid, new.body);
END;
CREATE TRIGGER notes_ad AFTER DELETE ON notes BEGIN
  INSERT INTO notes_fts(notes_fts, rowid, body) VALUES('delete', old.rowid, old.body);
END;
CREATE TRIGGER notes_au AFTER UPDATE ON notes BEGIN
  INSERT INTO notes_fts(notes_fts, rowid, body) VALUES('delete', old.rowid, old.body);
  INSERT INTO notes_fts(rowid, body) VALUES (new.rowid, new.body);
END;

CREATE TABLE _migrations (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  applied_at INTEGER NOT NULL
);
