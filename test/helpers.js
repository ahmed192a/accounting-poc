import { createSeededContext } from '../src/server.js';
import { loadUser } from '../src/permissions.js';

export const IDS = { owner: 1, manager: 2, clerk: 3, accountant: 4, auditor: 5, admin: 6 };

export function setup() {
  const ctx = createSeededContext();
  const as = (name) => loadUser(ctx, IDS[name]);
  return { ctx, as };
}

export function expectError(fn, code) {
  let err;
  try { fn(); } catch (e) { err = e; }
  if (!err) throw new Error(`Expected error ${code}, but nothing was thrown`);
  if (err.code !== code) throw new Error(`Expected error ${code}, got ${err.code}: ${err.message}`);
  return err;
}
