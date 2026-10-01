/* Tiny schema-driven renderer used as the web "preview" target. ?survey=<index> selects the survey. */
(async function () {
  const E = window.QAEngine;
  const idx = Number(new URLSearchParams(location.search).get('survey') || 0);
  const doc = await (await fetch('schema.json')).json();
  const survey = doc.surveys[idx].surveyData, qmap = E.buildIndex(survey);
  const answers = {}, session = new E.HfcSession(), pending = {};
  document.getElementById('survey-title').textContent = survey.title;
  const form = document.getElementById('form');

  for (const sec of survey.sections) {
    const h = document.createElement('h2'); h.textContent = sec.title; form.appendChild(h);
    for (const q of sec.questions) {
      const wrap = document.createElement('div'); wrap.className = 'q'; wrap.dataset.testid = q.questionId; wrap.setAttribute('data-testid', q.questionId);
      const id = `input-${q.questionId}`;
      wrap.innerHTML = `<label for="${id}">${q.questionText}</label><small>${q.hintText || q.questionHintText || ''}</small>`;
      let input;
      if (q.inputType === 'Dropdown') {
        input = document.createElement('select');
        input.add(new Option('-- select --', ''));
        q.options.forEach((o) => input.add(new Option(o, o)));
      } else { input = document.createElement('input'); input.type = q.inputType === 'Number' ? 'number' : 'text'; }
      input.id = id; input.name = q.questionId;
      const err = Object.assign(document.createElement('div'), { className: 'err' }); err.setAttribute('data-testid', `error-${q.questionId}`);
      const hfc = Object.assign(document.createElement('div'), { className: 'hfc' }); hfc.hidden = true; hfc.setAttribute('data-testid', `hfc-${q.questionId}`);
      wrap.append(input, err, hfc); form.appendChild(wrap);
      input.addEventListener('input', () => onChange(q, input, err, hfc));
      input.addEventListener('change', () => onChange(q, input, err, hfc));
    }
  }

  function refreshVisibility() {
    let changed = true, guard = 0;
    while (changed && guard++ < 20) {                 // fixpoint: hiding a parent can hide children
      changed = false;
      for (const q of Object.values(qmap)) {
        const wrap = form.querySelector(`[data-testid="${q.questionId}"]`);
        const visible = E.isVisible(q, answers, qmap);
        if (wrap.hidden === visible) {
          wrap.hidden = !visible; changed = true;
          if (!visible) { delete answers[q.questionId]; wrap.querySelector('input,select').value = ''; }  // no stale data
        }
      }
    }
  }
  function onChange(q, input, err, hfcBox) {
    if (input.value === '') delete answers[q.questionId]; else answers[q.questionId] = input.type === 'number' ? Number(input.value) : input.value;
    err.textContent = E.validate(q, input.value) || '';
    refreshVisibility();
    hfcBox.hidden = true; hfcBox.textContent = ''; delete pending[q.questionId];
    for (const c of q.formChecks || []) {
      if (err.textContent) continue;
      const r = session.evaluate(c, q.questionId, answers);
      if (r.status === 'reask' || r.status === 'blocked') {
        pending[q.questionId] = r;
        hfcBox.hidden = false; hfcBox.textContent = r.message + ' ';
        const btn = Object.assign(document.createElement('button'), { type: 'button', textContent: 'Confirm value' });
        btn.setAttribute('data-testid', `hfc-confirm-${q.questionId}`);
        btn.onclick = () => onChange(q, input, err, hfcBox); // re-evaluating == the "re-ask" round trip
        hfcBox.appendChild(btn);
      }
    }
  }
  document.getElementById('submit').addEventListener('click', () => {
    const out = document.getElementById('output');
    const problems = [];
    for (const q of Object.values(qmap)) {
      if (!E.isVisible(q, answers, qmap)) continue;
      if (q.isRequired && answers[q.questionId] === undefined) problems.push(`${q.questionId} required`);
      const e = E.validate(q, answers[q.questionId]); if (e) problems.push(`${q.questionId}: ${e}`);
    }
    if (Object.keys(pending).length) problems.push('unresolved HFC: ' + Object.keys(pending).join(','));
    out.textContent = problems.length ? 'BLOCKED: ' + problems.join('; ') : JSON.stringify({ answers, flags: session.flags }, null, 1);
    out.dataset.status = problems.length ? 'blocked' : 'submitted';
  });
  refreshVisibility();
  document.body.dataset.ready = '1';
})();
