import assert from 'node:assert/strict';

const workSiteName = 'Fictional Census Work Site';
const clockingPointName = 'Fictional Census Clocking Point';

export async function seedWorkLocationRecords(owner, fixture) {
  const [group, company] = fixture.users;
  assert.equal(group.role, 'groupHR');
  assert.equal(company.role, 'companyHR');
  assert.equal(group.tenantId, company.tenantId);
  assert.equal(fixture.tenants[0].companies[0].companyId, company.companyId);
  return owner.begin(async tx => {
    await tx`select set_config('app.tenant_id', ${company.tenantId}, true)`;
    const [site] = await tx`
      insert into location (tenant_id, company_id, code, name)
      values (${company.tenantId}, ${company.companyId}, 'PERF-CENSUS-SITE', ${workSiteName})
      returning id
    `;
    const [point] = await tx`
      insert into clocking_location (tenant_id, location_id, name, lat, lng, radius_m)
      values (${company.tenantId}, ${site.id}, ${clockingPointName}, 3.14, 101.69, 125)
      returning id
    `;
    await tx`
      insert into clocking_location_company (tenant_id, clocking_location_id, company_id)
      values (${company.tenantId}, ${point.id}, ${company.companyId})
    `;
    const { count: sites } = (await tx`
      with seeded as (
        insert into location (tenant_id, company_id, code, name)
        select c.tenant_id, c.id,
          'PERF-CENSUS-DECOY-' || row_number() over (order by c.id, n),
          'Fictional comparison site ' || n
        from company c cross join generate_series(1, 10) n
        where c.tenant_id = ${company.tenantId} and c.archived_at is null
        returning id
      )
      select count(*)::int as count from seeded
    `)[0];
    assert(sites >= 700 && sites % 10 === 0, 'Expected ten additional work sites per active company');
    return { additionalSites: sites };
  });
}

async function workLocationRoutes(db, fixture) {
  const [group, company] = fixture.users;
  const records = await db`
    select site.id as site_id, point.id as point_id
    from location site
    join clocking_location point on point.tenant_id = site.tenant_id and point.location_id = site.id
    join clocking_location_company scope on scope.tenant_id = point.tenant_id
      and scope.clocking_location_id = point.id and scope.company_id = site.company_id
    where site.tenant_id = ${company.tenantId} and site.company_id = ${company.companyId}
      and site.name = ${workSiteName} and point.name = ${clockingPointName}
  `;
  assert.equal(records.length, 1, 'Expected one fictional work site and linked clocking point');
  const [record] = records;
  const site = '/admin/work-locations/' + record.site_id;
  const point = '/admin/work-locations/clocking/' + record.point_id;
  const pointView = {
    exactHeading: 'Clocking Location',
    content: clockingPointName,
    witness: 'dl dd:text-is("3.14, 101.69")',
  };
  const pointEdit = {
    exactHeading: 'Edit Clocking Location',
    witness: `form input[name="name"][value="${clockingPointName}"]`,
  };
  return [
    ...[group, company].flatMap(actor => [
      {
        actor, template: '/admin/work-locations/[id]', path: site,
        exactHeading: 'Location', content: workSiteName,
        witness: 'dl dd:text-is("PERF-CENSUS-SITE")',
      },
      {
        actor, template: '/admin/work-locations/[id]/edit', path: site + '/edit',
        exactHeading: 'Edit location',
        witness: `form input[name="name"][value="${workSiteName}"]`,
      },
    ]),
    ...[group, company].map(actor => ({
      actor, template: '/admin/work-locations/clocking/[id]', path: point, ...pointView,
    })),
    {
      actor: group, template: '/admin/work-locations/clocking/[id]/edit', path: point + '/edit', ...pointEdit,
    },
    {
      actor: company, template: '/admin/work-locations/clocking/[id]/edit', path: point + '/edit',
      redirectTo: point, ...pointView,
    },
    {
      actor: group, template: '/admin/locations/clocking/[id]', path: '/admin/locations/clocking/' + record.point_id,
      redirectTo: point + '/edit', ...pointEdit,
    },
  ];
}

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
  const payrollCases = await fixtureRoutes(db, fixture);
  const locationCases = await workLocationRoutes(db, fixture);
  const cases = [...payrollCases, ...locationCases];
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

export async function measureWorkLocationActions({ db, fixture, origin, signedInContext, report, save }) {
  const actor = fixture.users[1];
  assert.equal(actor.role, 'companyHR');
  const register = '/admin/work-locations/clocking';
  const returnTo = register + '?company=' + actor.companyId;
  const create = new URL('/admin/work-locations/new', origin);
  create.searchParams.set('companyId', actor.companyId);
  create.searchParams.set('from', returnTo);
  const code = 'PERF-CENSUS-ACTIONS';
  const names = ['Fictional action site', 'Fictional action site renamed'];
  const actions = [];
  report.workLocationActions = actions;
  const context = await signedInContext(actor);
  try {
    const page = await context.newPage();
    const main = page.locator('main:visible').first();
    const form = main.locator('form:has(input[name="name"])');
    const row = main.locator('[id^="row-"]').filter({ has: page.getByText(code, { exact: true }) });
    const persisted = () => db`
      select id, name, archived_at is not null as archived from location
      where tenant_id = ${actor.tenantId} and company_id = ${actor.companyId} and code = ${code}
    `;
    async function submit(action, button, expectedName, archived, existingId) {
      const path = new URL(page.url()).pathname;
      const started = performance.now();
      const observation = { action, role: actor.role, status: 'incomplete' };
      actions.push(observation);
      try {
        const [response] = await Promise.all([
          page.waitForResponse(response => {
            const target = new URL(response.url());
            return target.origin === origin && target.pathname === path && response.request().method() === 'POST';
          }, { timeout: 15000 }),
          button.click({ timeout: 15000 }),
        ]);
        observation.responseMs = Math.round(performance.now() - started);
        assert([200, 303].includes(response.status()), 'Unexpected location action response');
        await page.waitForURL(url => url.origin === origin && url.pathname === register &&
          url.searchParams.get('company') === actor.companyId && !url.searchParams.has('error'), { timeout: 15000 });
        await row.getByText(expectedName, { exact: true }).waitFor({ state: 'visible', timeout: 15000 });
        await row.getByText(archived ? 'Archived' : 'Active', { exact: true }).waitFor({ state: 'visible', timeout: 15000 });
        observation.usableMs = Math.round(performance.now() - started);
        const stored = await persisted();
        assert.equal(stored.length, 1, 'Expected precisely one fictional location in the authorized company');
        const [record] = stored;
        assert.equal(record.name, expectedName);
        assert.equal(record.archived, archived);
        if (existingId) assert.equal(record.id, existingId);
        observation.status = 'verified';
        return record.id;
      } finally {
        save();
      }
    }
    assert.equal((await persisted()).length, 0, 'Work Location action fixture already exists');
    const response = await page.goto(create.href, { waitUntil: 'domcontentloaded', timeout: 15000 });
    assert.equal(response?.status(), 200);
    await main.getByRole('heading', { name: 'New location', exact: true }).waitFor();
    await form.locator('input[name="code"]').fill(code);
    await form.locator('input[name="name"]').fill(names[0]);
    const id = await submit('create', form.getByRole('button', { name: 'Save', exact: true }), names[0], false);

    const openEditor = async () => {
      await row.getByRole('link', { name: 'Edit', exact: true }).click();
      await main.getByRole('heading', { name: 'Edit location', exact: true }).waitFor();
    };
    await openEditor();
    await form.locator('input[name="name"]').fill(names[1]);
    await submit('rename', form.getByRole('button', { name: 'Save', exact: true }), names[1], false, id);
    await openEditor();
    await submit('archive', main.getByRole('button', { name: 'Archive', exact: true }), names[1], true, id);
    await openEditor();
    await submit('restore', main.getByRole('button', { name: 'Restore', exact: true }), names[1], false, id);
    const events = await db`select event_type from domain_event
      where tenant_id = ${actor.tenantId} and aggregate_type = 'location' and aggregate_id = ${id}`;
    assert.deepEqual(Array.from(events, event => event.event_type).sort(),
      ['location.archived', 'location.created', 'location.restored', 'location.updated']);
    report.workLocationAuditVerified = true;
    save();
  } finally {
    await context.close();
  }
}
