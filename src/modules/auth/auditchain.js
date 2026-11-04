import { hmacHex, secretKey } from './crypto.js';
import { tx } from '../../ledger.js';

// Tamper-evident audit log. Every audit_log row gets a chained HMAC-SHA256 in auth_audit_chain:
//   hash(n) = HMAC(key, hash(n-1) | canonical(row n))
// Changing, deleting or inserting any sealed row breaks the chain from that point on, and verify() says where.
// Sealing happens after every write request, on verify and on a timer; rows written since the last seal are
// "unsealed" and are not yet protected (they are still protected by the append-only triggers).
// LIMIT: with the default key stored in the same database, an attacker who can rewrite the whole database can
// also recompute the chain. Set AUDIT_CHAIN_KEY (kept outside the DB) and/or anchor `head` somewhere external.
const GENESIS = '0'.repeat(64);
const key = (ctx) => secretKey(ctx, 'audit_chain_key', 'AUDIT_CHAIN_KEY');

const canonical = (r) => JSON.stringify([r.id, r.ts, r.user_id, r.action, r.record_type, r.record_id, r.old_value, r.new_value, r.reason]);
const rowHash = (k, prev, row) => hmacHex(k, `${prev}|${canonical(row)}`);

export function sealAudit(ctx) {
  const { db } = ctx;
  const head = db.prepare('SELECT audit_id, hash FROM auth_audit_chain ORDER BY audit_id DESC LIMIT 1').get();
  const pending = db.prepare('SELECT * FROM audit_log WHERE id > ? ORDER BY id').all(head?.audit_id ?? 0);
  if (!pending.length) return 0;
  const k = key(ctx);
  const ins = db.prepare('INSERT INTO auth_audit_chain (audit_id, prev_hash, hash, sealed_at) VALUES (?,?,?,?)');
  return tx(db, () => {
    let prev = head?.hash ?? GENESIS;
    for (const row of pending) {
      const hash = rowHash(k, prev, row);
      ins.run(row.id, prev, hash, ctx.now());
      prev = hash;
    }
    return pending.length;
  });
}

/** Re-compute the whole chain. { ok, sealed, unsealed, head, problems: [{ auditId, kind }] } */
export function verifyAudit(ctx, { seal = true } = {}) {
  if (seal) sealAudit(ctx);
  const { db } = ctx;
  const k = key(ctx);
  const problems = [];
  const note = (auditId, kind) => { if (problems.length < 100) problems.push({ auditId, kind }); };
  const getRow = db.prepare('SELECT * FROM audit_log WHERE id = ?');
  let prev = GENESIS, sealed = 0, lastId = 0;
  for (const c of db.prepare('SELECT * FROM auth_audit_chain ORDER BY audit_id').iterate()) {
    sealed++;
    lastId = c.audit_id;
    if (c.prev_hash !== prev) note(c.audit_id, 'chain_link_broken');
    const row = getRow.get(c.audit_id);
    if (!row) note(c.audit_id, 'row_deleted');
    else if (rowHash(k, c.prev_hash, row) !== c.hash) note(c.audit_id, 'row_modified');
    prev = c.hash;
  }
  // rows that sit inside the sealed range but were never chained were slipped in afterwards
  const inRange = db.prepare('SELECT COUNT(*) AS n FROM audit_log WHERE id <= ?').get(lastId).n;
  const chainedPresent = db.prepare('SELECT COUNT(*) AS n FROM auth_audit_chain c JOIN audit_log a ON a.id = c.audit_id').get().n;
  if (inRange > chainedPresent) {
    for (const r of db.prepare('SELECT id FROM audit_log WHERE id <= ? AND id NOT IN (SELECT audit_id FROM auth_audit_chain) ORDER BY id').all(lastId)) note(r.id, 'row_inserted');
  }
  const unsealed = db.prepare('SELECT COUNT(*) AS n FROM audit_log WHERE id > ?').get(lastId).n;
  return { ok: problems.length === 0, sealed, unsealed, head: sealed ? prev : null, headId: lastId || null, problems, checkedAt: ctx.now() };
}

