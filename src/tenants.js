import { mkdirSync, rmSync, statSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { openDb, createContext, runMigrations } from './db.js';
import { initContext, defaultRegistry } from './modules.js';
import { AppError } from './errors.js';
import { audit } from './ledger.js';
import { cfg } from './modules/auth/config.js';
import { ensureFirstRun, normEmail } from './modules/auth/service.js';
import { sha256Hex } from './modules/auth/crypto.js';
import { exportAll } from './modules/core/service.js';

// Multi-tenancy: ONE SQLITE FILE PER TENANT. See docs/tenancy.md for the design and its limits.
//
//   registry DB (TENANTS_DIR/registry.db)   tenants(id, slug, name, status, db_file, ...)
//   tenant DBs  (TENANTS_DIR/tenant-<id>.db) full application schema, seeds, own users, roles, sessions, keys, ledger, audit
//   default tenant (id 1, slug "default")    the database the process was started with (DB_PATH); demo mode lives here
//
// The tenant of a request is never read from a client-controlled field that grants access. It is found by asking
// which tenant database actually contains the presented credential (session token hash or API key hash); the credential
// is then verified by the normal auth code against that one database only. A credential of tenant A therefore cannot
// authenticate against tenant B, and an unknown credential falls through to the default tenant's normal 401.

const SLUG = /^[a-z][a-z0-9-]{1,30}[a-z0-9]$/;
const RESERVED = new Set(['default', 'registry', 'admin', 'api', 'www', 'system', 'platform', 'tenant', 'tenants']);
const CACHE_MAX = 5000;
const STATUSES = ['active', 'suspended'];

const REGISTRY_MIGRATIONS = [{
  id: 'r001_tenants',
  up(db) {
    db.exec(`
      CREATE TABLE tenants (
        id INTEGER PRIMARY KEY,
        slug TEXT NOT NULL UNIQUE,
        name TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('provisioning','active','suspended')),
        db_file TEXT,
        is_default INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL,
        created_by INTEGER,
        suspended_at INTEGER
      );
    `);
  },
}];

const view = (r, open = false) => ({ id: r.id, slug: r.slug, name: r.name, status: r.status, isDefault: !!r.is_default, createdAt: r.created_at, createdBy: r.created_by, suspendedAt: r.suspended_at, open });

/**
 * Create the manager for a base (default tenant) context. opts: dir (folder for registry + tenant files; omitted = everything
 * in memory, for tests and demos), maxOpen (file-backed tenant databases kept open at once; idle ones are closed LRU), registry (module registry).
 */
export function createTenantManager(baseCtx, { dir = null, maxOpen = 50, registry = baseCtx.registry ?? defaultRegistry } = {}) {
  if (dir) mkdirSync(dir, { recursive: true });
  const reg = new DatabaseSync(dir ? join(dir, 'registry.db') : ':memory:');
  runMigrations(reg, REGISTRY_MIGRATIONS);
  const now = () => baseCtx.now();
  const getRow = (slug) => reg.prepare('SELECT * FROM tenants WHERE slug = ?').get(String(slug ?? ''));
  const rowById = (id) => reg.prepare('SELECT * FROM tenants WHERE id = ?').get(id);

  if (!reg.prepare('SELECT 1 FROM tenants WHERE is_default = 1').get()) {
    reg.prepare("INSERT INTO tenants (id, slug, name, status, db_file, is_default, created_at) VALUES (1, 'default', 'Default company', 'active', NULL, 1, ?)").run(now());
  }
  const defaultRow = () => reg.prepare('SELECT * FROM tenants WHERE is_default = 1').get();
  const writeInfo = (db, row) => {
    const up = db.prepare('INSERT INTO tenant_info (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value');
    up.run('tenant_id', String(row.id)); up.run('slug', row.slug);
  };

  const open = new Map();  // id -> { ctx, inflight, last, memory }
  const routeCache = new Map(); // "kind:sha256" -> tenant id (routing hint only; every hit is re-verified against that tenant's database)
  let extra = reg.prepare('SELECT COUNT(*) n FROM tenants WHERE is_default = 0 AND status != ?').get('provisioning').n;

  const tenantInfo = (row) => ({ id: row.id, slug: row.slug, name: row.name, isDefault: !!row.is_default });
  function decorate(ctx, row) { ctx.tenant = tenantInfo(row); ctx.tenants = manager; return ctx; }

  const dRow = defaultRow();

  function openTenant(row) {
    const hit = open.get(row.id);
    if (hit) return hit;
    const memory = !dir;
    const db = openDb(memory ? ':memory:' : join(dir, row.db_file));
    const ctx = createContext(db, registry);
    // Provisioned tenants always require real sign-in: the x-user-id demo identity exists for the default tenant only.
    // Set BEFORE initContext so the auth seed creates inert placeholder users instead of demo passwords.
    ctx.security = { ...cfg(baseCtx), required: true };
    decorate(ctx, row);
    initContext(ctx, registry);
    const info = Object.fromEntries(db.prepare('SELECT key, value FROM tenant_info').all().map((r) => [r.key, r.value]));
    if (info.slug == null && (memory || row.status === 'provisioning')) writeInfo(db, row);
    else if (info.slug == null || info.slug !== row.slug || info.tenant_id !== String(row.id)) {
      db.close();
      throw new AppError(500, 'TENANT_DB_MISMATCH', `Database file for tenant "${row.slug}" does not carry that tenant's identity`);
    }
    const entry = { ctx, inflight: 0, last: Date.now(), memory };
    open.set(row.id, entry);
    evict();
    return entry;
  }

  /** Close the least recently used idle file-backed tenant databases beyond maxOpen. Never the default, never in-memory ones. */
  function evict() {
    const idle = [...open.entries()].filter(([id, e]) => id !== dRow.id && !e.memory && e.inflight === 0).sort((a, b) => a[1].last - b[1].last);
    let count = [...open.values()].filter((e) => !e.memory).length;
    for (const [id, e] of idle) {
      if (count <= maxOpen) break;
      e.ctx.db.close(); open.delete(id); count--;
    }
  }

  function lease(row) {
    const e = openTenant(row);
    e.inflight++; e.last = Date.now();
    let done = false;
    return { ctx: e.ctx, tenant: tenantInfo(row), release() { if (done) return; done = true; e.inflight--; evict(); } };
  }

  const blocked = (row) => {
    if (row.status === 'suspended') throw new AppError(403, 'TENANT_SUSPENDED', 'This company account is suspended', { tenant: row.slug });
    if (row.status !== 'active') throw new AppError(503, 'TENANT_UNAVAILABLE', 'This company account is not available yet');
  };

  /**
   * Ask one tenant database a yes/no question while looking for a credential. A tenant whose database cannot be opened
   * (missing, wrong identity, corrupt) is treated as "not here" and remembered in manager.broken, so one damaged company
   * never stops anybody else from signing in. Requests that NAME the broken tenant still get its real error.
   */
  function probeRow(row, fn) {
    let l;
    try { l = lease(row); } catch (e) { broken.set(row.slug, e.code ?? e.message); return false; }
    try { return !!fn(l.ctx.db); } finally { l.release(); }
  }
  const broken = new Map();

  const tenantRows = () => reg.prepare("SELECT * FROM tenants WHERE status != 'provisioning' ORDER BY id").all();

  // ---- credential probing ----
  const PROBES = {
    session: (db, h) => db.prepare('SELECT 1 FROM auth_sessions WHERE id = ?').get(h),
    key: (db, h) => db.prepare('SELECT 1 FROM auth_api_keys WHERE key_hash = ?').get(h),
  };
  function credential(req, http) {
    const bearer = /^Bearer\s+(acck_\S+)$/i.exec(String(req.headers.authorization ?? ''))?.[1];
    const key = bearer ?? req.headers['x-api-key'];
    if (key) return { kind: 'key', hash: sha256Hex(String(key)) };
    if (http.sessionToken) return { kind: 'session', hash: sha256Hex(http.sessionToken) };
    return null;
  }

  const manager = {
    dir,
    /** True once at least one tenant besides the default exists. Until then every request takes the single-tenant fast path. */
    get multi() { return extra > 0; },
    list() { return tenantRows().map((r) => view(r, open.has(r.id))); },
    get(slug) {
      const r = getRow(slug);
      if (!r || r.status === 'provisioning') throw new AppError(404, 'TENANT_NOT_FOUND', 'No such tenant');
      return view(r, open.has(r.id));
    },
    lease(slug) { const r = getRow(slug); if (!r || r.status === 'provisioning') throw new AppError(404, 'TENANT_NOT_FOUND', 'No such tenant'); return lease(r); },
    /** Run fn(ctx) on a tenant, releasing it afterwards. Works even when suspended (operator tasks). */
    with(slug, fn) {
      const l = manager.lease(slug);
      try { return fn(l.ctx); } finally { l.release(); }
    },

    /** Lease for an authenticated request: which tenant database holds this credential? Always a lease; unknown credentials get the default tenant. */
    forRequest(req, http) {
      const dflt = () => lease(defaultRow());
      if (!manager.multi) return dflt();
      const cred = credential(req, http);
      if (!cred) return dflt();
      const ck = `${cred.kind}:${cred.hash}`;
      const probe = PROBES[cred.kind];
      const has = (row) => probeRow(row, (db) => probe(db, cred.hash));
      const cached = routeCache.get(ck);
      let found = null;
      if (cached != null) { const r = rowById(cached); if (r && r.status !== 'provisioning' && has(r)) found = r; else routeCache.delete(ck); }
      if (!found) {
        for (const r of tenantRows()) if (has(r)) { found = r; break; }
        if (found) {
          if (routeCache.size >= CACHE_MAX) routeCache.delete(routeCache.keys().next().value);
          routeCache.set(ck, found.id);
        }
      }
      if (!found) return dflt();
      blocked(found);
      return lease(found);
    },

    /**
     * Lease for a public route (login, setup, accept-invite, status). The caller may NAME a tenant (body.tenant or ?tenant=):
     * that only selects which database the credentials are checked against, so it grants nothing. Without a name, a login
     * is routed by e-mail when exactly one tenant knows it; an e-mail used in several tenants asks the caller to name one.
     */
    forPublic(path, query = {}, body = {}) {
      const named = query.tenant ?? body.tenant;
      if (named != null && named !== '') {
        const r = getRow(String(named));
        if (!r || r.status === 'provisioning') throw new AppError(404, 'TENANT_NOT_FOUND', 'No such company');
        blocked(r);
        return lease(r);
      }
      if (manager.multi && path === '/api/auth/login') {
        const email = String(body.email ?? '').trim().toLowerCase();
        if (email) {
          const hits = tenantRows().filter((r) => probeRow(r, (db) => db.prepare('SELECT 1 FROM auth_credentials WHERE email = ?').get(email)));
          if (hits.length > 1) throw new AppError(409, 'TENANT_REQUIRED', 'This e-mail is used by more than one company; say which one with "tenant"', { tenants: hits.map((h) => h.slug) });
          if (hits.length === 1) { blocked(hits[0]); return lease(hits[0]); }
        }
      } else if (manager.multi && path.startsWith('/api/auth/') && path !== '/api/auth/status') {
        throw new AppError(400, 'TENANT_REQUIRED', 'Say which company with "tenant" (its short name)');
      }
      return lease(defaultRow());
    },

    /** Operator action: provision a tenant. Fresh database, every migration, every module seed, one owner with the given credentials. */
    create(actor, input = {}) {
      const slug = String(input.slug ?? '').trim().toLowerCase();
      const name = String(input.name ?? '').trim();
      if (!SLUG.test(slug)) throw new AppError(400, 'BAD_INPUT', 'slug must be 3 to 32 characters: lowercase letters, digits and hyphens, starting with a letter');
      if (RESERVED.has(slug)) throw new AppError(400, 'BAD_INPUT', `"${slug}" is a reserved name`);
      if (name.length < 2 || name.length > 120) throw new AppError(400, 'BAD_INPUT', 'name is required (2 to 120 characters)');
      const ownerEmail = normEmail(input.ownerEmail);
      if (typeof input.ownerPassword !== 'string' || !input.ownerPassword) throw new AppError(400, 'BAD_INPUT', 'ownerPassword is required');
      if (getRow(slug)) throw new AppError(409, 'TENANT_EXISTS', `A tenant named "${slug}" already exists`);

      const id = Number(reg.prepare("INSERT INTO tenants (slug, name, status, db_file, is_default, created_at, created_by) VALUES (?, ?, 'provisioning', NULL, 0, ?, ?)")
        .run(slug, name, now(), actor?.id ?? null).lastInsertRowid);
      const dbFile = `tenant-${id}.db`;
      reg.prepare('UPDATE tenants SET db_file = ? WHERE id = ?').run(dbFile, id);
      let ownerId;
      try {
        const row = rowById(id);
        const e = openTenant(row);
        writeInfo(e.ctx.db, row);
        const r = ensureFirstRun(e.ctx, { log: () => {}, env: { INITIAL_OWNER_PASSWORD: input.ownerPassword, INITIAL_OWNER_EMAIL: ownerEmail, INITIAL_OWNER_NAME: input.ownerName } });
        ownerId = r.ownerId;
        if (!ownerId) throw new AppError(500, 'PROVISION_FAILED', 'Owner account could not be created');
        audit(e.ctx, { userId: ownerId, action: 'tenant.provisioned', type: 'tenant', id, newValue: { slug, name, by: actor?.id ?? null, byTenant: 'default' } });
      } catch (err) {
        const e = open.get(id);
        if (e && !e.memory) { try { e.ctx.db.close(); } catch { /* already closed */ } }
        open.delete(id);
        if (dir) for (const suffix of ['', '-wal', '-shm', '-journal']) rmSync(join(dir, dbFile + suffix), { force: true });
        reg.prepare('DELETE FROM tenants WHERE id = ?').run(id);
        throw err;
      }
      reg.prepare("UPDATE tenants SET status = 'active' WHERE id = ?").run(id);
      extra++;
      audit(baseCtx, { userId: actor?.id ?? null, action: 'tenant.created', type: 'tenant', id, newValue: { slug, name, ownerEmail } });
      return { tenant: view(rowById(id), open.has(id)), owner: { id: ownerId, email: ownerEmail } };
    },

    setStatus(actor, slug, status) {
      if (!STATUSES.includes(status)) throw new AppError(400, 'BAD_INPUT', 'status must be active or suspended');
      const r = getRow(slug);
      if (!r || r.status === 'provisioning') throw new AppError(404, 'TENANT_NOT_FOUND', 'No such tenant');
      if (r.is_default) throw new AppError(409, 'DEFAULT_TENANT', 'The default tenant cannot be suspended');
      if (r.status === status) throw new AppError(409, 'NO_CHANGE', `Tenant is already ${status}`);
      reg.prepare('UPDATE tenants SET status = ?, suspended_at = ? WHERE id = ?').run(status, status === 'suspended' ? now() : null, r.id);
      audit(baseCtx, { userId: actor?.id ?? null, action: `tenant.${status === 'suspended' ? 'suspended' : 'resumed'}`, type: 'tenant', id: r.id, oldValue: { status: r.status }, newValue: { status, slug } });
      manager.with(slug, (ctx) => audit(ctx, { action: `tenant.${status === 'suspended' ? 'suspended' : 'resumed'}`, type: 'tenant', id: r.id, newValue: { by: actor?.id ?? null, byTenant: 'default' } }));
      return view(rowById(r.id), open.has(r.id));
    },

    /** Everything of one tenant as JSON (same shape as GET /api/export in that tenant). Audited in both databases. */
    exportTenant(actor, slug) {
      return manager.with(slug, (ctx) => {
        const out = exportAll(ctx, { id: null, name: 'platform operator', role: 'platform', permissions: new Set(['export.all']), limits: {} });
        out.tenant = { slug, name: manager.get(slug).name };
        audit(ctx, { action: 'tenant.exported', type: 'tenant', newValue: { by: actor?.id ?? null, byTenant: 'default' } });
        audit(baseCtx, { userId: actor?.id ?? null, action: 'tenant.exported', type: 'tenant', newValue: { slug } });
        return out;
      });
    },

    /** Consistent copy of one tenant's database file (VACUUM INTO) under <dir>/backups. Returns the path, size and sha256. */
    backup(actor, slug) {
      if (!dir) throw new AppError(409, 'NO_BACKUP_DIR', 'Backups need file-backed tenancy (set TENANTS_DIR)');
      const r = getRow(slug);
      if (!r || r.status === 'provisioning') throw new AppError(404, 'TENANT_NOT_FOUND', 'No such tenant');
      const folder = join(dir, 'backups');
      mkdirSync(folder, { recursive: true });
      const stamp = new Date(now()).toISOString().replace(/[-:T]/g, '').slice(0, 14);
      let file = join(folder, `${r.slug}-${stamp}.db`);
      for (let i = 2; existsSync(file); i++) file = join(folder, `${r.slug}-${stamp}-${i}.db`);
      manager.with(slug, (ctx) => {
        ctx.db.prepare('VACUUM INTO ?').run(file);
        audit(ctx, { action: 'tenant.backup', type: 'tenant', newValue: { by: actor?.id ?? null, byTenant: 'default' } });
      });
      audit(baseCtx, { userId: actor?.id ?? null, action: 'tenant.backup', type: 'tenant', id: r.id, newValue: { slug, file: file.slice(folder.length + 1) } });
      return { slug, file, bytes: statSync(file).size, sha256: sha256Hex(readFileSync(file)) };
    },

    /** Small facts for the operator list: users, journal entries and file size. Opens the tenant if needed. */
    stats(slug) {
      return manager.with(slug, (ctx) => ({
        users: ctx.db.prepare('SELECT COUNT(*) n FROM users').get().n,
        activeUsers: ctx.db.prepare('SELECT COUNT(*) n FROM auth_credentials WHERE active = 1').get().n,
        journalEntries: ctx.db.prepare('SELECT COUNT(*) n FROM journal_entries').get().n,
        auditRows: ctx.db.prepare('SELECT COUNT(*) n FROM audit_log').get().n,
        bytes: dir && getRow(slug).db_file ? statSync(join(dir, getRow(slug).db_file)).size : null,
      }));
    },

    /** Background jobs must visit every active tenant explicitly. fn(ctx) may be async. */
    async forEachActive(fn) {
      for (const r of tenantRows()) {
        if (r.status !== 'active') continue;
        const l = lease(r);
        try { await fn(l.ctx); } finally { l.release(); }
      }
    },

    openCount: () => open.size,
    /** slug -> error code for tenants that could not be opened while probing credentials */
    get broken() { return Object.fromEntries(broken); },
    close() { for (const [id, e] of open) if (id !== dRow.id) { try { e.ctx.db.close(); } catch { /* closed */ } } open.clear(); reg.close(); },
  };
  open.set(dRow.id, { ctx: decorate(baseCtx, dRow), inflight: 0, last: Date.now(), memory: true });
  writeInfo(baseCtx.db, dRow);
  return manager;
}
