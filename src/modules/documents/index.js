import * as s from './service.js';

const r = (method, path, summary, permission, handler) => ({ method, path, handler, meta: { summary, permission } });

// Per-tenant document store: attachments and source files linked to bills, purchase orders and invoices.
// The old /api/bills/:id/attachments routes (purchases module) keep working; their rows are mirrored here.
export default {
  name: 'documents',
  permissions: {
    'documents.view': 'See and download documents and the e-document flag',
    'documents.upload': 'Upload and link documents, set the e-document flag',
    'documents.manage': 'Remove documents (reason required)',
  },
  roleGrants: {
    manager: ['documents.view', 'documents.upload', 'documents.manage'],
    clerk: ['documents.view', 'documents.upload'],
    accountant: ['documents.view', 'documents.upload'],
    auditor: ['documents.view'],
  },
  exportTables: ['documents_files', 'documents_links', 'documents_edoc_status'],
  routes: [
    r('GET', '/api/documents/limits', 'Size, type and count limits of the document store', 'documents.view', (ctx, u) => s.limits(ctx, u)),
    r('GET', '/api/documents/edoc', 'Has-valid-e-document flag (yes/no/unknown, UNVERIFIED rule) for a bill or invoice (?entityType, ?entityId)', 'documents.view', (ctx, u, q) => s.getEdoc(ctx, u, q.query)),
    r('POST', '/api/documents/edoc', 'Set the has-valid-e-document flag for a bill or invoice (UNVERIFIED rule, manual note)', 'documents.upload', (ctx, u, q) => s.setEdoc(ctx, u, q.body)),
    r('GET', '/api/documents', 'List documents (?entityType=bill|purchase_order|invoice&entityId)', 'documents.view', (ctx, u, q) => s.listDocuments(ctx, u, q.query)),
    r('POST', '/api/documents', 'Upload a document (base64) and link it to a bill, purchase order or invoice', 'documents.upload', (ctx, u, q) => s.addDocument(ctx, u, q.body)),
    r('GET', '/api/documents/:id', 'One document with its links', 'documents.view', (ctx, u, q) => s.getDocument(ctx, u, Number(q.params.id))),
    r('GET', '/api/documents/:id/content', 'Download a document as base64 (hash re-checked)', 'documents.view', (ctx, u, q) => s.getContent(ctx, u, Number(q.params.id))),
    r('POST', '/api/documents/:id/link', 'Link an existing document to another bill, purchase order or invoice', 'documents.upload', (ctx, u, q) => s.linkDocument(ctx, u, Number(q.params.id), q.body)),
    r('POST', '/api/documents/:id/remove', 'Remove a document (bytes wiped, reason required, audited)', 'documents.manage', (ctx, u, q) => s.removeDocument(ctx, u, Number(q.params.id), q.body)),
  ],
  widgets: s.widgets,
};
