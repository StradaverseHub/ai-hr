import assert from 'node:assert/strict';

// Match the statutory report's DB test: record the leaving date after the fictional
// payslips exist so the preview has real retained payroll to read.
export async function seedStatutoryLeaver(owner, fixture) {
  const company = fixture.users[1];
  const leaver = fixture.users[5];
  assert.equal(company.role, 'companyHR');
  assert.equal(leaver.role, 'employee');
  assert.equal(leaver.tenantId, company.tenantId);
  assert.equal(leaver.companyId, company.companyId);
  assert.match(fixture.today, /^\d{4}-\d{2}-\d{2}$/);
  await owner.begin(async tx => {
    await tx`select set_config('app.tenant_id', ${company.tenantId}, true)`;
    const affected = await tx`
      update employment set terminated_on = ${fixture.today}::date, termination_type = 'voluntary'
      where tenant_id = ${company.tenantId}::uuid and company_id = ${company.companyId}::uuid
        and id = ${leaver.employmentId}::uuid and terminated_on is null
      returning id
    `;
    assert.equal(affected.length, 1, 'Expected one scoped fictional leaver');
  });
}

async function fixtureRoutes(db, fixture) {
  const company = fixture.users[1];
  const leaver = fixture.users[5];
  const unit = fixture.tenants[0].companies[0];
  assert.equal(unit.companyId, leaver.companyId);

  const records = await db`
    select employment.terminated_on::text as leaving_date, payroll_batch.pay_period
    from employment join payslip on payslip.tenant_id = employment.tenant_id and payslip.employment_id = employment.id
    join payroll_batch on payroll_batch.tenant_id = payslip.tenant_id and payroll_batch.id = payslip.batch_id
      and payroll_batch.company_id = employment.company_id
    where employment.tenant_id = ${leaver.tenantId}::uuid and employment.id = ${leaver.employmentId}::uuid
      and payslip.batch_id = ${unit.historicalBatchId}::uuid
  `;
  assert.equal(records.length, 1, 'Expected one retained fictional payslip for the scoped leaver');
  const [record] = records;
  assert.equal(record.leaving_date, fixture.today);
  assert.match(record.pay_period, /^\d{4}-\d{2}$/);
  const [run] = await db`
    select pay_period from payroll_batch where tenant_id = ${leaver.tenantId}::uuid
      and company_id = ${leaver.companyId}::uuid and id = ${unit.batchId}::uuid
  `;
  assert.match(run?.pay_period ?? '', /^\d{4}-\d{2}$/, 'Expected the same-company Payroll run');
  const base = '/payroll/cp22a/' + leaver.employmentId;
  const citizenshipSubject = fixture.users[4];
  assert.equal(citizenshipSubject.companyId, unit.companyId);
  const taxConfiguration = '/payroll/' + unit.batchId + '/tax-configuration/' + citizenshipSubject.employmentId;
  const year = record.pay_period.slice(0, 4);
  const ea = '/payroll/reports/ea/' + leaver.employmentId + '?year=' + year + '&company=' + leaver.companyId;
  return [
    {
      actor: company, template: '/payroll/cp22a/[employmentId]/preview',
      path: base + '/preview', exactHeading: 'CP22A — notice of an employee leaving',
      content: leaver.name, witness: 'iframe[src^="' + base + '/pdf"]',
      inlinePdf: base + '/pdf',
    },
    ...[company, leaver].map(actor => ({
      actor, template: '/payroll/reports/ea/[employmentId]', path: ea,
      exactHeading: 'Statement of Remuneration · EA (C.P.8A)', content: leaver.name, exactContent: true,
      witness: `a[href^="/me/ea/${leaver.employmentId}/pdf?year=${year}"]`,
    })),
    {
      actor: company, template: '/payroll/[batchId]/tax-configuration/[employmentId]', path: taxConfiguration,
      exactHeading: 'Tax configuration for this payroll run',
      witness: `form:has(input[name="employmentId"][value="${citizenshipSubject.employmentId}"])` +
        `:has(input[name="payrollBatchId"][value="${unit.batchId}"])` +
        `:has(input[name="expectedCompanyId"][value="${leaver.companyId}"])` +
        `:has(input[name="expectedPayPeriod"][value="${run.pay_period}"])`,
    },
  ];
}

export async function measureFixtureRecordCensus({ db, fixture, origin, compiledPages, signedInContext, report, save }) {
  const cases = await fixtureRoutes(db, fixture);
  assert(cases.every(row => compiledPages.has(row.template)), 'A planned record route is absent from the measured build');
  report.fixtureRecordCensus = { plannedTemplates: new Set(cases.map(row => row.template)).size, plannedJourneys: cases.length, observations: [] };
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
        const pdfResponse = entry.inlinePdf && page.waitForResponse(response => {
          const url = new URL(response.url());
          return url.origin === origin && url.pathname === entry.inlinePdf && url.searchParams.get('inline') === '1';
        }, { timeout: remaining() }).catch(() => null);
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
          if (entry.content) await main.getByText(entry.content, { exact: entry.exactContent ?? false }).first().waitFor({ state: 'visible', timeout: remaining() });
          if (entry.witness) await main.locator(entry.witness).first().waitFor({ state: 'visible', timeout: remaining() });
          assert.equal(await main.locator('[data-read-unavailable]:visible,[data-personnel-busy]:visible').count(), 0);
          if (pdfResponse) {
            row.step = 'inline-pdf';
            const pdf = await pdfResponse;
            assert(pdf?.ok() && pdf.headers()['content-type']?.startsWith('application/pdf'),
              'The preview did not receive the expected PDF');
          }
          row.outcome = 'usable-content';
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
