#!/usr/bin/env node
/* Static lint for the survey schema. Usage: node engine/schema-lint.js <schema.json>
 * Catches the defects found in the supplied sample schema (see BUGS.md). Exit 1 on any ERROR. */
const fs = require('node:fs');
const { compare } = require('./engine');
const file = process.argv[2] || 'schema/sample-survey-schema.fixed.json';
const findings = [];
const add = (level, where, msg) => findings.push({ level, where, msg });

let doc;
try { doc = JSON.parse(fs.readFileSync(file, 'utf8')); }
catch (e) { console.error(`ERROR invalid JSON: ${e.message}`); process.exit(1); }

const HFC_OPS = ['=', '!=', '>', '>=', '<', '<=', 'contains', 'in', 'empty', 'not_empty'];
const ACTIONS = ['flag_silently', 'reask_once', 'reask_and_flag', 'block'];
const CONDS = ['equals', 'not_equals', 'contains', 'greater_than', 'less_than', 'is_empty', 'is_not_empty'];

(doc.surveys || []).forEach((s, si) => {
  const sd = s.surveyData; const at = (q) => `survey[${si}]/${q}`;
  const qs = sd.sections.flatMap((x) => x.questions);
  const ids = qs.map((q) => q.questionId);
  const seen = new Set();
  ids.forEach((id) => { if (seen.has(id)) add('ERROR', `survey[${si}]`, `duplicate questionId ${id}`); seen.add(id); });
  if (!s.surveyId && !sd.id) add('WARN', `survey[${si}]`, 'no surveyId/version - sync cannot detect schema drift');
  const shapes = new Set(qs.map((q) => Array.isArray(q.validationRules) ? 'array' : typeof q.validationRules));
  if (shapes.size > 1) add('WARN', `survey[${si}]`, `validationRules has mixed shapes: ${[...shapes]} (builder spec says list of {type,value,message})`);
  qs.forEach((q, i) => {
    const v = q.visibilityLogic;
    if (v && v.enabled) {
      const ti = ids.indexOf(v.targetQuestion);
      if (ti < 0) add('ERROR', at(q.questionId), `visibility target ${v.targetQuestion} not found`);
      else if (ti >= i) add('ERROR', at(q.questionId), `visibility target ${v.targetQuestion} appears after the question`);
      if (!CONDS.includes(v.condition)) add('ERROR', at(q.questionId), `unknown condition ${v.condition}`);
      const t = qs[ti];
      if (t && t.options && t.options.length && v.value !== undefined && !t.options.includes(v.value))
        add('ERROR', at(q.questionId), `visibility value "${v.value}" is not an option of ${t.questionId}`);
    }
    (q.formChecks || []).forEach((c) => {
      if (!ACTIONS.includes(c.action)) add('ERROR', at(q.questionId), `${c.id}: unknown action ${c.action}`);
      (c.logic || []).forEach((l) => {
        if (l.attr === undefined) add('ERROR', at(q.questionId), `${c.id}: condition uses ${Object.keys(l).join(',')} instead of "attr"`);
        if (!HFC_OPS.includes(l.op)) add('ERROR', at(q.questionId), `${c.id}: bad op "${l.op}"`);
        if (l.attr && !ids.includes(l.attr)) add('ERROR', at(q.questionId), `${c.id}: attr ${l.attr} not found`);
      });
      // unreachable rule: host question hidden whenever an HFC condition on its own visibility target holds
      if (v && v.enabled && v.condition === 'equals') {
        (c.logic || []).filter((l) => l.attr === v.targetQuestion && c.match !== 'any').forEach((l) => {
          if (compare(l.op, v.value, l.val) === false)
            add('ERROR', at(q.questionId), `${c.id} can NEVER fire: needs ${l.attr} ${l.op} "${l.val}" but ${q.questionId} is only visible when ${v.targetQuestion} = "${v.value}"`);
        });
      }
    });
    const r = q.validationRules;
    if (r && r.type === 'range' && (typeof r.min === 'string' || typeof r.max === 'string'))
      add('INFO', at(q.questionId), 'range min/max are strings - engine must coerce (Number("") === 0 trap)');
  });
});
findings.forEach((f) => console.log(`${f.level.padEnd(5)} ${f.where}: ${f.msg}`));
const errors = findings.filter((f) => f.level === 'ERROR').length;
console.log(`\n${errors} error(s), ${findings.length - errors} other finding(s)`);
process.exit(errors ? 1 : 0);
