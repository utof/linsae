-- v0.5: DB-only access log (spec §1.2). Bumped on openThread ∪ edit ∪ jump. NOT
-- reconciled (purely app state, like layouts) — survives with the DB, absent from
-- the markdown files. ON DELETE CASCADE drops it with the note.
CREATE TABLE note_access (
  note_id          TEXT    PRIMARY KEY REFERENCES notes(id) ON DELETE CASCADE,
  last_accessed_at INTEGER NOT NULL,
  frequency        INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX idx_note_access_recency ON note_access(last_accessed_at);
