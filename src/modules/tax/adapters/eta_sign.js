import { createHash, createPrivateKey, createSign, X509Certificate } from 'node:crypto';
import { AppError } from '../../../errors.js';
import { readSecret } from '../secrets.js';

// Canonical serialisation and signing for the LIVE ETA adapter. EVERYTHING in this file about the format the
// authority expects is UNVERIFIED (written from recollection of the public ETA SDK documentation); see docs/eta-live.md.
//
// 1. canonicalString(document): the string that gets hashed and signed. Recalled rules: drop the top-level `signatures`
//    property, upper-case every property name, wrap every name and every simple value in double quotes, keep the
//    document's property order, and for an array emit the property name once and then, per element, the name again
//    followed by that element's serialisation.
// 2. buildCms(): a CAdES-BES style CMS SignedData (RFC 5652 + signing-certificate-v2 attribute) built with a minimal DER
//    writer, because node:crypto has no CMS API. The signature over the signed attributes is done by a callback so a
//    USB-token / HSM can supply it. Whether the authority wants the content attached or detached is UNVERIFIED: attached by default.

export function canonicalString(doc) {
  const ser = (v) => {
    if (v === null || v === undefined) return '""';
    if (typeof v !== 'object') return `"${String(v)}"`;
    let out = '';
    for (const [k, val] of Object.entries(v)) {
      if (val === undefined) continue;
      const name = `"${k.toUpperCase()}"`;
      if (Array.isArray(val)) {
        out += name;
        for (const item of val) out += name + ser(item);
      } else if (val !== null && typeof val === 'object') out += name + ser(val);
      else out += name + `"${String(val)}"`;
    }
    return out;
  };
  const { signatures, ...rest } = doc; // eslint-disable-line no-unused-vars
  return ser(rest);
}

// ---------- minimal DER ----------
const len = (n) => (n < 128 ? Buffer.from([n]) : n < 256 ? Buffer.from([0x81, n]) : n < 65536 ? Buffer.from([0x82, n >> 8, n & 255]) : Buffer.from([0x83, n >> 16, (n >> 8) & 255, n & 255]));
const tlv = (tag, ...parts) => { const body = Buffer.concat(parts); return Buffer.concat([Buffer.from([tag]), len(body.length), body]); };
const seq = (...p) => tlv(0x30, ...p);
const set = (...p) => tlv(0x31, ...p);
const octets = (b) => tlv(0x04, b);
const nul = () => Buffer.from([0x05, 0x00]);
const oid = (s) => {
  const a = s.split('.').map(Number);
  const bytes = [a[0] * 40 + a[1]];
  for (const n of a.slice(2)) {
    const stack = [n & 127];
    for (let x = n >>> 7; x > 0; x >>>= 7) stack.unshift((x & 127) | 128);
    bytes.push(...stack);
  }
  return tlv(0x06, Buffer.from(bytes));
};
const utcTime = (ms) => {
  const d = new Date(ms), p = (n) => String(n).padStart(2, '0');
  return tlv(0x17, Buffer.from(`${p(d.getUTCFullYear() % 100)}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}Z`));
};
const OID = {
  signedData: '1.2.840.113549.1.7.2', data: '1.2.840.113549.1.7.1', contentType: '1.2.840.113549.1.9.3',
  messageDigest: '1.2.840.113549.1.9.4', signingTime: '1.2.840.113549.1.9.5', sha256: '2.16.840.1.101.3.4.2.1',
  rsa: '1.2.840.113549.1.1.1', ecdsaSha256: '1.2.840.10045.4.3.2', signingCertV2: '1.2.840.113549.1.9.16.2.47',
};
const algId = (o, params = true) => seq(oid(o), ...(params ? [nul()] : []));

/** Read one TLV at `off`: { tag, start (of header), bodyStart, end }. Used to pull issuer and serial out of a certificate. */
function readTlv(buf, off) {
  const tag = buf[off]; let l = buf[off + 1], p = off + 2;
  if (l & 128) { const n = l & 127; l = 0; for (let i = 0; i < n; i++) l = l * 256 + buf[p++]; }
  return { tag, start: off, bodyStart: p, end: p + l };
}
export function certParts(certDer) {
  const cert = readTlv(certDer, 0), tbs = readTlv(certDer, cert.bodyStart);
  let c = readTlv(certDer, tbs.bodyStart);
  if (c.tag === 0xa0) c = readTlv(certDer, c.end); // optional [0] version
  const serial = certDer.subarray(c.start, c.end); // INTEGER TLV
  const sigAlg = readTlv(certDer, c.end), issuer = readTlv(certDer, sigAlg.end);
  return { serial, issuer: certDer.subarray(issuer.start, issuer.end) };
}

/**
 * Build the base64 CMS. `signRaw(bytes) -> Promise<Buffer>` signs the DER of the signed attributes (RSA PKCS#1 v1.5 over
 * SHA-256, or ECDSA over SHA-256 in DER form). `keyType` is 'rsa' or 'ec'.
 */
export async function buildCms({ content, certDer, signRaw, keyType = 'rsa', now, detached = false }) {
  const digest = createHash('sha256').update(content).digest();
  const { serial, issuer } = certParts(certDer);
  const certHash = createHash('sha256').update(certDer).digest();
  const essCert = seq(octets(certHash), seq(seq(tlv(0xa4, issuer)), serial)); // ESSCertIDv2 (sha256 is the default algorithm)
  const attrs = [
    seq(oid(OID.contentType), set(oid(OID.data))),
    seq(oid(OID.signingTime), set(utcTime(now))),
    seq(oid(OID.messageDigest), set(octets(digest))),
    seq(oid(OID.signingCertV2), set(seq(seq(essCert)))),
  ];
  const attrBody = Buffer.concat(attrs.sort(Buffer.compare)); // DER SET OF: sorted
  const toSign = tlv(0x31, attrBody);
  const signature = Buffer.from(await signRaw(toSign));
  const sigAlg = keyType === 'ec' ? algId(OID.ecdsaSha256, false) : algId(OID.rsa);
  const signerInfo = seq(Buffer.from([0x02, 0x01, 0x01]), seq(issuer, serial), algId(OID.sha256), tlv(0xa0, attrBody), sigAlg, octets(signature));
  const encap = detached ? seq(oid(OID.data)) : seq(oid(OID.data), tlv(0xa0, octets(Buffer.from(content, 'utf8'))));
  const signedData = seq(Buffer.from([0x02, 0x01, 0x01]), set(algId(OID.sha256)), encap, tlv(0xa0, certDer), set(signerInfo));
  return seq(oid(OID.signedData), tlv(0xa0, signedData)).toString('base64');
}

// ---------- signer interface ----------
// A signer is { id, sign({ canonical, now, detached }) -> Promise<base64 CMS> }. Factories are registered by name and chosen by the
// setting `tax_eta_signer`. A USB-token or HSM integration registers its own factory (see docs/eta-live.md):
//   registerSigner('hsm', async (ctx) => ({ id: 'hsm', sign: async ({ canonical, now }) => buildCms({ content: canonical, certDer, signRaw: tokenSign, now }) }));
const FACTORIES = new Map();
export const registerSigner = (id, factory) => { if (typeof factory !== 'function') throw new TypeError('signer factory must be a function'); FACTORIES.set(id, factory); };
export const signerIds = () => [...FACTORIES.keys()];

/** Built-in signer: PEM private key + PEM certificate from the tax secret store (never logged, never returned). */
async function pemSigner(ctx) {
  const keyPem = readSecret(ctx.db, 'eta_signing_key_pem'), certPem = readSecret(ctx.db, 'eta_signing_cert_pem');
  if (!keyPem || !certPem) throw new AppError(409, 'SIGNER_NOT_CONFIGURED', 'Save eta_signing_key_pem and eta_signing_cert_pem in the credentials first (or choose another signer)');
  let key, cert;
  try {
    key = createPrivateKey({ key: keyPem, ...(readSecret(ctx.db, 'eta_signing_pin') ? { passphrase: readSecret(ctx.db, 'eta_signing_pin') } : {}) });
    cert = new X509Certificate(certPem);
  } catch {
    throw new AppError(409, 'SIGNER_NOT_CONFIGURED', 'The signing key or certificate could not be read (check the PEM text and passphrase)'); // never echo the key material
  }
  if (!cert.checkPrivateKey(key)) throw new AppError(409, 'SIGNER_NOT_CONFIGURED', 'The signing certificate does not match the private key');
  const keyType = key.asymmetricKeyType === 'ec' ? 'ec' : 'rsa';
  if (!['rsa', 'ec'].includes(key.asymmetricKeyType)) throw new AppError(409, 'SIGNER_NOT_CONFIGURED', 'Only RSA and EC keys are supported by the PEM signer');
  return {
    id: 'pem',
    sign: ({ canonical, now, detached }) => buildCms({
      content: canonical, certDer: cert.raw, keyType, now, detached,
      signRaw: async (bytes) => createSign('sha256').update(bytes).sign(key),
    }),
  };
}
registerSigner('pem', pemSigner);

export async function resolveSigner(ctx, id) {
  const f = FACTORIES.get(id);
  if (!f) throw new AppError(409, 'SIGNER_NOT_CONFIGURED', `Unknown signer "${id}" (registered: ${signerIds().join(', ')})`);
  return f(ctx);
}
