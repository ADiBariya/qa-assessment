/* Reference implementation of the on-device form engine (visibility + HFC).
 * Written from "1.Android App Specification" + "2.Survey Builder Capabilities".
 * It plays the role of the system-under-test for the web/unit automation in this repo.
 * Works in browser (window.QAEngine) and Node (require). */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.QAEngine = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  const MAX_ATTEMPTS = 3; // loop guard: nobody is ever trapped forever
  const OPS = {
    equals: '=', '=': '=', not_equals: '!=', '!=': '!=',
    greater_than: '>', '>': '>', '>=': '>=', less_than: '<', '<': '<', '<=': '<=',
    contains: 'contains', in: 'in', is_empty: 'empty', empty: 'empty',
    is_not_empty: 'not_empty', not_empty: 'not_empty',
  };
  class SchemaError extends Error {}

  const isEmpty = (v) => v === undefined || v === null || v === '' || (Array.isArray(v) && v.length === 0);
  const toNum = (v) => (typeof v === 'number' ? v : (isEmpty(v) || String(v).trim() === '' ? NaN : Number(v)));

  function compare(opName, actual, expected) {
    const op = OPS[opName];
    if (!op) throw new SchemaError(`Unknown operator: ${opName}`);
    if (op === 'empty') return isEmpty(actual);
    if (op === 'not_empty') return !isEmpty(actual);
    if (isEmpty(actual)) return op === '!='; // missing data must never fire relational/equality rules
    const a = toNum(actual), e = toNum(expected);
    const numeric = !Number.isNaN(a) && !Number.isNaN(e);
    const sa = String(actual).trim().toLowerCase(), se = String(expected).trim().toLowerCase();
    switch (op) {
      case '=': return numeric ? a === e : sa === se;
      case '!=': return numeric ? a !== e : sa !== se;
      case '>': return numeric && a > e;
      case '>=': return numeric && a >= e;
      case '<': return numeric && a < e;
      case '<=': return numeric && a <= e;
      case 'contains': return Array.isArray(actual) ? actual.map((x) => String(x).toLowerCase()).includes(se) : sa.includes(se);
      case 'in': return String(expected).split(',').map((x) => x.trim().toLowerCase()).includes(sa);
    }
    return false;
  }

  function buildIndex(survey) {
    const map = {};
    for (const s of survey.sections) for (const q of s.questions) map[q.questionId] = q;
    return map;
  }

  /** Spec: visibilityLogic works only if enabled:true. A hidden target counts as "unanswered". */
  function isVisible(q, answers, qmap, depth = 0) {
    const v = q.visibilityLogic;
    if (!v || !v.enabled) return true;
    if (depth > 20) throw new SchemaError('Circular visibilityLogic');
    const target = qmap[v.targetQuestion];
    if (!target) throw new SchemaError(`visibilityLogic target not found: ${v.targetQuestion}`);
    const targetAnswer = isVisible(target, answers, qmap, depth + 1) ? answers[v.targetQuestion] : undefined;
    return compare(v.condition, targetAnswer, v.value);
  }

  /** Does an HFC rule fire for the given answers? match: all=AND, any=OR. */
  function checkFires(check, answers) {
    if (!Array.isArray(check.logic) || check.logic.length === 0) return false;
    const results = check.logic.map((c) => {
      if (c.attr === undefined) throw new SchemaError(`HFC ${check.id}: condition has no "attr" (found keys: ${Object.keys(c)})`);
      return compare(c.op, answers[c.attr], c.val);
    });
    return check.match === 'any' ? results.some(Boolean) : results.every(Boolean);
  }

  /** Stateful re-ask handling (one instance per interview). */
  class HfcSession {
    constructor(maxAttempts = MAX_ATTEMPTS) { this.max = maxAttempts; this.attempts = {}; this.flags = []; }
    _flag(check, qid) {
      if (!this.flags.some((f) => f.checkId === check.id && f.questionId === qid))
        this.flags.push({ checkId: check.id, questionId: qid, severity: check.severity, showSup: !!check.show_sup });
    }
    /** @returns {{status:'pass'|'reask'|'accepted_flagged'|'blocked'|'flagged_silently', message?:string, escape?:boolean}} */
    evaluate(check, qid, answers) {
      if (!checkFires(check, answers)) { this.attempts[check.id] = 0; return { status: 'pass' }; }
      const n = (this.attempts[check.id] = (this.attempts[check.id] || 0) + 1);
      switch (check.action) {
        case 'flag_silently': this._flag(check, qid); return { status: 'flagged_silently' };
        case 'reask_once':
          if (n === 1) return { status: 'reask', message: check.msg };
          this._flag(check, qid); return { status: 'accepted_flagged' };
        case 'reask_and_flag':
          this._flag(check, qid);
          if (n < this.max) return { status: 'reask', message: check.msg };
          return { status: 'accepted_flagged' }; // loop guard
        case 'block':
          if (n < this.max) return { status: 'blocked', message: check.msg };
          return { status: 'blocked', message: check.msg, escape: true }; // supervisor override offered
        default: throw new SchemaError(`Unknown HFC action: ${check.action}`);
      }
    }
  }

  function validate(q, value) {
    const r = q.validationRules;
    if (!r || Array.isArray(r) || r.type !== 'range' || isEmpty(value)) return null;
    const n = toNum(value);
    if (Number.isNaN(n)) return 'Enter a number';
    if (n < Number(r.min) || n > Number(r.max)) return `Enter a value between ${r.min} and ${r.max}`;
    return null;
  }

  return { compare, isVisible, checkFires, HfcSession, validate, buildIndex, SchemaError, MAX_ATTEMPTS };
});
