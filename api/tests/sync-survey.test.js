'use strict';
/* API automation for POST /sync-survey  ->  run: npm run test:api  (Node >= 18, zero dependencies) */
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { createServer } = require('../mock-server/server');

let srv, base; const TOKEN = 'test-token';
const post = (body, { token = TOKEN, raw, headers = {} } = {}) =>
  fetch(`${base}/sync-survey`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}), ...headers },
    body: raw !== undefined ? raw : JSON.stringify(body),
  });
const get = async (id) => (await fetch(`${base}/surveys/${id}`, { headers: { Authorization: `Bearer ${TOKEN}` } })).json();
const item = (over = {}) => ({
  localId: 'School_1', createdAt: '2026-09-30T10:00:00+05:30',
  entity: { type: 'school', name: 'Govt Primary School' }, answers: { q_1: 'Ankit', q_2: '3rd' }, ...over,
});
const uniq = (p) => `${p}_${Math.random().toString(36).slice(2, 8)}`;

before(async () => { srv = createServer(); await new Promise((r) => srv.listen(0, r)); base = `http://127.0.0.1:${srv.address().port}`; });
after(() => srv.close());

test('TC-API-01 two devices, SAME localId (School_1) -> two records, nothing overwritten', async () => {
  const ankit = uniq('ankit'), pooja = uniq('pooja');
  const a = await (await post({ deviceId: ankit, surveys: [item({ answers: { q_1: 'Ankit' } })] })).json();
  const rp = await post({ deviceId: pooja, surveys: [item({ answers: { q_1: 'Pooja' } })] });
  const p = await rp.json();
  assert.equal(rp.status, 201);
  assert.equal(a.results[0].status, 'created'); assert.equal(p.results[0].status, 'created');
  assert.notEqual(a.results[0].serverId, p.results[0].serverId, 'server ids must differ');
  assert.equal((await get(a.results[0].serverId)).answers.q_1, 'Ankit', "Ankit's data must survive Pooja's sync");
  assert.equal((await get(p.results[0].serverId)).answers.q_1, 'Pooja');
});

test('TC-API-02 both phones sync at the exact same instant (parallel) -> no lost write', async () => {
  const [d1, d2] = [uniq('d'), uniq('d')];
  const [r1, r2] = await Promise.all([
    post({ deviceId: d1, surveys: [item({ answers: { who: 'A' } })] }),
    post({ deviceId: d2, surveys: [item({ answers: { who: 'B' } })] }),
  ]);
  const [j1, j2] = [await r1.json(), await r2.json()];
  assert.deepEqual([r1.status, r2.status], [201, 201]);
  assert.equal((await get(j1.results[0].serverId)).answers.who, 'A');
  assert.equal((await get(j2.results[0].serverId)).answers.who, 'B');
});

test('TC-API-03 retry of the same payload (timeout/99% drop) is idempotent - no duplicate row', async () => {
  const d = uniq('d'); const before = (await (await fetch(`${base}/stats`, { headers: { Authorization: `Bearer ${TOKEN}` } })).json()).total;
  const first = await (await post({ deviceId: d, surveys: [item()] })).json();
  const retryRes = await post({ deviceId: d, surveys: [item()] });
  const retry = await retryRes.json();
  assert.equal(retryRes.status, 200);
  assert.equal(retry.results[0].status, 'duplicate_replayed');
  assert.equal(retry.results[0].serverId, first.results[0].serverId);
  const after = (await (await fetch(`${base}/stats`, { headers: { Authorization: `Bearer ${TOKEN}` } })).json()).total;
  assert.equal(after - before, 1, 'exactly one record created for two identical requests');
});

test('TC-API-04 same device reuses localId with DIFFERENT data -> 207 conflict, original untouched', async () => {
  const d = uniq('d');
  const first = await (await post({ deviceId: d, surveys: [item({ answers: { q_1: 'original' } })] })).json();
  const res = await post({ deviceId: d, surveys: [item({ answers: { q_1: 'tampered' } })] });
  const j = await res.json();
  assert.equal(res.status, 207);
  assert.equal(j.results[0].status, 'conflict');
  assert.equal((await get(first.results[0].serverId)).answers.q_1, 'original');
});

test('TC-API-05 same school registered by two devices -> both kept, flagged possibleDuplicateOf (no silent merge)', async () => {
  const [d1, d2] = [uniq('d'), uniq('d')]; const name = uniq('Govt School');
  const a = await (await post({ deviceId: d1, surveys: [item({ entity: { type: 'school', name } })] })).json();
  const b = await (await post({ deviceId: d2, surveys: [item({ localId: 'School_9', entity: { type: 'school', name: `  ${name.toUpperCase()} ` } })] })).json();
  assert.deepEqual(b.results[0].possibleDuplicateOf, [a.results[0].serverId]);
  assert.equal(b.results[0].status, 'created');
});

test('TC-API-06 client cannot choose/overwrite serverId (mass assignment)', async () => {
  const [d1, d2] = [uniq('d'), uniq('d')];
  const victim = await (await post({ deviceId: d1, surveys: [item({ answers: { q_1: 'victim' } })] })).json();
  const atk = await (await post({ deviceId: d2, surveys: [item({ serverId: victim.results[0].serverId, answers: { q_1: 'attacker' } })] })).json();
  assert.notEqual(atk.results[0].serverId, victim.results[0].serverId);
  assert.equal((await get(victim.results[0].serverId)).answers.q_1, 'victim');
});

test('TC-API-07 batch with one bad item -> 207, good items still saved (partial success)', async () => {
  const d = uniq('d');
  const res = await post({ deviceId: d, surveys: [item({ localId: 'S_1' }), item({ localId: 'S_2', answers: 'oops' }), item({ localId: 'S_3' })] });
  const j = await res.json();
  assert.equal(res.status, 207);
  assert.deepEqual(j.results.map((r) => r.status), ['created', 'rejected', 'created']);
});

test('TC-API-08 same localId across a batch on same device but different payload does not corrupt first item', async () => {
  const d = uniq('d');
  const j = await (await post({ deviceId: d, surveys: [item({ answers: { v: 1 } }), item({ answers: { v: 2 } })] })).json();
  assert.deepEqual(j.results.map((r) => r.status), ['created', 'conflict']);
  assert.equal((await get(j.results[0].serverId)).answers.v, 1);
});

for (const [name, body, code] of [
  ['missing deviceId', { surveys: [item()] }, 400],
  ['empty surveys array', { deviceId: 'x', surveys: [] }, 400],
  ['surveys not an array', { deviceId: 'x', surveys: 'nope' }, 400],
]) test(`TC-API-09 validation: ${name} -> ${code}`, async () => assert.equal((await post(body)).status, code));

test('TC-API-10 malformed JSON -> 400, no crash; server still healthy afterwards', async () => {
  assert.equal((await post(null, { raw: '{"deviceId": "x", "surveys": [' })).status, 400);
  assert.equal((await fetch(`${base}/health`)).status, 200);
});

test('TC-API-11 auth: missing / wrong token -> 401', async () => {
  assert.equal((await post({ deviceId: 'x', surveys: [item()] }, { token: null })).status, 401);
  assert.equal((await post({ deviceId: 'x', surveys: [item()] }, { token: 'bad' })).status, 401);
});

test('TC-API-12 wrong content-type -> 415; oversize batch -> 413', async () => {
  assert.equal((await post(null, { raw: 'x=1', headers: { 'Content-Type': 'text/plain' } })).status, 415);
  const big = Array.from({ length: 51 }, (_, i) => item({ localId: `L_${i}` }));
  assert.equal((await post({ deviceId: uniq('d'), surveys: big })).status, 413);
});

test('TC-API-13 unicode / Hindi payload round-trips byte-exact', async () => {
  const d = uniq('d'); const answers = { q_1: 'राम कुमार', q_2: '😀 ಕನ್ನಡ' };
  const j = await (await post({ deviceId: d, surveys: [item({ entity: { type: 'school', name: 'सरकारी प्राथमिक विद्यालय' }, answers })] })).json();
  assert.deepEqual((await get(j.results[0].serverId)).answers, answers);
});

test('TC-API-14 thundering herd: 300 devices, all "School_1", in parallel -> 300 distinct records, 0 lost', async () => {
  const s2 = createServer(); await new Promise((r) => s2.listen(0, r));
  const b2 = `http://127.0.0.1:${s2.address().port}`;
  const N = 300;
  const rs = await Promise.all(Array.from({ length: N }, (_, i) => fetch(`${b2}/sync-survey`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${TOKEN}` },
    body: JSON.stringify({ deviceId: `dev_${i}`, surveys: [item({ answers: { n: i } })] }),
  }).then((r) => r.json())));
  const ids = new Set(rs.map((r) => r.results[0].serverId));
  assert.equal(ids.size, N); assert.equal(s2.records.size, N);
  for (let i = 0; i < N; i += 37) assert.equal(s2.records.get(rs[i].results[0].serverId).answers.n, i);
  s2.close();
});

test('TC-API-15 burst protection: over-limit -> 429 + Retry-After; client back-off then succeeds (no data loss)', async () => {
  const s3 = createServer({ rateLimitPerWindow: 5, windowMs: 400 }); await new Promise((r) => s3.listen(0, r));
  const b3 = `http://127.0.0.1:${s3.address().port}`;
  const send = (i) => fetch(`${b3}/sync-survey`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${TOKEN}` },
    body: JSON.stringify({ deviceId: `dev_${i}`, surveys: [item()] }) });
  const first = await Promise.all(Array.from({ length: 12 }, (_, i) => send(i)));
  const limited = first.filter((r) => r.status === 429);
  assert.ok(limited.length >= 1, 'expected some 429s');
  assert.ok(limited.every((r) => r.headers.get('retry-after')), '429 must carry Retry-After');
  const pending = first.map((r, i) => [r, i]).filter(([r]) => r.status === 429).map(([, i]) => i);
  await new Promise((r) => setTimeout(r, 450));
  const retried = await Promise.all(pending.slice(0, 5).map(send));
  assert.ok(retried.every((r) => r.status === 201), 'retries after back-off succeed');
  s3.close();
});
