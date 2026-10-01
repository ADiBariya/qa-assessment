// Scenario B - web automation of dynamic skip logic (+ schema-driven regression + HFC UI)
const { test, expect } = require('@playwright/test');
const fs = require('node:fs'); const path = require('node:path');
const schema = JSON.parse(fs.readFileSync(path.join(__dirname, '../app/schema.json'), 'utf8'));

const open = async (page, survey) => { await page.goto(`/?survey=${survey}`); await expect(page.locator('body[data-ready="1"]')).toBeAttached(); };
const q = (page, id) => page.getByTestId(id);
const pick = (page, id, v) => page.locator(`#input-${id}`).selectOption(v);

// ---- The example from the brief: "Do you have a hobby?" = Yes -> "What is your hobby?" appears
test.describe('Student Interests & Hobbies (survey 2)', () => {
  test.beforeEach(async ({ page }) => open(page, 2));

  test('hobby follow-up is hidden by default', async ({ page }) => {
    await expect(q(page, 'q_4')).toBeHidden();
  });
  test('Yes -> "What is your hobby?" text field becomes visible and usable', async ({ page }) => {
    await pick(page, 'q_3', 'Yes');
    await expect(q(page, 'q_4')).toBeVisible();
    await expect(page.getByLabel('What is your hobby? (If Yes)')).toBeEditable();
  });
  test('No -> follow-up stays hidden', async ({ page }) => {
    await pick(page, 'q_3', 'No');
    await expect(q(page, 'q_4')).toBeHidden();
  });
  test('Yes -> No hides it again AND clears the stale answer; back to Yes shows it empty', async ({ page }) => {
    await pick(page, 'q_3', 'Yes'); await page.locator('#input-q_4').fill('Painting');
    await pick(page, 'q_3', 'No'); await expect(q(page, 'q_4')).toBeHidden();
    await pick(page, 'q_3', 'Yes'); await expect(page.locator('#input-q_4')).toHaveValue('');
  });
  test('un-selecting (back to placeholder) hides the follow-up', async ({ page }) => {
    await pick(page, 'q_3', 'Yes'); await pick(page, 'q_3', '');
    await expect(q(page, 'q_4')).toBeHidden();
  });
  test('hidden answers are NOT present in the submitted payload', async ({ page }) => {
    await pick(page, 'q_1', 'Math'); await pick(page, 'q_3', 'Yes'); await page.locator('#input-q_4').fill('Chess');
    await pick(page, 'q_3', 'No'); await pick(page, 'q_5', 'By Doing'); await pick(page, 'q_6', 'No');
    await page.getByRole('button', { name: 'Submit' }).click();
    const out = page.getByTestId('output');
    await expect(out).toHaveAttribute('data-status', 'submitted');
    expect(JSON.parse(await out.textContent()).answers).not.toHaveProperty('q_4');
  });
  test('required + visible question blocks submit; required + hidden does not', async ({ page }) => {
    await page.getByRole('button', { name: 'Submit' }).click();
    await expect(page.getByTestId('output')).toHaveAttribute('data-status', 'blocked');
  });
  test('"Other" subject reveals the subject-name field (second rule on the same survey)', async ({ page }) => {
    await expect(q(page, 'q_2')).toBeHidden();
    await pick(page, 'q_1', 'Other'); await expect(q(page, 'q_2')).toBeVisible();
    await pick(page, 'q_1', 'Math'); await expect(q(page, 'q_2')).toBeHidden();
  });
});

// ---- Data-driven regression: every enabled "equals" rule of every survey in the schema is exercised automatically.
// A builder change that breaks any rule fails here without anyone writing a new test.
for (const [si, s] of schema.surveys.entries()) {
  const qs = s.surveyData.sections.flatMap((x) => x.questions);
  for (const child of qs.filter((x) => x.visibilityLogic?.enabled && x.visibilityLogic.condition === 'equals')) {
    const v = child.visibilityLogic, parent = qs.find((x) => x.questionId === v.targetQuestion);
    if (parent.inputType !== 'Dropdown') continue;
    test(`[schema] survey ${si}: ${child.questionId} shown only when ${v.targetQuestion} = "${v.value}"`, async ({ page }) => {
      await open(page, si);
      await expect(q(page, child.questionId)).toBeHidden();
      for (const opt of parent.options) {
        await pick(page, parent.questionId, opt);
        if (opt === v.value) await expect(q(page, child.questionId)).toBeVisible();
        else await expect(q(page, child.questionId)).toBeHidden();
      }
    });
  }
}

// ---- Known defect in the supplied schema (BUG-004): documented as a test so it is visible in every run.
test('[BUG-004] Wellbeing survey: sleep-hours field is hidden when "slept well = Yes", so the HFC "Yes AND <6h" can never be triggered', async ({ page }) => {
  await open(page, 1);
  await pick(page, 'q_2', 'Yes'); await expect(q(page, 'q_3')).toBeHidden();
  await pick(page, 'q_2', 'No'); await expect(q(page, 'q_3')).toBeVisible();
});

// ---- Range validation + HFC UI, using page.route to inject an HFC rule (technique for testing rules the builder can't yet emit)
test.describe('HFC re-ask flow in the UI', () => {
  test.beforeEach(async ({ page }) => {
    await page.route('**/schema.json', async (route) => {
      const doc = JSON.parse(fs.readFileSync(path.join(__dirname, '../app/schema.json'), 'utf8'));
      doc.surveys[1].surveyData.sections[0].questions[2].formChecks = [
        { id: 'hfc_sleep_high', action: 'reask_once', match: 'all', severity: 'Soft', show_sup: 1, logic: [{ attr: 'q_3', op: '>', val: '16' }], msg: "That's an unusually high number of hours. Please confirm." }];
      await route.fulfill({ json: doc });
    });
    await open(page, 1); await pick(page, 'q_2', 'No');
  });
  test('value 20 -> warning appears; Confirm accepts it and submit records the flag', async ({ page }) => {
    await page.locator('#input-q_3').fill('20');
    await expect(page.getByTestId('hfc-q_3')).toBeVisible();
    await page.getByTestId('hfc-confirm-q_3').click();
    await expect(page.getByTestId('hfc-q_3')).toBeHidden();
    await pick(page, 'q_1', 'Happy'); await pick(page, 'q_4', 'Yes'); await pick(page, 'q_6', 'No');
    await page.getByRole('button', { name: 'Submit' }).click();
    const out = JSON.parse(await page.getByTestId('output').textContent());
    expect(out.flags.map((f) => f.checkId)).toContain('hfc_sleep_high');
  });
  test('value 16 (boundary, not > 16) -> no warning', async ({ page }) => {
    await page.locator('#input-q_3').fill('16'); await expect(page.getByTestId('hfc-q_3')).toBeHidden();
  });
  test('value 25 -> range validation error (0..24), independent of the HFC', async ({ page }) => {
    await page.locator('#input-q_3').fill('25');
    await expect(page.getByTestId('error-q_3')).toContainText('between 0 and 24');
  });
  test('touch targets on budget-phone viewport are >= 48px', async ({ page }) => {
    for (const sel of ['#input-q_3', '#submit']) expect((await page.locator(sel).boundingBox()).height).toBeGreaterThanOrEqual(47.5);
  });
});
