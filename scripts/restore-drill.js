#!/usr/bin/env node
// Restore drill: prove that a tenant backup is a backup you can actually restore.
//
//   node scripts/restore-drill.js                     self-contained drill (what CI runs monthly and on every change)
//   node scripts/restore-drill.js --backup FILE       restore and verify an existing backup file on its own
//   options: --work DIR (default: a temp folder, removed afterwards)   --keep (do not remove it)   --json
//
// Self-contained drill: provision a company with sample data in a file-backed tenants folder, post some entries, seal the
// audit chain, take the backup the operator action takes (VACUUM INTO, while the source stays open in WAL mode), copy it to a
// fresh path, open it as a brand-new database and check that
//   1. SQLite integrity_check passes and the backup's sha256 is the one the backup action reported;
//   2. the audit hash chain verifies (every link, no modified, deleted or inserted rows) and its head equals the source's;
//   3. the ledger is balanced and its totals (entries, lines, debit, credit, per-account balances) equal the source's.
// Exit code 0 = restore proven, 1 = something differs. Nothing here touches a production database.
import { mkdtempSync, mkdirSync, copyFileSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { randomBytes, createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { openDb, createContext } from '../src/db.js';
import { createDemoContext } from '../src/server.js';
import { createTenantManager } from '../src/tenants.js';
import { postEntry, audit, trialBalance } from '../src/ledger.js';
import { verifyAudit } from '../src/modules/auth/auditchain.js';

const sha256File = (file) => createHash('sha256').update(readFileSync(file)).digest('hex');

/** Facts that must survive a restore unchanged: ledger totals and the audit chain head. Does not modify the database. */
export function fingerprint(ctx) {
  const { db } = ctx;
  const one = (sql) => db.prepare(sql).get();
  const tb = trialBalance(db);
  const chain = verifyAudit(ctx, { seal: false });
  return {
    integrity: one('PRAGMA integrity_check')?.integrity_check,
    ledger: {
      entries: one('SELECT COUNT(*) n FROM journal_entries').n,
      lines: one('SELECT COUNT(*) n FROM journal_lines').n,
      totalDebit: tb.totalDebit,
      totalCredit: tb.totalCredit,
      balanced: tb.balanced,
      accounts: createHash('sha256').update(JSON.stringify(tb.rows.map((r) => [r.code, r.debit, r.credit]))).digest('hex'),
    },
    audit: {
      rows: one('SELECT COUNT(*) n FROM audit_log').n,
      ok: chain.ok, sealed: chain.sealed, unsealed: chain.unsealed, head: chain.head, headId: chain.headId, problems: chain.problems,
    },
  };
}

/** Compare a source fingerprint (optional) with a restored one. Returns [{ name, ok, detail }]. */
export function compare(restored, source = null) {
  const checks = [];
  const add = (name, ok, detail = '') => checks.push({ name, ok: !!ok, detail });
  add('SQLite integrity_check passes on the restored database', restored.integrity === 'ok', restored.integrity);
  add('audit hash chain verifies (no broken link, modified, deleted or inserted row)', restored.audit.ok && restored.audit.sealed > 0, JSON.stringify(restored.audit.problems));
  add('audit chain has no unsealed tail', restored.audit.unsealed === 0, `${restored.audit.unsealed} unsealed`);
  add('ledger is balanced (total debit equals total credit)', restored.ledger.balanced && restored.ledger.lines > 0, `${restored.ledger.totalDebit} vs ${restored.ledger.totalCredit}`);
  if (source) {
    add('audit chain head equals the source', restored.audit.head === source.audit.head && restored.audit.headId === source.audit.headId, `${restored.audit.headId} vs ${source.audit.headId}`);
    add('audit row count equals the source', restored.audit.rows === source.audit.rows, `${restored.audit.rows} vs ${source.audit.rows}`);
    add('ledger entries and lines equal the source', restored.ledger.entries === source.ledger.entries && restored.ledger.lines === source.ledger.lines, `${restored.ledger.entries}/${restored.ledger.lines} vs ${source.ledger.entries}/${source.ledger.lines}`);
    add('ledger total debit and credit equal the source', restored.ledger.totalDebit === source.ledger.totalDebit && restored.ledger.totalCredit === source.ledger.totalCredit, `${restored.ledger.totalDebit}/${restored.ledger.totalCredit} vs ${source.ledger.totalDebit}/${source.ledger.totalCredit}`);
    add('every account balance equals the source', restored.ledger.accounts === source.ledger.accounts);
  }
  return checks;
}

/** Copy a backup file to a fresh path, open it as a new database and return its fingerprint. */
export function restoreAndFingerprint(backupFile, restoreDir) {
  mkdirSync(restoreDir, { recursive: true });
  const target = join(restoreDir, 'restored.db');
  if (existsSync(target)) throw new Error(`Refusing to restore over an existing file: ${target}`);
  copyFileSync(backupFile, target);
  const db = openDb(target);
  try { return { target, fp: fingerprint(createContext(db)) }; } finally { db.close(); }
}

/** The whole drill. Returns { ok, checks, source, restored, backup }. */
export function runDrill({ work, log = () => {} } = {}) {
  const dir = join(work, 'tenants');
  mkdirSync(dir, { recursive: true });
  const root = createDemoContext();
  const manager = createTenantManager(root, { dir });
  try {
    const operator = { id: 1 };
    log('provision a company with sample data');
    manager.create(operator, { slug: 'drill', name: 'Restore Drill Co', ownerEmail: 'owner@drill.test', ownerPassword: `Drill-${randomBytes(12).toString('hex')}-Aa1!`, demo: true });

    log('post entries and seal the audit chain');
    const source = manager.with('drill', (ctx) => {
      for (let i = 1; i <= 25; i++) {
        postEntry(ctx, { userId: 1, memo: `Drill sale ${i}`, sourceType: 'drill', lines: [{ account: '1000', debit: 1000 * i + 7 }, { account: '4000', credit: 1000 * i + 7 }] });
        if (i % 5 === 0) audit(ctx, { userId: 1, action: 'drill.checkpoint', type: 'drill', id: i, newValue: { i } });
      }
      verifyAudit(ctx, { seal: true });
      return fingerprint(ctx);
    });
    if (!source.audit.ok || !source.ledger.balanced) throw new Error('The source database is not healthy before the backup; refusing to continue');

    log('take the backup (VACUUM INTO, source still open)');
    const backup = manager.backup(operator, 'drill');
    const ok = sha256File(backup.file) === backup.sha256;

    log('restore into a fresh database and verify');
    const { target, fp } = restoreAndFingerprint(backup.file, join(work, 'restore'));
    const checks = [{ name: 'backup file sha256 equals the one the backup action reported', ok, detail: backup.sha256 }, ...compare(fp, source)];
    return { ok: checks.every((c) => c.ok), checks, source, restored: fp, backup: { ...backup, restoredTo: target } };
  } finally { manager.close(); root.db.close(); }
}

function main() {
  const argv = process.argv.slice(2);
  const arg = (n) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : null; };
  const json = argv.includes('--json');
  const log = json ? () => {} : (m) => console.log(`- ${m}`);
  const given = arg('--work');
  const work = given ? resolve(given) : mkdtempSync(join(tmpdir(), 'restore-drill-'));
  mkdirSync(work, { recursive: true });
  let result;
  try {
    const only = arg('--backup');
    if (only) {
      const { fp, target } = restoreAndFingerprint(resolve(only), join(work, 'restore'));
      const checks = compare(fp, null);
      result = { ok: checks.every((c) => c.ok), checks, restored: fp, backup: { file: resolve(only), restoredTo: target } };
    } else result = runDrill({ work, log });
  } catch (e) {
    result = { ok: false, checks: [{ name: 'drill ran to completion', ok: false, detail: e.message }] };
  } finally {
    if (!given && !argv.includes('--keep')) rmSync(work, { recursive: true, force: true });
  }
  if (json) console.log(JSON.stringify(result, null, 2));
  else {
    for (const c of result.checks) console.log(`${c.ok ? 'PASS' : 'FAIL'} ${c.name}${c.ok || !c.detail ? '' : ` (${c.detail})`}`);
    const r = result.restored;
    if (r) console.log(`restored: ${r.ledger.entries} entries, ${r.ledger.lines} lines, debit ${r.ledger.totalDebit} = credit ${r.ledger.totalCredit}, audit rows ${r.audit.rows}, chain head ${String(r.audit.head).slice(0, 16)}`);
    console.log(result.ok ? 'RESTORE DRILL PASSED' : 'RESTORE DRILL FAILED');
  }
  process.exit(result.ok ? 0 : 1);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
