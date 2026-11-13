import { AppError } from '../../errors.js';

// Minimal cron: "minute hour day-of-month month day-of-week" in UTC. Each field: * , */n , a , a-b , a-b/n and comma lists.
// Day-of-week 0-6 (0 = Sunday; 7 also accepted). When both day fields are restricted a day matches if EITHER does (classic cron).
const FIELDS = [['minute', 0, 59], ['hour', 0, 23], ['day-of-month', 1, 31], ['month', 1, 12], ['day-of-week', 0, 7]];

export function parseCron(text) {
  const parts = String(text ?? '').trim().split(/\s+/);
  if (parts.length !== 5) throw new AppError(400, 'BAD_CRON', 'cron needs 5 fields: minute hour day-of-month month day-of-week');
  const sets = parts.map((part, i) => {
    const [name, lo, hi] = FIELDS[i];
    const set = new Set();
    for (const item of part.split(',')) {
      const m = /^(\*|\d+(?:-\d+)?)(?:\/(\d+))?$/.exec(item);
      if (!m) throw new AppError(400, 'BAD_CRON', `cron ${name}: cannot read "${item}"`);
      const step = m[2] == null ? 1 : Number(m[2]);
      if (step < 1) throw new AppError(400, 'BAD_CRON', `cron ${name}: step must be at least 1`);
      let a = lo, b = hi;
      if (m[1] !== '*') {
        const [x, y] = m[1].split('-').map(Number);
        a = x; b = y ?? (m[2] == null ? x : hi);
      }
      if (a < lo || b > hi || a > b) throw new AppError(400, 'BAD_CRON', `cron ${name}: ${item} is outside ${lo}-${hi}`);
      for (let v = a; v <= b; v += step) set.add(name === 'day-of-week' && v === 7 ? 0 : v);
    }
    return set;
  });
  return { min: sets[0], hour: sets[1], dom: sets[2], mon: sets[3], dow: sets[4], domAny: parts[2] === '*', dowAny: parts[4] === '*' };
}

/** First matching minute strictly after `after` (epoch ms, UTC), or null if none within 5 years. */
export function nextCron(spec, after) {
  const c = typeof spec === 'string' ? parseCron(spec) : spec;
  const d = new Date(Math.floor(after / 60000) * 60000 + 60000);
  const limit = after + 5 * 366 * 86400000;
  while (d.getTime() <= limit) {
    const dayOk = c.domAny && c.dowAny ? true
      : c.domAny ? c.dow.has(d.getUTCDay())
        : c.dowAny ? c.dom.has(d.getUTCDate())
          : c.dom.has(d.getUTCDate()) || c.dow.has(d.getUTCDay());
    if (!c.mon.has(d.getUTCMonth() + 1) || !dayOk) { d.setUTCHours(0, 0, 0, 0); d.setUTCDate(d.getUTCDate() + 1); continue; }
    if (!c.hour.has(d.getUTCHours())) { d.setUTCMinutes(0, 0, 0); d.setUTCHours(d.getUTCHours() + 1); continue; }
    if (!c.min.has(d.getUTCMinutes())) { d.setUTCMinutes(d.getUTCMinutes() + 1); continue; }
    return d.getTime();
  }
  return null;
}
