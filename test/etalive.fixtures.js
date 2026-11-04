import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Throw-away key + self-signed certificate made at test time with the openssl CLI (no key material is stored in the repo).
export const HAVE_OPENSSL = spawnSync('openssl', ['version']).status === 0;

export function makeIdentity(kind = 'rsa') {
  const dir = mkdtempSync(join(tmpdir(), 'etalive-'));
  try {
    const args = kind === 'ec'
      ? ['req', '-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:prime256v1']
      : ['req', '-x509', '-newkey', 'rsa:2048'];
    const r = spawnSync('openssl', [...args, '-nodes', '-keyout', join(dir, 'k.pem'), '-out', join(dir, 'c.pem'), '-days', '30', '-subj', '/CN=TEST ONLY etalive/O=accounting-poc'], { encoding: 'utf8' });
    if (r.status !== 0) throw new Error(`openssl failed: ${r.stderr}`);
    return { keyPem: readFileSync(join(dir, 'k.pem'), 'utf8'), certPem: readFileSync(join(dir, 'c.pem'), 'utf8') };
  } finally { rmSync(dir, { recursive: true, force: true }); }
}
