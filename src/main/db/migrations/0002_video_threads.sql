-- v0.2 schema. 0001_init.sql is frozen and untouched. Additive only.

-- Cached video metadata, populated via YouTube oEmbed on first embed.
-- title is denormalised so "screenshots from videos titled X" is one indexed
-- LIKE with no network call.
CREATE TABLE video_sources (
  video_id      TEXT PRIMARY KEY,           -- 11-char YouTube id (future: local uuid)
  source_kind   TEXT NOT NULL,              -- 'youtube' | 'local'
  title         TEXT,
  channel       TEXT,
  thumbnail_url TEXT,
  duration_sec  INTEGER,                    -- nullable; oEmbed omits duration
  fetched_at    INTEGER NOT NULL,
  CHECK (source_kind IN ('youtube', 'local'))
);
CREATE INDEX idx_video_sources_title ON video_sources(title);

-- Captured frames (v0.2.0) and, later, drawn overlays + clips (v0.2.x).
-- note_id NULL = orphan (captured but not yet attached to a comment-note).
CREATE TABLE attachments (
  id                 TEXT PRIMARY KEY,       -- uuidv7
  note_id            TEXT,                   -- nullable FK; NULL = orphan
  kind               TEXT NOT NULL,          -- 'screenshot' (v0.2.0) | 'clip' (future)
  base_sha256        TEXT NOT NULL,          -- hash of the immutable PNG bytes
  base_path          TEXT NOT NULL,          -- absolute path under userData/attachments/…
  overlay_path       TEXT,                   -- v0.2.x: path to <hash>.svg sidecar; NULL until drawn
  video_id           TEXT,                   -- denormalised; joins to video_sources
  time_seconds       REAL,                   -- playback time the frame was captured at
  width_px           INTEGER NOT NULL,       -- physical pixels in the PNG
  height_px          INTEGER NOT NULL,
  device_pixel_ratio REAL    NOT NULL DEFAULT 1,
  created_at         INTEGER NOT NULL,
  deleted_at         INTEGER,
  CHECK (kind IN ('screenshot', 'clip')),    -- 'clip' provisioned now; CHECK is costly to alter later
  FOREIGN KEY (note_id) REFERENCES notes(id) ON DELETE SET NULL
);
CREATE INDEX idx_attachments_note_id     ON attachments(note_id)     WHERE deleted_at IS NULL;
CREATE INDEX idx_attachments_video_id    ON attachments(video_id)    WHERE deleted_at IS NULL;
CREATE INDEX idx_attachments_base_sha256 ON attachments(base_sha256) WHERE deleted_at IS NULL;
CREATE INDEX idx_attachments_orphans     ON attachments(created_at)  WHERE note_id IS NULL AND deleted_at IS NULL;
