'use strict';
/* Scenario E - HFC engine test plan, executable. Run: npm run test:engine */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const E = require('../engine');

const ageCheck = { id: 'hfc_age_edu', action: 'reask_and_flag', match: 'all', severity: 'Soft', show_sup: 1, msg: 'Age/education mismatch',
  logic: [{ attr: 'age', op: '<', val: '15' }, { attr: 'edu', op: '=', val: 'College' }] };
const sleepCheck = { id: 'hfc_sleep', action: 'reask_and_flag', match: 'all', severity: 'Soft', msg: 'Low sleep',
  logic: [{ attr: 'sleep_well', op: '=', val: 'Yes' }, { attr: 'hours', op: '<', val: '6' }] };
const fires = (c, a) => E.checkFires(c, a);

// ---- rule evaluation: positive / negative / boundary / data-type edge cases
const cases = [
  ['HFC-P-01 Age 12 + College fires', ageCheck, { age: 12, edu: 'College' }, true],
  ['HFC-P-02 Sleep Yes + 4h fires', sleepCheck, { sleep_well: 'Yes', hours: 4 }, true],
  ['HFC-N-01 Age 30 + College does not fire', ageCheck, { age: 30, edu: 'College' }, false],
  ['HFC-N-02 Age 12 + Primary does not fire', ageCheck, { age: 12, edu: 'Primary' }, false],
  ['HFC-N-03 Sleep No + 4h does not fire', sleepCheck, { sleep_well: 'No', hours: 4 }, false],
  ['HFC-B-01 boundary Age 15 (not < 15) does not fire', ageCheck, { age: 15, edu: 'College' }, false],
  ['HFC-B-02 boundary Age 14 fires', ageCheck, { age: 14, edu: 'College' }, true],
  ['HFC-B-03 boundary Hours 6 (not < 6) does not fire', sleepCheck, { sleep_well: 'Yes', hours: 6 }, false],
  ['HFC-B-04 boundary Hours 5.99 fires (decimal)', sleepCheck, { sleep_well: 'Yes', hours: 5.99 }, true],
  ['HFC-B-05 Age 0 fires (0 is a real value, not "empty")', ageCheck, { age: 0, edu: 'College' }, true],
  ['HFC-B-06 Hours 0 fires (falsy-zero trap)', sleepCheck, { sleep_well: 'Yes', hours: 0 }, true],
  ['HFC-E-01 numbers typed as strings ("12") still compare numerically', ageCheck, { age: '12', edu: 'College' }, true],
  ['HFC-E-02 "9" < "15" numeric not lexicographic', ageCheck, { age: '9', edu: 'College' }, true],
  ['HFC-E-03 case/space-insensitive option match', ageCheck, { age: 12, edu: ' college ' }, true],
  ['HFC-E-04 age unanswered -> must NOT fire (missing != 0)', ageCheck, { edu: 'College' }, false],
  ['HFC-E-05 age empty string -> must NOT fire', ageCheck, { age: '', edu: 'College' }, false],
  ['HFC-E-06 age non-numeric "abc" -> must NOT fire, no crash', ageCheck, { age: 'abc', edu: 'College' }, false],
  ['HFC-E-07 negative age -18 < 15 fires (range validation is a separate layer)', ageCheck, { age: -18, edu: 'College' }, true],
  ['HFC-E-08 match:any fires if ONE condition true', { ...ageCheck, match: 'any' }, { age: 12, edu: 'Primary' }, true],
  ['HFC-E-09 match:any all false -> no fire', { ...ageCheck, match: 'any' }, { age: 40, edu: 'Primary' }, false],
  ['HFC-E-10 empty logic[] never fires (vacuous truth trap)', { ...ageCheck, logic: [] }, { age: 1 }, false],
];
for (const [name, check, answers, expected] of cases) test(name, () => assert.equal(fires(check, answers), expected));

test('HFC-S-01 typo key "questioID" (as in the supplied schema) is rejected loudly, not silently ignored', () => {
  const bad = { ...sleepCheck, logic: [{ questioID: 'q_2', op: '=', val: 'Yes' }] };
  assert.throws(() => fires(bad, { q_2: 'Yes' }), E.SchemaError);
});
test('HFC-S-02 unknown operator / action -> SchemaError (fail loud)', () => {
  assert.throws(() => fires({ ...ageCheck, logic: [{ attr: 'age', op: '~~', val: 1 }] }, { age: 1 }), E.SchemaError);
  assert.throws(() => new E.HfcSession().evaluate({ ...ageCheck, action: 'explode' }, 'age', { age: 1, edu: 'College' }), E.SchemaError);
});

// ---- actions & loop guard
const bad = { age: 12, edu: 'College' }, good = { age: 22, edu: 'College' };
test('HFC-A-01 reask_and_flag: re-asks, ALWAYS flags, and never loops forever (loop guard)', () => {
  const s = new E.HfcSession(); const seq = [];
  for (let i = 0; i < 10; i++) { const r = s.evaluate(ageCheck, 'age', bad); seq.push(r.status); if (r.status !== 'reask') break; }
  assert.deepEqual(seq, ['reask', 'reask', 'accepted_flagged']);
  assert.equal(s.flags.length, 1);
});
test('HFC-A-02 reask_and_flag: user corrects on 2nd attempt -> passes, flag is still recorded (always flag)', () => {
  const s = new E.HfcSession();
  assert.equal(s.evaluate(ageCheck, 'age', bad).status, 'reask');
  assert.equal(s.evaluate(ageCheck, 'age', good).status, 'pass');
  assert.equal(s.flags.length, 1);
});
test('HFC-A-03 reask_once: re-asks exactly once, then accepts and flags', () => {
  const c = { ...ageCheck, action: 'reask_once' }; const s = new E.HfcSession();
  assert.equal(s.evaluate(c, 'age', bad).status, 'reask');
  assert.equal(s.evaluate(c, 'age', bad).status, 'accepted_flagged');
  assert.equal(s.flags.length, 1);
});
test('HFC-A-04 reask_once: corrected value on the re-ask -> pass and NO flag', () => {
  const c = { ...ageCheck, action: 'reask_once' }; const s = new E.HfcSession();
  s.evaluate(c, 'age', bad); assert.equal(s.evaluate(c, 'age', good).status, 'pass');
  assert.equal(s.flags.length, 0);
});
test('HFC-A-05 flag_silently: never interrupts, records a flag', () => {
  const c = { ...ageCheck, action: 'flag_silently' }; const s = new E.HfcSession();
  assert.equal(s.evaluate(c, 'age', bad).status, 'flagged_silently'); assert.equal(s.flags.length, 1);
});
test('HFC-A-06 block: blocks, then offers supervisor escape after N attempts (no dead end)', () => {
  const c = { ...ageCheck, action: 'block' }; const s = new E.HfcSession(); let last;
  for (let i = 0; i < E.MAX_ATTEMPTS; i++) last = s.evaluate(c, 'age', bad);
  assert.equal(last.status, 'blocked'); assert.equal(last.escape, true);
});
test('HFC-A-07 attempt counter resets after a clean pass (edit -> bad again starts a fresh re-ask)', () => {
  const c = { ...ageCheck, action: 'reask_once' }; const s = new E.HfcSession();
  s.evaluate(c, 'age', bad); s.evaluate(c, 'age', good);
  assert.equal(s.evaluate(c, 'age', bad).status, 'reask');
});
test('HFC-A-08 two independent rules do not share attempt counters', () => {
  const s = new E.HfcSession(); const a = { ...ageCheck, id: 'A' }, b = { ...ageCheck, id: 'B' };
  s.evaluate(a, 'age', bad); s.evaluate(a, 'age', bad);
  assert.equal(s.evaluate(b, 'age', bad).status, 'reask');
});
test('HFC-A-09 duplicate flags are de-duplicated on repeated evaluation', () => {
  const s = new E.HfcSession(); for (let i = 0; i < 5; i++) s.evaluate({ ...ageCheck, action: 'flag_silently' }, 'age', bad);
  assert.equal(s.flags.length, 1);
});

// ---- skip logic x HFC interaction, driven by the REAL supplied (fixed) schema
const schema = JSON.parse(fs.readFileSync(path.join(__dirname, '../../schema/sample-survey-schema.fixed.json'), 'utf8'));
const wellbeing = schema.surveys[1].surveyData; const idx = E.buildIndex(wellbeing);
test('SCH-01 supplied sleep rule: q_3 is HIDDEN whenever q_2 = Yes -> hfc_sleep_plausible is unreachable (BUG-004)', () => {
  const q3 = idx.q_3; const rule = q3.formChecks[0];
  assert.equal(E.isVisible(q3, { q_2: 'Yes' }, idx), false);
  assert.equal(E.isVisible(q3, { q_2: 'No' }, idx), true);
  assert.equal(E.checkFires(rule, { q_2: 'No', q_3: 2 }), false, 'needs q_2=Yes, so cannot fire while q_3 is visible');
});
test('SCH-02 hidden question answer is treated as unanswered by downstream rules (stale answer must not fire HFC)', () => {
  const stale = { q_2: 'Yes', q_3: 2 }; // q_3 answered earlier, then q_2 flipped to Yes -> q_3 hidden
  const effective = Object.fromEntries(Object.entries(stale).filter(([k]) => E.isVisible(idx[k], stale, idx)));
  assert.deepEqual(effective, { q_2: 'Yes' });
});
test('SCH-03 range validation 0..24 (string min/max coerced): 0 ok, 24 ok, 25 rejected, -1 rejected, "" not an error', () => {
  const q3 = idx.q_3;
  assert.equal(E.validate(q3, 0), null); assert.equal(E.validate(q3, 24), null);
  assert.ok(E.validate(q3, 25)); assert.ok(E.validate(q3, -1)); assert.ok(E.validate(q3, 'abc'));
  assert.equal(E.validate(q3, ''), null);
});
test('SCH-04 chained visibility: if the target is itself hidden, the child is hidden too', () => {
  const qm = { a: { questionId: 'a', visibilityLogic: { enabled: false } },
    b: { questionId: 'b', visibilityLogic: { enabled: true, targetQuestion: 'a', condition: 'equals', value: 'Yes' } },
    c: { questionId: 'c', visibilityLogic: { enabled: true, targetQuestion: 'b', condition: 'is_not_empty' } } };
  assert.equal(E.isVisible(qm.c, { a: 'No', b: 'stale' }, qm), false);
  assert.equal(E.isVisible(qm.c, { a: 'Yes', b: 'x' }, qm), true);
});
test('SCH-05 enabled:false means ALWAYS visible even if a target/value is present', () => {
  const q = { questionId: 'x', visibilityLogic: { enabled: false, targetQuestion: 'a', condition: 'equals', value: 'Yes' } };
  assert.equal(E.isVisible(q, {}, {}), true);
});
test('SCH-06 all visibility conditions: equals/not_equals/contains/greater_than/less_than/is_empty/is_not_empty', () => {
  const t = [['equals', 'Yes', 'Yes', true], ['equals', 'yes ', 'Yes', true], ['not_equals', 'No', 'Yes', true], ['not_equals', undefined, 'Yes', true],
    ['contains', ['a', 'b'], 'b', true], ['contains', 'hello', 'ell', true], ['greater_than', 10, 9, true], ['greater_than', 9, 10, false],
    ['less_than', '9', '10', true], ['is_empty', '', undefined, true], ['is_empty', 0, undefined, false], ['is_not_empty', 'x', undefined, true]];
  for (const [op, actual, val, exp] of t) assert.equal(E.compare(op, actual, val), exp, `${op}(${JSON.stringify(actual)}, ${val})`);
});
