-- v0.6 schema. Additive only. Mirrors video_sources (0002) for PDF metadata.
-- The note itself carries source_kind='pdf' + the hybrid source_locator JSON
-- (no notes-table migration); this table holds document-level metadata only.
CREATE TABLE pdf_documents (
  id           TEXT    PRIMARY KEY,            -- uuidv7
  sha256       TEXT    NOT NULL,               -- content hash of the .pdf bytes
  base_path    TEXT    NOT NULL,               -- abs path under userData/attachments/<yyyy>/<mm>/<sha>.pdf
  title        TEXT,                            -- PDF /Title metadata or filename fallback
  page_count   INTEGER,                         -- page count at import (pdf.js getDocument().numPages)
  imported_at  INTEGER NOT NULL,
  deleted_at   INTEGER
);
-- one row per distinct content (mirrors the partial-unique pattern in 0001_init.sql:16)
CREATE UNIQUE INDEX idx_pdf_documents_sha_live ON pdf_documents(sha256) WHERE deleted_at IS NULL;
CREATE INDEX idx_pdf_documents_title ON pdf_documents(title) WHERE deleted_at IS NULL;
