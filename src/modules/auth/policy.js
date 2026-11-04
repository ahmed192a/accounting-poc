import { AppError } from '../../errors.js';

// Password policy (NIST SP 800-63B flavoured): length over composition rules, a block list, no personal data.
const COMMON = new Set(['password', 'password1', 'password12', 'password123', 'passw0rd', 'qwerty', 'qwertyuiop', 'letmein', 'welcome',
  'welcome1', 'admin', 'administrator', 'iloveyou', 'monkey', 'dragon', 'abc123', '123456', '12345678', '123456789', '1234567890',
  '111111', 'changeme', 'secret', 'accounting', 'accountant', 'trustno1', 'football', 'baseball', 'master', 'login', 'princess']);

export const MIN_LENGTH = 12;
export const MAX_LENGTH = 128;

export function passwordProblems(password, { email, name } = {}) {
  const p = String(password ?? '');
  const problems = [];
  if (p.length < MIN_LENGTH) problems.push(`at least ${MIN_LENGTH} characters`);
  if (p.length > MAX_LENGTH) problems.push(`at most ${MAX_LENGTH} characters`);
  const lower = p.toLowerCase();
  const stripped = lower.replace(/[^a-z0-9]/g, '');
  if (COMMON.has(lower) || COMMON.has(stripped) || [...COMMON].some((c) => c.length >= 6 && stripped.replace(/\d+$/, '') === c)) problems.push('not a commonly used password');
  if (/^(.)\1+$/.test(p)) problems.push('not one repeated character');
  if (p.length >= 4 && p.length <= 40 && ('abcdefghijklmnopqrstuvwxyz0123456789'.includes(lower) || '0123456789'.includes(lower))) problems.push('not a simple sequence');
  const local = String(email ?? '').split('@')[0].toLowerCase();
  if (local.length >= 4 && lower.includes(local)) problems.push('must not contain your e-mail name');
  const first = String(name ?? '').split(/[\s(]/)[0].toLowerCase();
  if (first.length >= 4 && lower.includes(first)) problems.push('must not contain your name');
  const classes = [/[a-z]/, /[A-Z]/, /\d/, /[^A-Za-z0-9]/].filter((r) => r.test(p)).length;
  if (classes < 2 && p.length < 20) problems.push('mix at least two kinds of characters (or use 20+ characters)');
  return problems;
}

export function assertPassword(password, who) {
  const problems = passwordProblems(password, who);
  if (problems.length) throw new AppError(400, 'WEAK_PASSWORD', `Password rejected: ${problems.join('; ')}`, { problems });
  return password;
}
