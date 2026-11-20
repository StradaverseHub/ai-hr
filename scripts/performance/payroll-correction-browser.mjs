import assert from 'node:assert/strict';

export async function measurePayrollCorrection({context, db, fixture, origin, runWorker, report, save}) {
  const [group] = fixture.users;
  const subject = fixture.users[4];
  const processPath = '/payroll/' + group.batchId;
  const removePath = processPath + '/remove';
  const reprocessPath = processPath + '/reprocess';
  const reason = 'Fictional browser correction';
  const proof = report.payrollCorrection = {status: 'incomplete', step: 'initial-run', role: group.role};
  const page = await context.newPage();
  const elapsed = start => Math.round(performance.now() - start);
  const readRun = async () => {
    const [run] = await db`select status, employee_count from payroll_batch
      where tenant_id = ${group.tenantId}::uuid and id = ${group.batchId}::uuid`;
    const rows = await db`select id, employment_id, gross_pay::text, net_pay::text, version from payslip
      where tenant_id = ${group.tenantId}::uuid and batch_id = ${group.batchId}::uuid order by employment_id`;
    assert(run?.status === 'processed' && run.employee_count === rows.length, 'Expected a processed run with matching headcount');
    return rows;
  };
  const sameSlips = (left, right) => JSON.stringify(left) === JSON.stringify(right);
  const forSubject = rows => rows.find(row => row.employment_id === subject.employmentId);
  const otherSlips = rows => rows.filter(row => row.employment_id !== subject.employmentId);
  async function openForm(path) {
    const start = performance.now();
    const term = new URLSearchParams({q: subject.name});
    const response = await page.goto(origin + path + '?' + term, {waitUntil: 'domcontentloaded', timeout: 15000});
    assert.equal(response?.status(), 200);
    assert(new URL(page.url()).pathname === path, 'Payroll form route did not remain in scope');
    const form = page.locator('main form:has(textarea[name="reason"])');
    const subjectRow = form.getByRole('row').filter({has: page.getByText(subject.name, {exact: true})});
    await subjectRow.getByRole('checkbox').waitFor({state: 'visible', timeout: 15000});
    return {form, subjectRow, readyMs: elapsed(start)};
  }
  async function selectOne(form, subjectRow) {
    await subjectRow.getByRole('checkbox').check({timeout: 8000});
    const values = await form.locator('input[type="hidden"][name="employmentIds"]').evaluateAll(inputs => inputs.map(input => input.value));
    assert(values.length === 1 && values[0] === subject.employmentId, 'Payroll form has a different employee selection');
    await form.locator('textarea[name="reason"]').fill(reason);
  }
  try {
    const initial = await readRun();
    const initialSlip = forSubject(initial);
    assert(initial.length > 1 && initialSlip, 'Expected the subject and unrelated payslips on the run');
    proof.step = 'remove-form';
    const removal = await openForm(removePath);
    proof.removeFormMs = removal.readyMs;
    await selectOne(removal.form, removal.subjectRow);
    proof.step = 'remove-confirmation';
    let started = performance.now();
    await removal.form.getByRole('button', {name: 'Remove 1 employee payroll', exact: true}).click({timeout: 8000});
    const confirm = page.getByRole('button', {name: 'Remove payroll', exact: true});
    await confirm.waitFor({state: 'visible', timeout: 8000});
    proof.removeConfirmationMs = elapsed(started);
    proof.step = 'remove-commit';
    started = performance.now();
    await Promise.all([
      page.waitForURL(url => url.origin === origin && url.pathname === removePath &&
        url.searchParams.get('removed') === '1', {timeout: 15000}),
      confirm.click({timeout: 8000}),
    ]);
    await page.getByText(/1 employee payroll removed\./).waitFor({state: 'visible', timeout: 8000});
    proof.removeCommitMs = elapsed(started);
    const remaining = await readRun();
    assert(!forSubject(remaining) && sameSlips(remaining, otherSlips(initial)), 'Removal touched the wrong payslips');
    const removals = await db`select 1 from payroll_employee_result_history
      where tenant_id = ${group.tenantId}::uuid and batch_id = ${group.batchId}::uuid
        and employment_id = ${subject.employmentId}::uuid and action = 'remove'
        and reason = ${reason} and before is not null and after is null`;
    assert.equal(removals.length, 1, 'Expected one complete removal history row');
    proof.step = 'reprocess-form';
    const addition = await openForm(reprocessPath);
    proof.reprocessFormMs = addition.readyMs;
    await addition.subjectRow.getByText('New / Pending', {exact: true}).waitFor({state: 'visible', timeout: 8000});
    await selectOne(addition.form, addition.subjectRow);
    proof.step = 'reprocess-acknowledgement';
    started = performance.now();
    await Promise.all([
      page.waitForURL(url => url.origin === origin && url.pathname === reprocessPath &&
        Boolean(url.searchParams.get('job')) && !url.searchParams.has('error'), {timeout: 15000}),
      addition.form.getByRole('button', {name: 'Reprocess 1 employee(s)', exact: true}).click({timeout: 8000}),
    ]);
    proof.reprocessAcknowledgedMs = elapsed(started);
    save();
    proof.step = 'worker-and-result';
    started = performance.now();
    await runWorker();
    await page.reload({waitUntil: 'domcontentloaded', timeout: 15000});
    await page.getByText('Added to this run', {exact: true}).first().waitFor({state: 'visible', timeout: 8000});
    proof.workerAndResultMs = elapsed(started);
    const completed = await readRun();
    const restored = forSubject(completed);
    assert(restored && restored.gross_pay === initialSlip.gross_pay && restored.net_pay === initialSlip.net_pay &&
      sameSlips(otherSlips(completed), remaining), 'Reprocessing did not restore only the selected payroll result');
    proof.status = 'observed';
  } finally { save(); }
}
