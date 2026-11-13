import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setup, expectError, startApp } from './helpers.js';
import { createApp } from '../src/server.js';
import * as d from '../src/modules/documents/service.js';
import * as att from '../src/modules/purchases/attachments.js';
import * as purchases from '../src/modules/purchases/service.js';

const b64 = (s) => Buffer.from(s).toString('base64');
const PDF = b64('%PDF-1.4 doc');
const mkBill = (ctx, as, amount = 1000) => purchases.createBill(ctx, as('clerk'), { supplier: 'Docs Supplier', amount, category: 'rent', draft: true }).id;

test('documents: upload, link, limits, hash, duplicate, audit', () => {
  const { ctx, as } = setup();
  const bill = mkBill(ctx, as);
  const a = d.addDocument(ctx, as('clerk'), { entityType: 'bill', entityId: bill, filename: '../x/r 1.pdf', mime: 'application/pdf', contentBase64: PDF });
  assert.equal(d.listDocuments(ctx, as('auditor'), { entityType: 'bill', entityId: bill })[0].filename, 'r 1.pdf');
  const c = d.getContent(ctx, as('auditor'), a.id);
  assert.equal(c.intact, true);
  assert.equal(Buffer.from(c.contentBase64, 'base64').toString(), '%PDF-1.4 doc');
  expectError(() => d.addDocument(ctx, as('clerk'), { entityType: 'bill', entityId: bill, filename: 'r.pdf', mime: 'application/pdf', contentBase64: PDF }), 'DUPLICATE_DOCUMENT');
  expectError(() => d.addDocument(ctx, as('auditor'), { entityType: 'bill', entityId: bill, filename: 'r.pdf', mime: 'application/pdf', contentBase64: b64('%PDF-2') }), 'FORBIDDEN');
  expectError(() => d.addDocument(ctx, as('clerk'), { entityType: 'bill', entityId: bill, filename: 'r.exe', mime: 'application/x-msdownload', contentBase64: PDF }), 'MIME_NOT_ALLOWED');
  expectError(() => d.addDocument(ctx, as('clerk'), { entityType: 'bill', entityId: bill, filename: 'r.pdf', mime: 'application/pdf', contentBase64: b64('MZ') }), 'CONTENT_MISMATCH');
  expectError(() => d.addDocument(ctx, as('clerk'), { entityType: 'bill', entityId: bill, filename: 'r.txt', mime: 'text/plain', contentBase64: Buffer.alloc(600 * 1024, 65).toString('base64') }), 'FILE_TOO_LARGE');
  expectError(() => d.addDocument(ctx, as('clerk'), { entityType: 'bill', entityId: 9999, filename: 'r.txt', mime: 'text/plain', contentBase64: b64('x') }), 'NOT_FOUND');
  expectError(() => d.addDocument(ctx, as('clerk'), { entityType: 'nope', entityId: 1, filename: 'r.txt', mime: 'text/plain', contentBase64: b64('x') }), 'BAD_INPUT');
  d.addDocument(ctx, as('clerk'), { entityType: 'bill', entityId: bill, kind: 'source', filename: 'e.json', mime: 'application/json', contentBase64: b64('{"a":1}') });
  expectError(() => d.addDocument(ctx, as('clerk'), { entityType: 'bill', entityId: bill, filename: 'e.json', mime: 'application/json', contentBase64: b64('{bad') }), 'CONTENT_MISMATCH');
  assert.ok(ctx.db.prepare("SELECT 1 FROM audit_log WHERE action = 'document.added'").get());
  for (let i = 0; i < 8; i++) d.addDocument(ctx, as('clerk'), { entityType: 'bill', entityId: bill, filename: `n${i}.txt`, mime: 'text/plain', contentBase64: b64('t' + i) });
  expectError(() => d.addDocument(ctx, as('clerk'), { entityType: 'bill', entityId: bill, filename: 'z.txt', mime: 'text/plain', contentBase64: b64('zz') }), 'TOO_MANY_DOCUMENTS');
});

test('documents: link to a purchase order, remove needs permission and reason and wipes bytes', () => {
  const { ctx, as } = setup();
  const bill = mkBill(ctx, as);
  const po = ctx.db.prepare("INSERT INTO purchases_orders (number, supplier_id, order_date, status, created_by, created_at) VALUES ('PO-T', (SELECT supplier_id FROM bills WHERE id = ?), '2026-01-01', 'open', 3, 0)").run(bill).lastInsertRowid;
  const a = d.addDocument(ctx, as('clerk'), { entityType: 'bill', entityId: bill, filename: 'q.txt', mime: 'text/plain', contentBase64: b64('quote') });
  d.linkDocument(ctx, as('clerk'), a.id, { entityType: 'purchase_order', entityId: Number(po) });
  expectError(() => d.linkDocument(ctx, as('clerk'), a.id, { entityType: 'purchase_order', entityId: Number(po) }), 'ALREADY_LINKED');
  assert.equal(d.listDocuments(ctx, as('clerk'), { entityType: 'purchase_order', entityId: Number(po) }).length, 1);
  expectError(() => d.removeDocument(ctx, as('clerk'), a.id, { reason: 'x' }), 'FORBIDDEN');
  expectError(() => d.removeDocument(ctx, as('manager'), a.id, {}), 'BAD_INPUT');
  d.removeDocument(ctx, as('manager'), a.id, { reason: 'wrong file' });
  expectError(() => d.getContent(ctx, as('clerk'), a.id), 'NOT_FOUND');
  assert.equal(d.listDocuments(ctx, as('clerk'), { entityType: 'bill', entityId: bill }).length, 0);
  assert.equal(ctx.db.prepare('SELECT length(data) n FROM documents_files WHERE id = ?').get(a.id).n, 1);
});

test('documents: files added through the old purchases API show up here (migration backfill and lazy sync)', () => {
  const { ctx, as } = setup();
  const bill = mkBill(ctx, as);
  const old = att.addAttachment(ctx, as('clerk'), bill, { filename: 'old.pdf', mime: 'application/pdf', contentBase64: PDF });
  const list = d.listDocuments(ctx, as('auditor'), { entityType: 'bill', entityId: bill });
  assert.equal(list.length, 1);
  assert.equal(list[0].sha256, old.sha256);
  assert.equal(d.syncLegacy(ctx), 0, 'idempotent');
  assert.equal(att.getAttachment(ctx, as('auditor'), bill, old.id).filename, 'old.pdf', 'old API still works');
});

test('documents: e-document flag defaults to unknown, is audited, and carries the UNVERIFIED label', () => {
  const { ctx, as } = setup();
  const bill = mkBill(ctx, as);
  const g = d.getEdoc(ctx, as('auditor'), { entityType: 'bill', entityId: bill });
  assert.equal(g.status, 'unknown');
  assert.match(g.rule, /UNVERIFIED/);
  d.setEdoc(ctx, as('clerk'), { entityType: 'bill', entityId: bill, status: 'yes', note: 'ETA e-invoice 123' });
  assert.equal(d.getEdoc(ctx, as('auditor'), { entityType: 'bill', entityId: bill }).status, 'yes');
  d.setEdoc(ctx, as('clerk'), { entityType: 'bill', entityId: bill, status: 'no' });
  assert.equal(d.getEdoc(ctx, as('auditor'), { entityType: 'bill', entityId: bill }).status, 'no');
  expectError(() => d.setEdoc(ctx, as('clerk'), { entityType: 'bill', entityId: bill, status: 'maybe' }), 'BAD_INPUT');
  expectError(() => d.setEdoc(ctx, as('auditor'), { entityType: 'bill', entityId: bill, status: 'yes' }), 'FORBIDDEN');
  assert.equal(ctx.db.prepare("SELECT COUNT(*) n FROM audit_log WHERE action = 'document.edoc_set'").get().n, 2);
});

test('documents: HTTP routes are permission gated and exported', async () => {
  const { ctx, as } = setup();
  const bill = mkBill(ctx, as);
  const { server, call } = await startApp(createApp, ctx);
  try {
    const up = await call('POST', '/api/documents', 3, { entityType: 'bill', entityId: bill, filename: 'a.pdf', mime: 'application/pdf', contentBase64: PDF });
    assert.equal(up.status, 201);
    assert.equal((await call('POST', '/api/documents', 5, { entityType: 'bill', entityId: bill, filename: 'b.pdf', mime: 'application/pdf', contentBase64: b64('%PDF-9') })).status, 403);
    assert.equal((await call('GET', `/api/documents?entityType=bill&entityId=${bill}`, 5)).body.length, 1);
    assert.equal((await call('GET', '/api/documents/limits', 5)).body.maxPerEntity, 10);
    assert.equal((await call('GET', `/api/documents/${up.body.id}/content`, 5)).body.intact, true);
    assert.equal((await call('GET', '/api/documents', null)).status, 401);
    const ex = await call('GET', '/api/export', 1);
    assert.ok(ex.body.documents_files_export, 'export includes documents');
  } finally { server.close(); }
});

test('documents: migration 960 copies existing purchases attachments and links them to their bill', async () => {
  const { DatabaseSync } = await import('node:sqlite');
  const { runMigrations, loadMigrations } = await import('../src/db.js');
  const DEFAULT_MIGRATIONS = await loadMigrations();
  const db = new DatabaseSync(':memory:');
  runMigrations(db, DEFAULT_MIGRATIONS.filter((m) => m.id < '960'));
  db.prepare("INSERT INTO bills (supplier, amount, category, status, created_by, created_at) VALUES ('S', 100, 'rent', 'draft', 1, 0)").run();
  db.prepare("INSERT INTO purchases_attachments (bill_id, filename, mime, size, sha256, data, uploaded_by, created_at) VALUES (1, 'o.txt', 'text/plain', 1, 'abc', x'41', 1, 5)").run();
  runMigrations(db, DEFAULT_MIGRATIONS);
  const row = db.prepare("SELECT d.filename, l.entity_type, l.entity_id FROM documents_files d JOIN documents_links l ON l.document_id = d.id").get();
  assert.deepEqual({ ...row }, { filename: 'o.txt', entity_type: 'bill', entity_id: 1 });
});
