import assert from 'node:assert/strict';

async function fixtureRoutes(db, fixture) {
  const [group, company] = fixture.users;
  const employee = fixture.users[4];
  const unit = fixture.tenants[0].companies[0];
  assert.equal(group.role, 'groupHR');
  assert.equal(company.role, 'companyHR');
  assert.equal(employee.role, 'employee');
  assert.equal(group.tenantId, employee.tenantId);
  assert.equal(company.companyId, employee.companyId);
  assert.equal(unit.companyId, employee.companyId);

  const historicalSlips = await db`
    select batch.pay_period as period
    from payslip slip
    join payroll_batch batch on batch.id = slip.batch_id and batch.tenant_id = slip.tenant_id
    where slip.tenant_id = ${employee.tenantId}::uuid and batch.company_id = ${employee.companyId}::uuid
      and slip.employment_id = ${employee.employmentId}::uuid and batch.id = ${unit.historicalBatchId}::uuid
      and batch.status = 'closed'
  `;
  assert.equal(historicalSlips.length, 1, 'The employee must have a released fictional payslip');
  assert.match(historicalSlips[0].period, /^\d{4}-\d{2}$/);

  const year = historicalSlips[0].period.slice(0, 4);
  const employmentId = employee.employmentId;
  const cp22 = '/payroll/cp22/' + employmentId;
  const cp22a = '/payroll/cp22a/' + employmentId;
  return [
    {
      actor: group, template: '/payroll/[batchId]/tax-configuration/[employmentId]',
      path: '/payroll/' + unit.batchId + '/tax-configuration/' + employmentId,
      exactHeading: 'Tax configuration for this payroll run',
      witness: 'form:has(input[name="payrollBatchId"][value="' + unit.batchId + '"]) #income-tax-resident',
    },
    {
      actor: employee, template: '/payroll/reports/ea/[employmentId]',
      path: '/payroll/reports/ea/' + employmentId + '?year=' + year,
      content: employee.name,
      witness: 'a[href="/me/ea/' + employmentId + '/pdf?year=' + year + '"]',
    },
    {
      actor: company, template: '/payroll/cp22/[employmentId]/preview',
      path: cp22 + '/preview', exactHeading: 'Review the CP22 before you produce it',
      content: employee.name, witness: 'a[href^="' + cp22 + '/pdf?"][href*="inline=1"]',
    },
    {
      actor: company, template: '/payroll/cp22a/[employmentId]/preview',
      path: cp22a + '/preview', exactHeading: 'CP22A — notice of an employee leaving',
      content: employee.name, witness: 'a[href^="' + cp22a + '/pdf"]',
    },
    {
      actor: group, template: '/admin/users/[userId]/account',
      path: '/admin/users/' + employee.userId + '/account',
      exactHeading: 'Manage account', content: employee.username, witness: 'dl dd',
    },
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
  assert(rows.every(row => row.outcome === 'usable-content'), 'One or more fictional record screens missed their readiness witness');
}
