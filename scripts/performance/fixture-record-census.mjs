import assert from 'node:assert/strict';

async function fixtureRoutes(db, fixture) {
  const [group, company] = fixture.users;
  const employee = fixture.users[4];
  assert.equal(group.role, 'groupHR');
  assert.equal(company.role, 'companyHR');
  assert.equal(employee.role, 'employee');
  assert.equal(company.companyId, group.companyId);
  assert.equal(employee.companyId, group.companyId);
  const unit = fixture.tenants[0].companies[0];
  assert.equal(unit.companyId, group.companyId);

  const lineages = await db`
    select lineage_id as id, name from attendance_workflow_template
    where tenant_id = ${group.tenantId}::uuid and company_id = ${group.companyId}::uuid
      and code = 'PERF' and superseded_at is null
  `;
  const slips = await db`
    select id from payslip where tenant_id = ${employee.tenantId}::uuid
      and employment_id = ${employee.employmentId}::uuid and batch_id = ${unit.historicalBatchId}::uuid
  `;
  assert.equal(lineages.length, 1, 'Expected the active fictional Attendance workflow');
  assert.equal(slips.length, 1, 'Expected the previously released fictional payslip');

  const workflow = '/admin/attendance/approval-workflow/' + lineages[0].id;
  const workflowTemplate = '/admin/attendance/approval-workflow/[lineageId]';
  const profile = '/personnel/' + employee.employmentId;
  const payroll = '/payroll/' + unit.batchId;
  const taxYear = Number(fixture.today.slice(0, 4)) - 1;
  const taxSubject = '?employmentId=' + employee.employmentId;
  const tp1 = '/payroll/transactions/tp1/' + taxYear;
  const payslip = '/me/payslip/' + slips[0].id;

  return [
    { actor: group, template: workflowTemplate, path: workflow, exactHeading: lineages[0].name, witness: `a[href="${workflow}/edit"]` },
    { actor: group, template: workflowTemplate + '/edit', path: workflow + '/edit', exactHeading: 'Edit ' + lineages[0].name, witness: 'form' },
    { actor: group, template: workflowTemplate + '/previews', path: workflow + '/previews', exactHeading: 'Preview History', witness: `a[href="${workflow}"]` },
    { actor: group, template: '/admin/personnel/[employmentId]/movement/[mode]', path: '/admin' + profile + '/movement/new', content: employee.name, witness: 'form' },
    { actor: group, template: '/people/[employmentId]', path: '/people/' + employee.employmentId, redirectTo: profile, content: employee.name },
    { actor: company, template: '/lifecycle/requisitions/[number]', path: '/lifecycle/requisitions/REQ-PERF-PENDING', exactHeading: 'REQ-PERF-PENDING · Fictional pending requisition' },
    { actor: group, template: '/payroll/[batchId]/close', path: payroll + '/close', exactHeading: 'Close batch' },
    { actor: group, template: '/payroll/[batchId]/reset', path: payroll + '/reset', exactHeading: 'Reset Payroll Process' },
    { actor: group, template: '/payroll/[batchId]/remove', path: payroll + '/remove', exactHeading: 'Remove Employee Payroll' },
    { actor: group, template: '/payroll/[batchId]/reprocess', path: payroll + '/reprocess', exactHeading: 'Reprocess selected employees' },
    { actor: group, template: '/payroll/transactions/tp1/[year]', path: tp1 + taxSubject, redirectTo: tp1 + '/1' + taxSubject, content: employee.name },
    { actor: group, template: '/payroll/transactions/tp1/[year]/[month]', path: tp1 + '/1' + taxSubject, content: employee.name },
    { actor: employee, template: '/me/payslip/[payslipId]', path: payslip, content: employee.name, witness: `a[href="${payslip}/pdf"][download]` },
  ];
}

export async function measureFixtureRecordCensus({ db, fixture, origin, compiledPages, signedInContext, report, save }) {
  const cases = await fixtureRoutes(db, fixture);
  assert(cases.every(row => compiledPages.has(row.template)), 'A planned record route is absent from the measured build');
  report.fixtureRecordCensus = { plannedTemplates: cases.length, observations: [] };
  const rows = report.fixtureRecordCensus.observations;
  save();
  for (const entry of cases) {
    const context = await signedInContext(entry.actor);
    try {
      const page = await context.newPage();
      for (const pass of ['first', 'repeat']) {
        const row = { template: entry.template, role: entry.actor.role, pass, outcome: 'browser-failure', step: 'response' };
        rows.push(row);
        const started = performance.now();
        const remaining = () => Math.max(1, Math.floor(15000 - (performance.now() - started)));
        try {
          const response = await page.goto(origin + entry.path, { waitUntil: 'commit', timeout: remaining() });
          row.httpStatus = response?.status() ?? null;
          row.responseMs = Math.round(performance.now() - started);
          assert.equal(row.httpStatus, 200);
          row.step = 'document';
          const finalUrl = origin + (entry.redirectTo ?? entry.path);
          if (entry.redirectTo) await page.waitForURL(finalUrl, { timeout: remaining() });
          assert.equal(page.url(), finalUrl, 'The browser did not reach the expected record');
          row.step = 'heading';
          const main = page.locator('main:visible').first();
          const headline = entry.exactHeading
            ? main.getByRole('heading', { name: entry.exactHeading, exact: true, level: 1 })
            : main.locator('h1:visible').first();
          await headline.waitFor({ state: 'visible', timeout: remaining() });
          row.headingMs = Math.round(performance.now() - started);
          assert(!/^404\b/.test(await headline.innerText({ timeout: remaining() })), 'The expected record page was not found');
          row.step = 'usable-content';
          if (entry.content) await main.getByText(entry.content, { exact: false }).first().waitFor({ state: 'visible', timeout: remaining() });
          if (entry.witness) await main.locator(entry.witness).first().waitFor({ state: 'visible', timeout: remaining() });
          assert.equal(await main.locator('[data-read-unavailable]:visible,[data-personnel-busy]:visible').count(), 0);
          row.outcome = entry.redirectTo ? 'verified-redirect' : 'usable-content';
        } catch (error) {
          row.outcome = error.name === 'TimeoutError' ? 'timeout' : error.code === 'ERR_ASSERTION' ? 'assertion' : 'browser-failure';
        } finally {
          row.elapsedMs = Math.round(performance.now() - started);
          save();
        }
      }
    } finally {
      await context.close();
    }
  }
  assert.equal(rows.length, cases.length * 2);
}
