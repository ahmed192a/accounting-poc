import { isIP } from 'node:net';
import { lookup } from 'node:dns/promises';
import { AppError } from '../../errors.js';

// SSRF guard for outbound webhooks: refuse loopback, private, link-local, CGNAT, multicast, reserved and
// metadata addresses, credentials in URLs, and internal host names. Applied when a webhook is registered
// (literal addresses and names) and again before every delivery (after resolving DNS).
// LIMIT: Node's fetch resolves the name again when connecting, so a hostile DNS server could answer differently
// the second time (DNS rebinding). Run webhook delivery behind an egress proxy or firewall for full protection.

const V4_BLOCKS = [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16], ['172.16.0.0', 12],
  ['192.0.0.0', 24], ['192.0.2.0', 24], ['192.88.99.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15], ['198.51.100.0', 24],
  ['203.0.113.0', 24], ['224.0.0.0', 4], ['240.0.0.0', 4],
];
const v4ToInt = (s) => s.split('.').reduce((a, b) => a * 256 + Number(b), 0);

export function isPrivateV4(ip) {
  const n = v4ToInt(ip);
  return V4_BLOCKS.some(([base, bits]) => Math.floor(n / 2 ** (32 - bits)) === Math.floor(v4ToInt(base) / 2 ** (32 - bits)));
}

/** Expand an IPv6 literal (no brackets, no zone) to eight 16-bit groups, or null. */
export function parseV6(ip) {
  let s = ip.toLowerCase();
  const v4 = /(\d+\.\d+\.\d+\.\d+)$/.exec(s);
  if (v4) {
    const n = v4ToInt(v4[1]);
    s = s.slice(0, -v4[1].length) + ((n >>> 16) & 0xffff).toString(16) + ':' + (n & 0xffff).toString(16);
  }
  const halves = s.split('::');
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(':') : [];
  const tail = halves.length === 2 && halves[1] ? halves[1].split(':') : [];
  const fill = halves.length === 2 ? 8 - head.length - tail.length : 0;
  if (fill < 0 || (halves.length === 1 && head.length !== 8)) return null;
  const groups = [...head, ...Array(fill).fill('0'), ...tail].map((g) => parseInt(g, 16));
  return groups.length === 8 && groups.every((g) => g >= 0 && g <= 0xffff) ? groups : null;
}

export function isPrivateV6(ip) {
  const g = parseV6(ip);
  if (!g) return true; // unparseable: refuse
  const embedded = (a, b) => `${a >> 8}.${a & 255}.${b >> 8}.${b & 255}`;
  if (g.every((x) => x === 0)) return true;                                      // ::
  if (g.slice(0, 7).every((x) => x === 0) && g[7] === 1) return true;            // ::1
  if (g.slice(0, 5).every((x) => x === 0) && g[5] === 0xffff) return isPrivateV4(embedded(g[6], g[7])); // ::ffff:a.b.c.d
  if (g.slice(0, 6).every((x) => x === 0)) return isPrivateV4(embedded(g[6], g[7])); // IPv4-compatible
  if (g[0] === 0x64 && g[1] === 0xff9b) return isPrivateV4(embedded(g[6], g[7])); // NAT64
  if (g[0] === 0x2002) return isPrivateV4(embedded(g[1], g[2]));                 // 6to4
  if ((g[0] & 0xfe00) === 0xfc00) return true;                                   // fc00::/7 unique local
  if ((g[0] & 0xffc0) === 0xfe80) return true;                                   // fe80::/10 link local
  if ((g[0] & 0xff00) === 0xff00) return true;                                   // multicast
  if (g[0] === 0x2001 && g[1] === 0x0db8) return true;                           // documentation
  return false;
}

export const isPrivateAddress = (ip) => (isIP(ip) === 4 ? isPrivateV4(ip) : isIP(ip) === 6 ? isPrivateV6(ip) : true);

const bad = (why) => new AppError(400, 'UNSAFE_URL', `Webhook URL refused: ${why}`);

/** Syntactic check; returns the parsed URL. Literal IPs are fully checked, names only by pattern. */
export function assertSafeUrlSyntax(raw, { allowHttp = false } = {}) {
  let u;
  try { u = new URL(String(raw)); } catch { throw bad('not a valid URL'); }
  if (u.protocol !== 'https:' && !(allowHttp && u.protocol === 'http:')) throw bad('only https URLs are allowed');
  if (u.username || u.password) throw bad('credentials in the URL are not allowed');
  let host = u.hostname.toLowerCase().replace(/\.$/, '');
  if (host.startsWith('[')) host = host.slice(1, -1);
  if (!host) throw bad('missing host');
  if (isIP(host)) {
    if (isPrivateAddress(host)) throw bad('private, loopback or link-local address');
  } else {
    if (!host.includes('.') || /(^|\.)(localhost|local|internal|lan|intranet|corp|home|home\.arpa|localdomain)$/.test(host)) throw bad('internal host name');
    if (/^[0-9.x]+$/i.test(host)) throw bad('ambiguous numeric host');
  }
  return u;
}

/** Full check before delivery: syntax plus every address the name resolves to. `resolve` is injectable. */
export async function assertSafeUrl(raw, { allowHttp = false, resolve = (h) => lookup(h, { all: true }) } = {}) {
  const u = assertSafeUrlSyntax(raw, { allowHttp });
  let host = u.hostname.replace(/^\[|\]$/g, '');
  if (isIP(host)) return u;
  let addrs;
  try { addrs = await resolve(host); } catch { throw bad('host name does not resolve'); }
  const list = [].concat(addrs).map((a) => (typeof a === 'string' ? a : a.address));
  if (!list.length) throw bad('host name does not resolve');
  if (list.some(isPrivateAddress)) throw bad('host name resolves to a private, loopback or link-local address');
  return u;
}
