import { createHash } from 'node:crypto';
import { AppError } from '../../errors.js';
import { audit, tx } from '../../ledger.js';
import { requirePerm } from '../../permissions.js';
import { setting } from '../../db.js';

// Per-tenant document store. Bytes live in SQLite (one database file per tenant), so isolation is by construction.
export const MAX_BYTES_DEFAULT = 512 * 1024;   // overridable with the setting documents_max_bytes (the request body is capped at 1 MB)
export const MAX_BYTES_CEILING = 700 * 1024;   // base64 of this still fits the 1 MB body limit
export const MAX_PER_ENTITY = 10;
export const ENTITY_TYPES = { bill: 'bills', purchase_order: 'purchases_orders', invoice: 'invoices' };
export const EDOC_TYPES = ['bill', 'invoice'];
export const EDOC_VALUES = ['yes', 'no', 'unknown'];
export const KINDS = ['attachment', 'source'];
const isJson = (b) => { try { JSON.parse(b.toString('utf8')); return true; } catch { return false; } };
export const ALLOWED_MIME = {
  'application/pdf': (b) => b.subarray(0, 5).toString('latin1') === '%PDF-',
  'image/png': (b) => b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])),
  'image/jpeg': (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff,
  'image/webp': (b) => b.subarray(0, 4).toString('latin1') === 'RIFF' && b.subarray(8, 12).toString('latin1') === 'WEBP',
  'text/plain': (b) => !b.includes(0),
  'text/csv': (b) => !b.includes(0),
  'application/json': isJson,                                            // source files such as an e-invoice JSON
  'application/xml': (b) => b.toString('utf8', 0, 200).trimStart().startsWith('<'),
};

const META = 'id, kind, filename, mime, size, sha256, status, uploaded_by, created_at';

function safeName(name) {
  if (typeof name !== 'string') throw new AppError(400, 'BAD_INPUT', 'filename is required');
  const base = name.split(/[\\/]/).pop().replace(/[^\p{L}\p{N}._ -]/gu, '_').trim().slice(0, 120);
  if (!base || /^\.+$/.test(base)) throw new AppError(400, 'BAD_INPUT', 'filename is not valid');
  return base;
}

export function maxBytes(db) {
  const v = Number(setting(db, 'documents_max_bytes') ?? MAX_BYTES_DEFAULT);
  return Number.isInteger(v) && v > 0 ? Math.min(v, MAX_BYTES_CEILING) : MAX_BYTES_DEFAULT;
}

export function limits(ctx, user) {
  requirePerm(user, 'documents.view');
  return { maxBytes: maxBytes(ctx.db), maxPerEntity: MAX_PER_ENTITY, mimeTypes: Object.keys(ALLOWED_MIME), entityTypes: Object.keys(ENTITY_TYPES), kinds: KINDS };
}

function checkEntity(db, type, id) {
  if (!ENTITY_TYPES[type]) throw new AppError(400, 'BAD_INPUT', `entityType must be one of ${Object.keys(ENTITY_TYPES).join(', ')}`);
  if (!Number.isInteger(id) || id <= 0) throw new AppError(400, 'BAD_INPUT', 'entityId must be a positive whole number');
  if (!db.prepare(`SELECT 1 FROM ${ENTITY_TYPES[type]} WHERE id = ?`).get(id)) throw new AppError(404, 'NOT_FOUND', `${type} ${id} not found`);
}

/** Copy attachments added through the old purchases API since the last copy. Idempotent. */
export function syncLegacy(ctx) {
  const { db } = ctx;
  if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='purchases_attachments'").get()) return 0;
  const rows = db.prepare('SELECT * FROM purchases_attachments a WHERE NOT EXISTS (SELECT 1 FROM documents_files d WHERE d.legacy_id = a.id)').all();
  if (!rows.length) return 0;
  tx(db, () => {
    for (const a of rows) {
      const res = db.prepare("INSERT INTO documents_files (kind, filename, mime, size, sha256, data, legacy_id, uploaded_by, created_at) VALUES ('attachment',?,?,?,?,?,?,?,?)")
        .run(a.filename, a.mime, a.size, a.sha256, a.data, a.id, a.uploaded_by, a.created_at);
      db.prepare("INSERT INTO documents_links (document_id, entity_type, entity_id, linked_by, created_at) VALUES (?,'bill',?,?,?)").run(Number(res.lastInsertRowid), a.bill_id, a.uploaded_by, a.created_at);
    }
  });
  return rows.length;
}

export function listDocuments(ctx, user, query = {}) {
  requirePerm(user, 'documents.view');
  syncLegacy(ctx);
  const { db } = ctx;
  if (query.entityType != null || query.entityId != null) {
    const id = Number(query.entityId);
    checkEntity(db, String(query.entityType), id);
    return db.prepare(`SELECT ${META.replace(/(\w+)/g, 'd.$1')}, l.entity_type, l.entity_id FROM documents_files d JOIN documents_links l ON l.document_id = d.id
      WHERE l.entity_type = ? AND l.entity_id = ? AND d.status = 'active' ORDER BY d.id`).all(String(query.entityType), id);
  }
  return db.prepare(`SELECT ${META} FROM documents_files WHERE status = 'active' ORDER BY id DESC LIMIT 200`).all();
}

export function addDocument(ctx, user, input = {}) {
  requirePerm(user, 'documents.upload');
  const { db } = ctx;
  const kind = input.kind ?? 'attachment';
  if (!KINDS.includes(kind)) throw new AppError(400, 'BAD_INPUT', `kind must be one of ${KINDS.join(', ')}`);
  const entityId = Number(input.entityId);
  checkEntity(db, input.entityType, entityId);
  const check = ALLOWED_MIME[input.mime];
  if (!check) throw new AppError(415, 'MIME_NOT_ALLOWED', `File type not allowed; use one of ${Object.keys(ALLOWED_MIME).join(', ')}`);
  if (typeof input.contentBase64 !== 'string' || !input.contentBase64.length || !/^[A-Za-z0-9+/]*={0,2}$/.test(input.contentBase64)) {
    throw new AppError(400, 'BAD_INPUT', 'contentBase64 must be base64 data');
  }
  const max = maxBytes(db);
  if (Math.floor((input.contentBase64.length * 3) / 4) > max + 3) throw new AppError(413, 'FILE_TOO_LARGE', `File is larger than ${max} bytes`);
  const data = Buffer.from(input.contentBase64, 'base64');
  if (data.length > max) throw new AppError(413, 'FILE_TOO_LARGE', `File is larger than ${max} bytes`);
  if (!data.length) throw new AppError(400, 'BAD_INPUT', 'File is empty');
  if (!check(data)) throw new AppError(415, 'CONTENT_MISMATCH', 'The file content does not match its declared type');
  const filename = safeName(input.filename);
  const sha = createHash('sha256').update(data).digest('hex');
  syncLegacy(ctx);
  return tx(db, () => {
    const count = db.prepare("SELECT COUNT(*) n FROM documents_links l JOIN documents_files d ON d.id = l.document_id WHERE l.entity_type = ? AND l.entity_id = ? AND d.status = 'active'").get(input.entityType, entityId).n;
    if (count >= MAX_PER_ENTITY) throw new AppError(409, 'TOO_MANY_DOCUMENTS', `A ${input.entityType} can hold at most ${MAX_PER_ENTITY} documents`);
    const dup = db.prepare("SELECT d.id FROM documents_files d JOIN documents_links l ON l.document_id = d.id WHERE d.sha256 = ? AND l.entity_type = ? AND l.entity_id = ? AND d.status = 'active'").get(sha, input.entityType, entityId);
    if (dup) throw new AppError(409, 'DUPLICATE_DOCUMENT', `The same file is already attached (document ${dup.id})`);
    const res = db.prepare('INSERT INTO documents_files (kind, filename, mime, size, sha256, data, uploaded_by, created_at) VALUES (?,?,?,?,?,?,?,?)')
      .run(kind, filename, input.mime, data.length, sha, data, user.id, ctx.now());
    const id = Number(res.lastInsertRowid);
    db.prepare('INSERT INTO documents_links (document_id, entity_type, entity_id, linked_by, created_at) VALUES (?,?,?,?,?)').run(id, input.entityType, entityId, user.id, ctx.now());
    audit(ctx, { userId: user.id, action: 'document.added', type: 'document', id, newValue: { entityType: input.entityType, entityId, filename, mime: input.mime, size: data.length, sha256: sha, kind } });
    return { id, size: data.length, sha256: sha };
  });
}

function getRow(db, id) {
  const d = db.prepare('SELECT * FROM documents_files WHERE id = ?').get(id);
  if (!d || d.status !== 'active') throw new AppError(404, 'NOT_FOUND', 'Document not found');
  return d;
}

export function getDocument(ctx, user, id) {
  requirePerm(user, 'documents.view');
  syncLegacy(ctx);
  const d = getRow(ctx.db, id);
  const links = ctx.db.prepare('SELECT entity_type, entity_id FROM documents_links WHERE document_id = ? ORDER BY id').all(id);
  return { id: d.id, kind: d.kind, filename: d.filename, mime: d.mime, size: d.size, sha256: d.sha256, uploaded_by: d.uploaded_by, created_at: d.created_at, links };
}

export function getContent(ctx, user, id) {
  requirePerm(user, 'documents.view');
  syncLegacy(ctx);
  const d = getRow(ctx.db, id);
  const sha = createHash('sha256').update(d.data).digest('hex');
  return { id: d.id, filename: d.filename, mime: d.mime, size: d.size, sha256: d.sha256, intact: sha === d.sha256, contentBase64: Buffer.from(d.data).toString('base64') };
}

export function linkDocument(ctx, user, id, input = {}) {
  requirePerm(user, 'documents.upload');
  const { db } = ctx;
  getRow(db, id);
  const entityId = Number(input.entityId);
  checkEntity(db, input.entityType, entityId);
  return tx(db, () => {
    if (db.prepare('SELECT 1 FROM documents_links WHERE document_id = ? AND entity_type = ? AND entity_id = ?').get(id, input.entityType, entityId)) {
      throw new AppError(409, 'ALREADY_LINKED', 'The document is already linked to it');
    }
    const n = db.prepare("SELECT COUNT(*) n FROM documents_links l JOIN documents_files d ON d.id = l.document_id WHERE l.entity_type = ? AND l.entity_id = ? AND d.status = 'active'").get(input.entityType, entityId).n;
    if (n >= MAX_PER_ENTITY) throw new AppError(409, 'TOO_MANY_DOCUMENTS', `A ${input.entityType} can hold at most ${MAX_PER_ENTITY} documents`);
    db.prepare('INSERT INTO documents_links (document_id, entity_type, entity_id, linked_by, created_at) VALUES (?,?,?,?,?)').run(id, input.entityType, entityId, user.id, ctx.now());
    audit(ctx, { userId: user.id, action: 'document.linked', type: 'document', id, newValue: { entityType: input.entityType, entityId } });
    return { id, linked: true };
  });
}

/** Soft remove (the bytes are wiped, the audit row and hash stay). A reason is required. */
export function removeDocument(ctx, user, id, input = {}) {
  requirePerm(user, 'documents.manage');
  const reason = typeof input.reason === 'string' ? input.reason.trim().slice(0, 300) : '';
  if (!reason) throw new AppError(400, 'BAD_INPUT', 'A reason is required');
  const { db } = ctx;
  const d = getRow(db, id);
  return tx(db, () => {
    db.prepare("UPDATE documents_files SET status = 'removed', removed_reason = ?, removed_by = ?, removed_at = ?, data = x'00' WHERE id = ?").run(reason, user.id, ctx.now(), id);
    audit(ctx, { userId: user.id, action: 'document.removed', type: 'document', id, oldValue: { filename: d.filename, sha256: d.sha256 }, reason });
    return { id, removed: true };
  });
}

export function getEdoc(ctx, user, query = {}) {
  requirePerm(user, 'documents.view');
  const id = Number(query.entityId);
  if (!EDOC_TYPES.includes(query.entityType)) throw new AppError(400, 'BAD_INPUT', `entityType must be one of ${EDOC_TYPES.join(', ')}`);
  checkEntity(ctx.db, query.entityType, id);
  const row = ctx.db.prepare('SELECT status, note, set_by, set_at FROM documents_edoc_status WHERE entity_type = ? AND entity_id = ?').get(query.entityType, id);
  return { entityType: query.entityType, entityId: id, status: row?.status ?? 'unknown', note: row?.note ?? null, setBy: row?.set_by ?? null, setAt: row?.set_at ?? null, rule: EDOC_RULE };
}

/** UNVERIFIED rule: the "valid e-document" flag is set by a person; nothing here validates it against the ETA. */
export const EDOC_RULE = 'UNVERIFIED: whether an expense needs a valid e-document (e-invoice or e-receipt) to be accepted for tax is not confirmed with the ETA or counsel. This flag is a manual note, not a check.';

export function setEdoc(ctx, user, input = {}) {
  requirePerm(user, 'documents.upload');
  const id = Number(input.entityId);
  if (!EDOC_TYPES.includes(input.entityType)) throw new AppError(400, 'BAD_INPUT', `entityType must be one of ${EDOC_TYPES.join(', ')}`);
  if (!EDOC_VALUES.includes(input.status)) throw new AppError(400, 'BAD_INPUT', `status must be one of ${EDOC_VALUES.join(', ')}`);
  checkEntity(ctx.db, input.entityType, id);
  const note = typeof input.note === 'string' && input.note.trim() ? input.note.trim().slice(0, 300) : null;
  return tx(ctx.db, () => {
    const old = ctx.db.prepare('SELECT status, note FROM documents_edoc_status WHERE entity_type = ? AND entity_id = ?').get(input.entityType, id);
    ctx.db.prepare(`INSERT INTO documents_edoc_status (entity_type, entity_id, status, note, set_by, set_at) VALUES (?,?,?,?,?,?)
      ON CONFLICT (entity_type, entity_id) DO UPDATE SET status = excluded.status, note = excluded.note, set_by = excluded.set_by, set_at = excluded.set_at`)
      .run(input.entityType, id, input.status, note, user.id, ctx.now());
    audit(ctx, { userId: user.id, action: 'document.edoc_set', type: input.entityType, id, oldValue: old ?? { status: 'unknown' }, newValue: { status: input.status, note } });
    return { entityType: input.entityType, entityId: id, status: input.status, rule: EDOC_RULE };
  });
}

export const widgets = (ctx, user) => {
  if (!user.permissions.has('documents.view')) return {};
  const r = ctx.db.prepare("SELECT COUNT(*) n, COALESCE(SUM(size),0) bytes FROM documents_files WHERE status = 'active'").get();
  return { documents: { count: r.n, bytes: r.bytes } };
};
