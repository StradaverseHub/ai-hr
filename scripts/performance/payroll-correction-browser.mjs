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
  async function observeCommand(path, button, destination, feedback) {
    const started = performance.now();
    let dispatchedAt;
    const matches = request => {
      const url = new URL(request.url());
      return request.method() === 'POST' && url.origin === origin && url.pathname === path;
    };
    const observe = request => {
      if (matches(request)) dispatchedAt ??= performance.now();
    };
    page.on('request', observe);
    try {
      const headers = page.waitForResponse(response => matches(response.request()), {timeout: 15000})
        .then(response => {
          const receivedAt = performance.now();
          assert(Number.isFinite(dispatchedAt), 'Did not observe the Payroll command request');
          return {
            httpStatus: response.status(),
            dispatchMs: Math.round(dispatchedAt - started),
            requestToHeadersMs: Math.round(receivedAt - dispatchedAt),
            clickToHeadersMs: Math.round(receivedAt - started),
          };
        });
      const [command] = await Promise.all([
        headers,
        page.waitForURL(url => url.origin === origin && url.pathname === path && destination(url), {timeout: 15000}),
        button.click({timeout: 8000}),
      ]);
      await feedback.waitFor({state: 'visible', timeout: 8000});
      assert(command.httpStatus >= 200 && command.httpStatus < 400, 'Payroll command failed');
      return {...command, visibleAcknowledgementMs: elapsed(started)};
    } finally {
      page.off('request', observe);
    }
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
    proof.removeCommand = await observeCommand(removePath, confirm,
      url => url.searchParams.get('removed') === '1', page.getByText(/1 employee payroll removed\./));
    proof.removeCommitMs = proof.removeCommand.visibleAcknowledgementMs;
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
    const progress = page.getByRole('heading', {name: 'Reprocessing in the background', exact: true});
    proof.reprocessCommand = await observeCommand(reprocessPath,
      addition.form.getByRole('button', {name: 'Reprocess 1 employee(s)', exact: true}),
      url => Boolean(url.searchParams.get('job')) && !url.searchParams.has('error'), progress);
    const jobId = new URL(page.url()).searchParams.get('job');
    assert.match(jobId ?? '', /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/);
    proof.reprocessAcknowledgedMs = proof.reprocessCommand.visibleAcknowledgementMs;
    save();
    proof.step = 'worker';
    started = performance.now();
    await runWorker();
    proof.workerMs = elapsed(started);
    proof.step = 'verify-persistence';
    const completed = await readRun();
    const restored = forSubject(completed);
    assert(restored && restored.gross_pay === initialSlip.gross_pay && restored.net_pay === initialSlip.net_pay &&
      sameSlips(otherSlips(completed), remaining), 'Reprocessing did not restore only the selected payroll result');
    const [job] = await db`select status, result from payroll_reprocess_job
      where tenant_id = ${group.tenantId}::uuid and batch_id = ${group.batchId}::uuid and id = ${jobId}::uuid`;
    const jobOutcomes = job?.result?.outcomes ?? [];
    const [outcome] = jobOutcomes;
    assert(job?.status === 'completed' && jobOutcomes.length === 1 &&
      outcome.employmentId === subject.employmentId && outcome.status === 'reprocessed' &&
      outcome.classification === 'added' && outcome.payslipId === restored.id &&
      outcome.versionAfter === restored.version, 'The job did not record the selected employee and restored payslip');
    proof.persistenceVerified = true;
    proof.step = 'browser-result';
    const outcomes = page.getByRole('table').filter({
      has: page.getByRole('columnheader', {name: 'Processing status', exact: true}),
    });
    const employeeResult = outcomes.getByRole('row').filter({
      has: page.getByText('Reprocessed', {exact: true}),
    });
    await employeeResult.getByRole('link').filter({
      has: page.getByText(subject.name, {exact: true}),
    }).waitFor({state: 'visible', timeout: 15000});
    await progress.waitFor({state: 'hidden', timeout: 15000});
    proof.workerAndResultMs = elapsed(started);
    proof.status = 'observed';
  } finally { save(); }
}
