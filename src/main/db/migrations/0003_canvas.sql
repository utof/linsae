-- v0.4 canvas. Layouts are view-state: positions live here, never on notes.
-- canvas_id/arrangement_id are opaque text keys, constant in v0.4
-- ('root'/'manual') — see docs/canvas-vision.md principles 3 & 4.
CREATE TABLE node_layouts (
  canvas_id      TEXT    NOT NULL,
  arrangement_id TEXT    NOT NULL DEFAULT 'manual',
  note_id        TEXT    NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
  x              REAL,            -- NULL = on the shelf (queued, unplaced)
  y              REAL,
  created_at     INTEGER NOT NULL,
  placed_at      INTEGER,         -- NULL while shelved
  updated_at     INTEGER NOT NULL,
  PRIMARY KEY (canvas_id, arrangement_id, note_id),
  CHECK ((x IS NULL) = (y IS NULL))
);
-- no extra canvas index: the PK already serves the (canvas_id, arrangement_id) prefix

CREATE TABLE canvas_state (
  canvas_id  TEXT    PRIMARY KEY,
  camera_x   REAL    NOT NULL DEFAULT 0,
  camera_y   REAL    NOT NULL DEFAULT 0,
  zoom       REAL    NOT NULL DEFAULT 1,
  updated_at INTEGER NOT NULL
);
