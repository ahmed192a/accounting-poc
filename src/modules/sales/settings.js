import { AppError } from '../../errors.js';
import { tx, audit } from '../../ledger.js';
import { requirePerm } from '../../permissions.js';
import { setting } from '../../db.js';
import { text } from './common.js';

const PREFIX = /^[A-Za-z0-9\-_/]{0,12}$/;
const KEYS = { businessName: 'sales_business_name', businessTaxId: 'sales_business_tax_id', businessAddress: 'sales_business_address', countryCode: 'sales_country_code' };

export function getSettings(ctx, user) {
  requirePerm(user, 'sales.view');
  const { db } = ctx;
  const out = { sequences: db.prepare('SELECT name, prefix, padding, next_no AS next FROM sales_sequences ORDER BY name').all() };
  for (const [k, key] of Object.entries(KEYS)) out[k] = setting(db, key) ?? (k === 'countryCode' ? '20' : '');
  return out;
}

/** Configure numbering ({ sequences: { invoice: { prefix, padding, next } } }) and print/reminder details. */
export function updateSettings(ctx, user, input = {}) {
  requirePerm(user, 'sales.configure');
  const { db } = ctx;
  const before = getSettings(ctx, user);
  return tx(db, () => {
    for (const [name, v] of Object.entries(input.sequences ?? {})) {
      const cur = db.prepare('SELECT * FROM sales_sequences WHERE name = ?').get(name);
      if (!cur) throw new AppError(400, 'BAD_INPUT', `Unknown sequence ${name} (use invoice, quote or credit_note)`);
      const prefix = v.prefix ?? cur.prefix;
      const padding = v.padding ?? cur.padding;
      const next = v.next ?? cur.next_no;
      if (typeof prefix !== 'string' || !PREFIX.test(prefix)) throw new AppError(400, 'BAD_INPUT', 'prefix may hold up to 12 letters, digits, - _ /');
      if (!Number.isInteger(padding) || padding < 1 || padding > 10) throw new AppError(400, 'BAD_INPUT', 'padding must be between 1 and 10');
      if (!Number.isInteger(next) || next < 1) throw new AppError(400, 'BAD_INPUT', 'next must be a positive whole number');
      if (next < cur.next_no) throw new AppError(409, 'SEQUENCE_BACKWARDS', `The next number cannot go below ${cur.next_no}; numbers must never repeat`);
      db.prepare('UPDATE sales_sequences SET prefix = ?, padding = ?, next_no = ? WHERE name = ?').run(prefix, padding, next, name);
    }
    for (const [k, key] of Object.entries(KEYS)) {
      if (!(k in input)) continue;
      const v = text(input[k], k, { max: k === 'businessAddress' ? 300 : 80 }) ?? '';
      if (k === 'countryCode' && v && !/^\d{1,3}$/.test(v)) throw new AppError(400, 'BAD_INPUT', 'countryCode must be 1-3 digits, e.g. 20');
      db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, v);
    }
    const after = getSettings(ctx, user);
    audit(ctx, { userId: user.id, action: 'sales.settings_changed', type: 'settings', oldValue: before, newValue: after });
    return after;
  });
}
