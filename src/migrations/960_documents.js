// Documents: a per-tenant store for attachments and source files, linked to bills, purchase orders and invoices.
// Every tenant has its own database file, so this table is per tenant by construction.
// The legacy purchases_attachments rows are copied in (legacy_id keeps the copy idempotent); the old API keeps working.
export const id = '960_documents';

export function up(db) {
  db.exec(`
    CREATE TABLE documents_files (
      id INTEGER PRIMARY KEY,
      kind TEXT NOT NULL DEFAULT 'attachment' CHECK (kind IN ('attachment','source')),
      filename TEXT NOT NULL,
      mime TEXT NOT NULL,
      size INTEGER NOT NULL CHECK (size > 0),
      sha256 TEXT NOT NULL,
      data BLOB NOT NULL,
      status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','removed')),
      removed_reason TEXT,
      removed_by INTEGER,
      removed_at INTEGER,
      legacy_id INTEGER UNIQUE,
      uploaded_by INTEGER NOT NULL,
      created_at INTEGER NOT NULL
    );
    CREATE INDEX documents_files_sha ON documents_files(sha256);
    CREATE TABLE documents_links (
      id INTEGER PRIMARY KEY,
      document_id INTEGER NOT NULL REFERENCES documents_files(id),
      entity_type TEXT NOT NULL CHECK (entity_type IN ('bill','purchase_order','invoice')),
      entity_id INTEGER NOT NULL,
      linked_by INTEGER NOT NULL,
      created_at INTEGER NOT NULL,
      UNIQUE (document_id, entity_type, entity_id)
    );
    CREATE INDEX documents_links_entity ON documents_links(entity_type, entity_id);
    -- "Has a valid e-document": yes / no / unknown. UNVERIFIED rule: it is a manual flag, nothing checks the document with the ETA.
    CREATE TABLE documents_edoc_status (
      entity_type TEXT NOT NULL CHECK (entity_type IN ('bill','invoice')),
      entity_id INTEGER NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('yes','no','unknown')),
      note TEXT,
      set_by INTEGER NOT NULL,
      set_at INTEGER NOT NULL,
      PRIMARY KEY (entity_type, entity_id)
    );
    CREATE VIEW documents_files_export AS
      SELECT id, kind, filename, mime, size, sha256, hex(data) AS data_hex, status, removed_reason, removed_by, removed_at, legacy_id, uploaded_by, created_at FROM documents_files;
  `);
  // Backfill from the purchases attachments (the table may be missing in stripped-down fixtures).
  const has = db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='purchases_attachments'").get();
  if (has) {
    db.exec(`
      INSERT INTO documents_files (kind, filename, mime, size, sha256, data, legacy_id, uploaded_by, created_at)
        SELECT 'attachment', filename, mime, size, sha256, data, id, uploaded_by, created_at FROM purchases_attachments;
      INSERT INTO documents_links (document_id, entity_type, entity_id, linked_by, created_at)
        SELECT d.id, 'bill', a.bill_id, a.uploaded_by, a.created_at FROM purchases_attachments a JOIN documents_files d ON d.legacy_id = a.id;
    `);
  }
}
