-- v0.5: first settings store (spec §1.3). Generic key/value; value is JSON-encoded
-- TEXT. First key: notes.recencyMode ('recent'|'frecent', default 'frecent' when
-- absent — the absence-default lives in the query/hook layer, not a row). Reused by
-- #129 (e.g. rename.propagateOnRename).
CREATE TABLE app_settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
