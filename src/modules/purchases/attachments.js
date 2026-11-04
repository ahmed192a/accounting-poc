import { createHash } from 'node:crypto';
import { AppError } from '../../errors.js';
import { audit, tx } from '../../ledger.js';
import { requirePerm } from '../../permissions.js';
import { setting } from '../../db.js';

// Bill attachments: bytes live in SQLite as BLOBs. Limits keep the database and the 1 MB request body sane.
export const MAX_BYTES_DEFAULT = 512 * 1024;      // overridable with the setting purchases_attachment_max_bytes
export const MAX_PER_BILL = 10;
export const ALLOWED_MIME = {
  'application/pdf': (b) => b.subarray(0, 5).toString('latin1') === '%PDF-',
  'image/png': (b) => b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])),
  'image/jpeg': (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff,
  'text/plain': (b) => !b.includes(0), // a "text" file with NUL bytes is not text
};

function safeName(name) {
  if (typeof name !== 'string') throw new AppError(400, 'BAD_INPUT', 'filename is required');
  const base = name.split(/[\\/]/).pop().replace(/[^\p{L}\p{N}._ -]/gu, '_').trim().slice(0, 120);
  if (!base || /^\.+$/.test(base)) throw new AppError(400, 'BAD_INPUT', 'filename is not valid');
  return base;
}

export function addAttachment(ctx, user, billId, input = {}) {
  requirePerm(user, 'purchases.create');
  const { db } = ctx;
  const bill = db.prepare('SELECT id, status FROM bills WHERE id = ?').get(billId);
  if (!bill) throw new AppError(404, 'NOT_FOUND', 'Bill not found');
  if (['void', 'rejected'].includes(bill.status)) throw new AppError(409, 'BILL_CLOSED', `Bill is ${bill.status}`);
  const check = ALLOWED_MIME[input.mime];
  if (!check) throw new AppError(415, 'MIME_NOT_ALLOWED', `File type not allowed; use one of ${Object.keys(ALLOWED_MIME).join(', ')}`);
  if (typeof input.contentBase64 !== 'string' || !/^[A-Za-z0-9+/]*={0,2}$/.test(input.contentBase64) || !input.contentBase64.length) {
    throw new AppError(400, 'BAD_INPUT', 'contentBase64 must be base64 data');
  }
  const max = Number(setting(db, 'purchases_attachment_max_bytes') ?? MAX_BYTES_DEFAULT);
  // Reject on the encoded length first so a huge string is never decoded.
  if (Math.floor((input.contentBase64.length * 3) / 4) > max + 3) throw new AppError(413, 'FILE_TOO_LARGE', `File is larger than ${max} bytes`);
  const data = Buffer.from(input.contentBase64, 'base64');
  if (data.length > max) throw new AppError(413, 'FILE_TOO_LARGE', `File is larger than ${max} bytes`);
  if (!data.length) throw new AppError(400, 'BAD_INPUT', 'File is empty');
  if (!check(data)) throw new AppError(415, 'CONTENT_MISMATCH', 'The file content does not match its declared type');
  const filename = safeName(input.filename);
  return tx(db, () => {
    if (db.prepare('SELECT COUNT(*) n FROM purchases_attachments WHERE bill_id = ?').get(billId).n >= MAX_PER_BILL) {
      throw new AppError(409, 'TOO_MANY_ATTACHMENTS', `A bill can hold at most ${MAX_PER_BILL} attachments`);
    }
    const sha = createHash('sha256').update(data).digest('hex');
    const res = db.prepare('INSERT INTO purchases_attachments (bill_id, filename, mime, size, sha256, data, uploaded_by, created_at) VALUES (?,?,?,?,?,?,?,?)')
      .run(billId, filename, input.mime, data.length, sha, data, user.id, ctx.now());
    const id = Number(res.lastInsertRowid);
    audit(ctx, { userId: user.id, action: 'bill.attachment_added', type: 'bill', id: billId, newValue: { attachmentId: id, filename, mime: input.mime, size: data.length, sha256: sha } });
    return { id, size: data.length, sha256: sha };
  });
}

export function getAttachment(ctx, user, billId, attId) {
  requirePerm(user, 'purchases.view');
  const a = ctx.db.prepare('SELECT * FROM purchases_attachments WHERE id = ? AND bill_id = ?').get(attId, billId);
  if (!a) throw new AppError(404, 'NOT_FOUND', 'Attachment not found');
  return { id: a.id, filename: a.filename, mime: a.mime, size: a.size, sha256: a.sha256, contentBase64: Buffer.from(a.data).toString('base64') };
}
