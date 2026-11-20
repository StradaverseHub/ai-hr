import assert from 'node:assert/strict';

export async function seedMissingRecordFixtures(owner, fixture) {
  const [group, company] = fixture.users;
  assert.equal(group.role, 'groupHR');
  assert.equal(company.role, 'companyHR');
  assert.equal(company.tenantId, group.tenantId);
  assert.equal(company.companyId, group.companyId);
  await owner.begin(async tx => {
    await tx`select set_config('app.tenant_id', ${group.tenantId}, true)`;
    const enabled = await tx`
      insert into tenant_module (tenant_id, module_code, status)
      values (${group.tenantId}::uuid, 'multi_cycle_payroll', 'active')
      returning module_code
    `;
    assert.equal(enabled.length, 1, 'Expected the fictional tenant-wide Payroll feature');
    const records = await tx`
      insert into it_requisition
        (tenant_id, company_id, number, kind, status, approval_status, approval_levels, full_name, employee_no)
      values (${group.tenantId}::uuid, ${company.companyId}::uuid, 'REQ-PERF-PENDING', 'standalone',
        'open', 'pending', 1, 'Fictional pending requisition', 'PERF-REQ-01')
      returning number
    `;
    assert.equal(records.length, 1, 'Expected the fictional requisition in the Company HR scope');
  });
}

async function fixtureRoutes(db, fixture) {
  const [group, company] = fixture.users;
  const unit = fixture.tenants[0].companies[0];
  assert.equal(unit.companyId, group.companyId);
  const [batch] = await db`
    select status from payroll_batch where tenant_id = ${group.tenantId}::uuid
      and company_id = ${group.companyId}::uuid and id = ${unit.batchId}::uuid
  `;
  assert.equal(batch?.status, 'draft', 'Expected an actual draft run for the refusal screens');
  const payroll = '/payroll/' + unit.batchId;
  return [
    { actor: company, template: '/lifecycle/requisitions/[number]', path: '/lifecycle/requisitions/REQ-PERF-PENDING', exactHeading: 'REQ-PERF-PENDING · Fictional pending requisition', content: 'PERF-REQ-01' },
    { actor: group, template: '/payroll/[batchId]/remove', path: payroll + '/remove', exactHeading: 'Remove Employee Payroll', refusal: 'Removing an employee payroll is switched off for this environment.' },
    { actor: group, template: '/payroll/[batchId]/reprocess', path: payroll + '/reprocess', exactHeading: 'Reprocess selected employees', refusal: 'Only a processed payroll run can be reprocessed.' },
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
          assert.equal(page.url(), origin + entry.path, 'The browser did not reach the expected record');
          row.step = 'heading';
          const main = page.locator('main:visible').first();
          const headline = main.getByRole('heading', { name: entry.exactHeading, exact: true, level: 1 });
          await headline.waitFor({ state: 'visible', timeout: remaining() });
          row.headingMs = Math.round(performance.now() - started);
          assert(!/^404\b/.test(await headline.innerText({ timeout: remaining() })), 'The expected record page was not found');
          row.step = 'usable-content';
          if (entry.content) await main.getByText(entry.content, { exact: false }).first().waitFor({ state: 'visible', timeout: remaining() });
          if (entry.refusal) await main.getByText(entry.refusal, { exact: false }).waitFor({ state: 'visible', timeout: remaining() });
          assert.equal(await main.locator('[data-read-unavailable]:visible,[data-personnel-busy]:visible').count(), 0);
          row.outcome = entry.refusal ? 'verified-refusal' : 'usable-content';
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
  assert(rows.every(row => ['usable-content', 'verified-refusal'].includes(row.outcome)),
    'One or more targeted record screens did not reach their expected content');
}
