import { createHash } from 'node:crypto';
import { AppError } from '../../../errors.js';
import { setting } from '../../../db.js';
import { readSecret } from '../secrets.js';

// HTTP client for the LIVE ETA adapter. The ETA pre-production and production endpoints are NOT reachable from the build
// environment, so this has only ever talked to a fake server written in test/etalive.*.test.js. Every path, field name,
// status code and header below is recalled from public ETA SDK documentation and is UNVERIFIED (docs/eta-live.md).
//
// Secrets: client id/secret come from the tax secret store at call time, are sent only to the configured identity URL and are
// never logged, audited, returned or included in an error message (errors pass through redact()).

export const LIVE_DEFAULTS = {
  tax_eta_id_url: '',                 // identity service base, e.g. https://id.preprod.eta.gov.eg   (UNVERIFIED host names)
  tax_eta_api_url: '',                // invoicing API base incl. version, e.g. https://api.preprod.invoicing.eta.gov.eg/api/v1.0
  tax_eta_scope: 'InvoicingAPI',      // UNVERIFIED
  tax_eta_signer: 'pem',
  tax_eta_cms_detached: '0',          // UNVERIFIED whether the authority wants the signed content attached
  tax_eta_batch_size: '10',           // UNVERIFIED limit
  tax_eta_max_retries: '4',
  tax_eta_backoff_ms: '1000',
  tax_eta_max_wait_ms: '30000',
  tax_eta_timeout_ms: '20000',
  tax_eta_onbehalfof: '',             // optional intermediary header value (taxpayer registration number) UNVERIFIED
  tax_eta_document_version: '1.0',    // UNVERIFIED (the portal also knows 0.9 for unsigned documents)
  tax_eta_share_base: 'https://invoicing.eta.gov.eg', // UNVERIFIED, used for the QR / share link
  tax_eta_test_ok: '0',               // set by POST /api/tax/live/test, read by the registration wizard
};
export const liveCfg = (db) => Object.fromEntries(Object.keys(LIVE_DEFAULTS).map((k) => [k, setting(db, k) ?? LIVE_DEFAULTS[k]]));

// Test seams (module level so tests can speed up time without touching settings).
export const runtime = {
  fetch: (...a) => globalThis.fetch(...a),
  sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
};

const tokens = new Map(); // sha256(idUrl|clientId|secret) -> { token, expiresAt }
export const clearTokenCache = () => tokens.clear();

/** Remove secret values from any text that might reach a log, an audit row or a response. */
export function redact(text, secrets) {
  let out = String(text ?? '');
  for (const s of secrets) if (s && s.length >= 4) out = out.split(s).join('[redacted]');
  return out.slice(0, 500);
}

/** http(s) URL; plain http is only accepted for loopback hosts (local fake server, tunnels). */
export function checkUrl(v, field) {
  let u;
  try { u = new URL(v); } catch { throw new AppError(400, 'BAD_INPUT', `${field} must be an absolute URL`); }
  const loop = ['localhost', '127.0.0.1', '[::1]'].includes(u.hostname);
  if (u.protocol !== 'https:' && !(u.protocol === 'http:' && loop)) throw new AppError(400, 'BAD_INPUT', `${field} must be an https URL (http is only accepted for localhost)`);
  if (u.username || u.password) throw new AppError(400, 'BAD_INPUT', `${field} must not contain credentials`);
  return v.replace(/\/+$/, '');
}

const RETRYABLE = new Set([429, 502, 503, 504]);

function retryAfterMs(h) {
  const v = h?.get?.('retry-after');
  if (!v) return null;
  if (/^\d+$/.test(v.trim())) return Number(v) * 1000;
  const t = Date.parse(v);
  return Number.isNaN(t) ? null : Math.max(0, t - Date.now()); // HTTP-date form: real clock, it is the server's wall time
}

export function createEtaClient(ctx) {
  const db = ctx.db, cfg = liveCfg(db);
  const idUrl = cfg.tax_eta_id_url, apiUrl = cfg.tax_eta_api_url;
  if (!idUrl || !apiUrl) throw new AppError(409, 'LIVE_NOT_CONFIGURED', 'Set the ETA identity URL and API URL first (PUT /api/tax/live/config)');
  checkUrl(idUrl, 'tax_eta_id_url'); checkUrl(apiUrl, 'tax_eta_api_url');
  const clientId = readSecret(db, 'eta_client_id'), clientSecret = readSecret(db, 'eta_client_secret');
  if (!clientId || !clientSecret) throw new AppError(409, 'LIVE_NOT_CONFIGURED', 'Save eta_client_id and eta_client_secret in the credentials first');
  const secrets = [clientId, clientSecret, readSecret(db, 'eta_signing_pin')];
  const maxRetries = Number(cfg.tax_eta_max_retries), backoff = Number(cfg.tax_eta_backoff_ms), maxWait = Number(cfg.tax_eta_max_wait_ms), timeout = Number(cfg.tax_eta_timeout_ms);
  const cacheKey = createHash('sha256').update(`${idUrl}|${clientId}|${clientSecret}`).digest('hex');

  async function once(url, init) {
    return runtime.fetch(url, { ...init, signal: AbortSignal.timeout(timeout), redirect: 'error' });
  }

  async function token(force = false) {
    const hit = tokens.get(cacheKey);
    if (!force && hit && hit.expiresAt > ctx.now()) return hit.token;
    const res = await send(`${idUrl}/connect/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
      body: new URLSearchParams({ grant_type: 'client_credentials', client_id: clientId, client_secret: clientSecret, scope: cfg.tax_eta_scope }).toString(),
    }, { auth: false });
    const body = await readJson(res);
    if (res.status !== 200 || !body?.access_token) {
      tokens.delete(cacheKey);
      throw new AppError(502, 'ETA_AUTH_FAILED', `ETA token request failed (HTTP ${res.status}${body?.error ? `, ${redact(body.error, secrets)}` : ''})`);
    }
    const ttl = Math.max(30, Number(body.expires_in) || 3600) - 30; // refresh 30 s early
    tokens.set(cacheKey, { token: body.access_token, expiresAt: ctx.now() + ttl * 1000 });
    return body.access_token;
  }

  /** Network + retry policy shared by every call: backoff on network errors, 429 and 502-504, honouring Retry-After. */
  async function send(url, init, { auth = true } = {}) {
    let refreshed = false;
    for (let attempt = 0; ; attempt++) {
      let res;
      try {
        const headers = { accept: 'application/json', ...init.headers };
        if (auth) {
          headers.authorization = `Bearer ${await token(refreshed)}`;
          if (cfg.tax_eta_onbehalfof) headers.onbehalfof = cfg.tax_eta_onbehalfof;
        }
        res = await once(url, { ...init, headers });
      } catch (e) {
        if (e instanceof AppError) throw e;
        if (attempt >= maxRetries) throw new AppError(503, 'TAX_UNREACHABLE', `ETA is unreachable (${redact(e.cause?.code ?? e.name, secrets)})`);
        await runtime.sleep(Math.min(maxWait, backoff * 2 ** attempt));
        continue;
      }
      if (res.status === 401 && auth && !refreshed) { refreshed = true; tokens.delete(cacheKey); continue; } // expired or revoked token: one fresh try
      if (RETRYABLE.has(res.status)) {
        if (attempt >= maxRetries) {
          throw new AppError(503, 'TAX_UNREACHABLE', res.status === 429 ? 'ETA rate limit reached; will retry later' : `ETA is unavailable (HTTP ${res.status})`, { httpStatus: res.status, rateLimited: res.status === 429 });
        }
        await res.arrayBuffer().catch(() => {});
        await runtime.sleep(Math.min(maxWait, retryAfterMs(res.headers) ?? backoff * 2 ** attempt));
        continue;
      }
      return res;
    }
  }

  async function readJson(res) { try { return await res.json(); } catch { return null; } }
  const api = async (method, path, json) => {
    const res = await send(`${apiUrl}${path}`, { method, headers: json ? { 'content-type': 'application/json' } : {}, body: json ? JSON.stringify(json) : undefined });
    return { status: res.status, body: await readJson(res) };
  };

  return {
    secrets, cfg,
    token,
    /** POST /documentsubmissions. Returns { submissionId, accepted:[{uuid,longId,internalId}], rejected:[{internalId,code,message,details}] } or { batchError }. */
    async submit(signedDocs) {
      const r = await api('POST', '/documentsubmissions', { documents: signedDocs });
      if (r.status === 200 || r.status === 202) {
        const b = r.body ?? {};
        return {
          submissionId: b.submissionId ?? null,
          accepted: (b.acceptedDocuments ?? []).map((d) => ({ uuid: d.uuid, longId: d.longId ?? null, internalId: d.internalId })),
          rejected: (b.rejectedDocuments ?? []).map((d) => ({ internalId: d.internalId, code: d.error?.code ?? 'REJECTED', message: errText(d.error, secrets), details: (d.error?.details ?? []).map((x) => errText(x, secrets)) })),
        };
      }
      if (r.status >= 400 && r.status < 500) return { batchError: { httpStatus: r.status, code: r.body?.error?.code ?? r.body?.code ?? `HTTP_${r.status}`, message: errText(r.body?.error ?? r.body, secrets) } };
      throw new AppError(502, 'ETA_BAD_RESPONSE', `Unexpected ETA response (HTTP ${r.status})`);
    },
    /** GET /documents/{uuid}/details -> { status: 'Submitted'|'Valid'|'Invalid'|'Rejected'|'Cancelled', longId, errors[] } (UNVERIFIED shape). */
    async details(uuid) {
      const r = await api('GET', `/documents/${encodeURIComponent(uuid)}/details`);
      if (r.status === 404) return { status: 'Unknown', errors: [] };
      if (r.status !== 200 || !r.body) throw new AppError(502, 'ETA_BAD_RESPONSE', `Unexpected ETA response (HTTP ${r.status})`);
      const steps = r.body.validationResults?.validationSteps ?? [];
      const errors = steps.filter((s) => s.status && String(s.status).toLowerCase() === 'invalid').map((s) => ({ step: s.name ?? '', code: s.error?.errorCode ?? s.error?.code ?? 'INVALID', message: errText(s.error, secrets) }));
      return { status: r.body.status, longId: r.body.longId ?? null, errors };
    },
    /** PUT /documents/state/{uuid}/state: issuer 'cancelled' or receiver 'rejected', both with a reason. */
    async changeState(uuid, status, reason) {
      const r = await api('PUT', `/documents/state/${encodeURIComponent(uuid)}/state`, { status, reason });
      if (r.status === 200 || r.status === 204) return { ok: true };
      if (r.status === 404) throw new AppError(404, 'ETA_DOCUMENT_UNKNOWN', 'ETA does not know this document');
      throw new AppError(409, 'ETA_STATE_REFUSED', `ETA refused the ${status} request: ${errText(r.body?.error ?? r.body, secrets) || `HTTP ${r.status}`}`);
    },
  };
}

function errText(e, secrets) {
  if (!e) return '';
  if (typeof e === 'string') return redact(e, secrets);
  return redact(e.message ?? e.error ?? e.errorMessage ?? e.details ?? JSON.stringify(e), secrets);
}
