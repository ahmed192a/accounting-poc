import http from 'node:http';

// A local fake of the ETA identity + invoicing endpoints, written from the same UNVERIFIED recollection as the adapter.
// It checks what the adapter must do (token, bearer, signature present) and lets tests script failures.
export async function startFakeEta({ clientId = 'cid-123', clientSecret = 'csecret-VALUE-9876' } = {}) {
  const st = {
    tokensIssued: 0, tokenTtl: 3600, requests: [], submissions: [], docs: new Map(), // uuid -> { status, longId, errors, internalId }
    script: [], // queue of { match: (req)=>bool, status, headers, body } responses consumed first
    rejectInternalIds: new Set(), duplicateInternalIds: new Set(), validTokens: new Set(), revokeAll: false, stateCalls: [],
    stateStatus: 200,
  };
  const server = http.createServer(async (req, res) => {
    const chunks = []; for await (const c of req) chunks.push(c);
    const raw = Buffer.concat(chunks).toString('utf8');
    const url = new URL(req.url, 'http://x');
    const entry = { method: req.method, path: url.pathname, headers: req.headers, raw, body: null };
    if (req.headers['content-type']?.includes('json') && raw) entry.body = JSON.parse(raw);
    st.requests.push(entry);
    const send = (status, body, headers = {}) => { res.writeHead(status, { 'content-type': 'application/json', ...headers }); res.end(body === undefined ? '' : JSON.stringify(body)); };
    const idx = st.script.findIndex((s) => s.match(entry));
    if (idx >= 0) { const s = st.script.splice(idx, 1)[0]; return send(s.status, s.body, s.headers); }

    if (url.pathname === '/connect/token' && req.method === 'POST') {
      const f = new URLSearchParams(raw);
      if (f.get('grant_type') !== 'client_credentials' || f.get('client_id') !== clientId || f.get('client_secret') !== clientSecret) return send(400, { error: 'invalid_client' });
      const t = `tok-${++st.tokensIssued}`; st.validTokens.add(t);
      return send(200, { access_token: t, expires_in: st.tokenTtl, token_type: 'Bearer', scope: f.get('scope') });
    }
    const bearer = /^Bearer (.+)$/.exec(req.headers.authorization ?? '')?.[1];
    if (!bearer || !st.validTokens.has(bearer) || st.revokeAll) return send(401, { error: 'unauthorized' });
    if (url.pathname === '/api/v1.0/documentsubmissions' && req.method === 'POST') {
      const docs = entry.body?.documents;
      if (!Array.isArray(docs) || !docs.length) return send(400, { error: { code: 'BadStructure', message: 'documents required' } });
      const accepted = [], rejected = [], submissionId = `SUB-${st.submissions.length + 1}`;
      for (const d of docs) {
        if (!d.signatures?.[0]?.value) { rejected.push({ internalId: d.internalID, error: { code: 'MissingSignature', message: 'signature required', details: [] } }); continue; }
        if (st.duplicateInternalIds.has(d.internalID)) { rejected.push({ internalId: d.internalID, error: { code: 'DuplicateSubmission', message: 'already submitted', details: [] } }); continue; }
        if (st.rejectInternalIds.has(d.internalID)) { rejected.push({ internalId: d.internalID, error: { code: 'BadItemCode', message: 'Item code is not registered', details: [{ message: 'line 1' }] } }); continue; }
        st.docs.set(d.uuid, { status: 'Submitted', longId: `LONG-${d.uuid.slice(0, 8)}`, errors: [], internalId: d.internalID });
        accepted.push({ uuid: d.uuid, longId: `LONG-${d.uuid.slice(0, 8)}`, internalId: d.internalID });
      }
      st.submissions.push({ id: submissionId, docs });
      return send(202, { submissionId, acceptedDocuments: accepted, rejectedDocuments: rejected });
    }
    let m;
    if ((m = /^\/api\/v1\.0\/documents\/([^/]+)\/details$/.exec(url.pathname)) && req.method === 'GET') {
      const d = st.docs.get(m[1]);
      if (!d) return send(404, { error: { code: 'NotFound' } });
      return send(200, { uuid: m[1], status: d.status, longId: d.longId, validationResults: { status: d.status, validationSteps: d.errors.map((e) => ({ name: e.step, status: 'Invalid', error: { errorCode: e.code, error: e.message } })) } });
    }
    if ((m = /^\/api\/v1\.0\/documents\/state\/([^/]+)\/state$/.exec(url.pathname)) && req.method === 'PUT') {
      st.stateCalls.push({ uuid: m[1], ...entry.body });
      if (st.stateStatus !== 200) return send(st.stateStatus, { error: { code: 'NotAllowed', message: 'too late to cancel' } });
      const d = st.docs.get(m[1]); if (d && entry.body.status === 'cancelled') d.status = 'Cancelled';
      return send(200, {});
    }
    return send(404, { error: { code: 'NoRoute' } });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  return {
    st, base, idUrl: base, apiUrl: `${base}/api/v1.0`, clientId, clientSecret,
    count: (p, method) => st.requests.filter((r) => r.path === p && (!method || r.method === method)).length,
    close: () => new Promise((r) => { server.closeAllConnections?.(); server.close(r); }),
  };
}
