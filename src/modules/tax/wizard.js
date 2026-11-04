import { AppError } from '../../errors.js';
import { audit, tx } from '../../ledger.js';
import { requirePerm } from '../../permissions.js';
import { cfg } from './config.js';
import { activeAdapter } from './adapters/index.js';
import { hasRequiredSecrets } from './secrets.js';

// ETA registration wizard (MOCK portal): a linear state machine with a checklist. Each step needs all earlier ones.
// Nothing here registers anything with a real authority; "ERP registered" is the user's own confirmation.
export const STEPS = ['tax_number', 'erp_registered', 'secrets', 'sandbox_test', 'go_live'];

export function wizardView(ctx, user) {
  requirePerm(user, 'tax.view');
  const done = new Map(ctx.db.prepare('SELECT step, done_at, note FROM tax_wizard_steps').all().map((r) => [r.step, r]));
  let blocked = false;
  const steps = STEPS.map((step) => {
    const d = done.get(step);
    const s = { step, done: !!d, doneAt: d?.done_at ?? null, note: d?.note ?? null, blocked: !d && blocked };
    if (!d) blocked = true;
    return s;
  });
  const n = steps.filter((s) => s.done).length;
  const state = n === 0 ? 'not_started' : n === STEPS.length ? 'live' : n === STEPS.length - 1 ? 'ready' : 'in_progress';
  return { mock: true, notice: 'MOCK wizard: no real portal registration happens here.', state, steps, nextStep: steps.find((s) => !s.done)?.step ?? null, secretsReady: hasRequiredSecrets(ctx.db) };
}

export function completeStep(ctx, user, step, input = {}) {
  requirePerm(user, 'tax.configure');
  const idx = STEPS.indexOf(step);
  if (idx < 0) throw new AppError(400, 'BAD_INPUT', `Unknown step "${step}" (steps: ${STEPS.join(', ')})`);
  const { db } = ctx;
  const done = new Set(db.prepare('SELECT step FROM tax_wizard_steps').all().map((r) => r.step));
  const missing = STEPS.slice(0, idx).filter((s) => !done.has(s));
  if (missing.length) throw new AppError(409, 'STEP_BLOCKED', `Finish ${missing[0]} first`, { missing });
  return tx(db, () => {
    let note = null;
    if (step === 'tax_number') {
      const num = input.registrationNumber;
      if (typeof num !== 'string' || !new RegExp(cfg(db, 'tax_regnum_pattern')).test(num)) throw new AppError(400, 'BAD_INPUT', `registrationNumber does not match the configured pattern ${cfg(db, 'tax_regnum_pattern')} (UNVERIFIED format)`);
      db.prepare("INSERT INTO settings (key, value) VALUES ('tax_reg_number', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(num);
      note = 'number saved';
    } else if (step === 'erp_registered') {
      if (input.confirm !== true) throw new AppError(400, 'BAD_INPUT', 'Confirm that the ERP/POS system is registered on the portal (confirm: true)');
      note = String(input.portalRef ?? '').slice(0, 100) || 'confirmed by user';
    } else if (step === 'secrets') {
      if (!hasRequiredSecrets(db)) throw new AppError(409, 'SECRETS_MISSING', 'Save the client id and client secret first');
    } else if (step === 'sandbox_test') {
      note = sandboxSubmission(ctx);
    } else if (step === 'go_live') {
      db.prepare("INSERT INTO settings (key, value) VALUES ('tax_go_live', '1') ON CONFLICT(key) DO UPDATE SET value = excluded.value").run();
    }
    db.prepare('INSERT INTO tax_wizard_steps (step, done_at, note, done_by) VALUES (?,?,?,?) ON CONFLICT(step) DO UPDATE SET done_at=excluded.done_at, note=excluded.note, done_by=excluded.done_by').run(step, ctx.now(), note, user.id);
    audit(ctx, { userId: user.id, action: 'tax.wizard_step', type: 'tax_wizard', newValue: { step } });
    return wizardView(ctx, user);
  });
}

// A synthetic document sent to the MOCK sandbox. It is not stored in the document chain.
function sandboxSubmission(ctx) {
  const adapter = activeAdapter(ctx.db);
  if (adapter.live) { // the live adapter is asynchronous: the step needs a successful POST /api/tax/live/test first
    if (!Number(cfg(ctx.db, 'tax_eta_test_ok'))) throw new AppError(409, 'SANDBOX_FAILED', 'Run the live connection test first (POST /api/tax/live/test) and make sure it succeeds');
    return `live connection test ok (${adapter.id}, UNVERIFIED)`;
  }
  const doc = adapter.buildDocument({
    kind: 'invoice', number: 'SANDBOX-1', uuid: '00000000-0000-4000-8000-000000000000', issuedAt: new Date(ctx.now()).toISOString(),
    seller: { taxId: cfg(ctx.db, 'tax_reg_number'), name: cfg(ctx.db, 'tax_seller_name'), address: cfg(ctx.db, 'tax_seller_address') },
    buyer: { name: 'Sandbox buyer', taxId: '999999999' },
    lines: [{ sku: 'SANDBOX', description: 'Sandbox item', qty: 1, unitPrice: 10000, net: 10000, vat: 1400, code: 'EG-100200-SANDBOX', codeType: 'EGS' }],
    totals: { net: 10000, vat: 1400, total: 11400 }, vatRateBp: 1400, vatRateCode: 'standard', refUuid: null,
  });
  try {
    adapter.submit(ctx, doc);
    const r = adapter.status(ctx, doc);
    if (r.status !== 'valid') throw new AppError(409, 'SANDBOX_FAILED', `Sandbox test was rejected: ${r.reason}`, { code: r.code, fixHint: r.fixHint });
  } catch (e) {
    if (e.code === 'TAX_UNREACHABLE') throw new AppError(409, 'SANDBOX_FAILED', 'The (mock) sandbox is unreachable; go online and try again');
    throw e;
  }
  return `sandbox ok (${adapter.id})`;
}

export function resetWizard(ctx, user, reason) {
  requirePerm(user, 'tax.configure');
  if (typeof reason !== 'string' || !reason.trim()) throw new AppError(400, 'REASON_REQUIRED', 'Resetting the wizard needs a reason');
  tx(ctx.db, () => {
    ctx.db.prepare('DELETE FROM tax_wizard_steps').run();
    ctx.db.prepare("INSERT INTO settings (key, value) VALUES ('tax_go_live', '0') ON CONFLICT(key) DO UPDATE SET value = excluded.value").run();
    audit(ctx, { userId: user.id, action: 'tax.wizard_reset', type: 'tax_wizard', reason: reason.trim() });
  });
  return wizardView(ctx, user);
}
