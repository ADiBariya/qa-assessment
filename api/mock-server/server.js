'use strict';
/* Mock backend for POST /sync-survey - the "system under test" for the API automation.
 * Contract (what the real backend SHOULD do):
 *  - a record is identified server-side by (deviceId, localId); serverId is ALWAYS server generated
 *  - same device+localId+same payload  -> idempotent replay (200-style item: duplicate_replayed)
 *  - same device+localId+different payload -> conflict (never overwrite)
 *  - different devices with the same localId -> two separate records
 *  - same school name from different devices -> both stored + possibleDuplicateOf (dedupe is a human/merge decision)
 *  - burst protection: 429 + Retry-After so 50k phones can back off
 */
const http = require('node:http');
const crypto = require('node:crypto');

const stable = (o) => JSON.stringify(sortKeys(o));
function sortKeys(v) {
  if (Array.isArray(v)) return v.map(sortKeys);
  if (v && typeof v === 'object') return Object.fromEntries(Object.keys(v).sort().map((k) => [k, sortKeys(v[k])]));
  return v;
}
const hash = (o) => crypto.createHash('sha256').update(stable(o)).digest('hex');

function createServer(opts = {}) {
  const { rateLimitPerWindow = Infinity, windowMs = 1000, maxBodyBytes = 1_000_000, authToken = 'test-token', maxBatch = 50 } = opts;
  const records = new Map();   // serverId -> record
  const byKey = new Map();     // deviceId::localId -> serverId
  let windowStart = Date.now(), windowCount = 0;

  const send = (res, code, body, headers = {}) => {
    res.writeHead(code, { 'Content-Type': 'application/json', ...headers });
    res.end(JSON.stringify(body));
  };

  function validateItem(it) {
    const errs = [];
    if (!it || typeof it !== 'object') return ['item must be an object'];
    if (typeof it.localId !== 'string' || !it.localId.trim()) errs.push('localId is required');
    if (!it.entity || typeof it.entity.name !== 'string' || !it.entity.name.trim()) errs.push('entity.name is required');
    if (!it.answers || typeof it.answers !== 'object' || Array.isArray(it.answers)) errs.push('answers must be an object');
    if (typeof it.createdAt !== 'string' || Number.isNaN(Date.parse(it.createdAt))) errs.push('createdAt must be an ISO date');
    return errs;
  }

  function processItem(deviceId, it) {
    const errs = validateItem(it);
    if (errs.length) return { localId: it && it.localId, status: 'rejected', errors: errs };
    const { serverId: _ignored, ...clientData } = it; // mass-assignment guard: client can never choose serverId
    const key = `${deviceId}::${it.localId}`;
    const h = hash(clientData);
    const existingId = byKey.get(key);
    if (existingId) {
      const ex = records.get(existingId);
      return ex.hash === h
        ? { localId: it.localId, status: 'duplicate_replayed', serverId: existingId }
        : { localId: it.localId, status: 'conflict', serverId: existingId, reason: 'LOCAL_ID_REUSED_WITH_DIFFERENT_PAYLOAD' };
    }
    const name = it.entity.name.trim().toLowerCase();
    const possibleDuplicateOf = [...records.values()]
      .filter((r) => r.deviceId !== deviceId && r.entity.name.trim().toLowerCase() === name).map((r) => r.serverId);
    const serverId = `srv_${crypto.randomUUID()}`;
    records.set(serverId, { serverId, deviceId, ...clientData, hash: h, receivedAt: new Date().toISOString(), possibleDuplicateOf });
    byKey.set(key, serverId);
    return { localId: it.localId, status: 'created', serverId, possibleDuplicateOf };
  }

  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://x');
    if (req.method === 'GET' && url.pathname === '/health') return send(res, 200, { ok: true });
    if (req.headers.authorization !== `Bearer ${authToken}`) return send(res, 401, { error: 'unauthorized' });

    if (req.method === 'GET' && url.pathname.startsWith('/surveys/')) {
      const r = records.get(url.pathname.split('/')[2]);
      return r ? send(res, 200, r) : send(res, 404, { error: 'not_found' });
    }
    if (req.method === 'GET' && url.pathname === '/stats') return send(res, 200, { total: records.size });
    if (!(req.method === 'POST' && url.pathname === '/sync-survey')) return send(res, 404, { error: 'not_found' });

    const now = Date.now();
    if (now - windowStart >= windowMs) { windowStart = now; windowCount = 0; }
    if (++windowCount > rateLimitPerWindow) {
      req.resume();
      return send(res, 429, { error: 'too_many_requests' }, { 'Retry-After': '1' });
    }

    let size = 0; const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > maxBodyBytes) { send(res, 413, { error: 'payload_too_large' }); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      if (res.writableEnded) return;
      if (!(req.headers['content-type'] || '').includes('application/json')) return send(res, 415, { error: 'unsupported_media_type' });
      let body;
      try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { return send(res, 400, { error: 'invalid_json' }); }
      if (!body || typeof body.deviceId !== 'string' || !body.deviceId) return send(res, 400, { error: 'deviceId is required' });
      if (!Array.isArray(body.surveys) || body.surveys.length === 0) return send(res, 400, { error: 'surveys must be a non-empty array' });
      if (body.surveys.length > maxBatch) return send(res, 413, { error: `max ${maxBatch} surveys per request` });
      const results = body.surveys.map((it) => processItem(body.deviceId, it));
      const bad = results.some((r) => r.status === 'rejected' || r.status === 'conflict');
      const created = results.some((r) => r.status === 'created');
      return send(res, bad ? 207 : created ? 201 : 200, { results });
    });
  });
  server.records = records;
  return server;
}

module.exports = { createServer };
if (require.main === module) {
  const port = process.env.PORT || 3000;
  createServer().listen(port, () => console.log(`mock sync API on :${port} (token: test-token)`));
}
