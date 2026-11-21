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
    select employment.terminated_on::text as leaving_date, payroll_batch.pay_period, payslip.id as payslip_id
    from employment join payslip on payslip.tenant_id = employment.tenant_id and payslip.employment_id = employment.id
    join payroll_batch on payroll_batch.tenant_id = payslip.tenant_id and payroll_batch.id = payslip.batch_id
      and payroll_batch.company_id = employment.company_id
    where employment.tenant_id = ${leaver.tenantId}::uuid and employment.id = ${leaver.employmentId}::uuid
      and payslip.batch_id = ${unit.historicalBatchId}::uuid
      and payroll_batch.status = 'closed'
      and (payroll_batch.released_at is null or payroll_batch.released_at <= now())
  `;
  assert.equal(records.length, 1, 'Expected one retained fictional payslip for the scoped leaver');
  const [record] = records;
  assert.equal(record.leaving_date, fixture.today);
  assert.match(record.pay_period, /^\d{4}-\d{2}$/);
  const [run] = await db`
    select pay_period, status from payroll_batch where tenant_id = ${leaver.tenantId}::uuid
      and company_id = ${leaver.companyId}::uuid and id = ${unit.batchId}::uuid
  `;
  assert.match(run?.pay_period ?? '', /^\d{4}-\d{2}$/, 'Expected the same-company Payroll run');
  const base = '/payroll/cp22a/' + leaver.employmentId;
  const citizenshipSubject = fixture.users[4];
  assert.equal(citizenshipSubject.companyId, unit.companyId);
  const taxConfiguration = '/payroll/' + unit.batchId + '/tax-configuration/' + citizenshipSubject.employmentId;
  const year = record.pay_period.slice(0, 4);
  const ea = '/payroll/reports/ea/' + leaver.employmentId + '?year=' + year + '&company=' + leaver.companyId;
  const payslip = '/me/payslip/' + record.payslip_id;
  const payMonth = new Intl.DateTimeFormat('en', { month: 'long', year: 'numeric', timeZone: 'UTC' })
    .format(new Date(record.pay_period + '-01T00:00:00Z'));
  const person = '/personnel/' + citizenshipSubject.employmentId + '?from=org';
  const legacyPerson = '/people/' + citizenshipSubject.employmentId + '?from=org';
  const group = fixture.users[0];
  assert.equal(group.role, 'groupHR');
  assert.equal(group.tenantId, citizenshipSubject.tenantId);
  const cp21 = '/payroll/cp21/' + citizenshipSubject.employmentId;
  const cp22 = '/payroll/cp22/' + citizenshipSubject.employmentId;
  const [currentYear, currentMonth] = fixture.today.split('-').map(Number);
  const tp1 = '/payroll/transactions/tp1/' + currentYear;
  const tp1Query = '?employmentId=' + citizenshipSubject.employmentId;
  const tp1Month = `${tp1}/${currentMonth}${tp1Query}`;
  const tp1Form = {
    exactHeading: 'Add TP1 relief', content: citizenshipSubject.name,
    witness: `form:has(input[name="employmentId"][value="${citizenshipSubject.employmentId}"]) button[type="submit"]`,
  };
  assert.equal(run.status, 'draft', 'Expected a draft Payroll run for the close guard');
  return [
    {
      actor: leaver, template: '/me/payslip/[payslipId]', path: payslip,
      exactHeading: 'Payslip · ' + payMonth, content: leaver.name,
      witness: 'a[download][href="' + payslip + '/pdf"]',
    },
    {
      actor: company, template: '/people/[employmentId]', path: legacyPerson, redirectTo: person,
      exactHeading: citizenshipSubject.name, witness: 'a[href="/org"]',
    },
    {
      actor: group, template: '/admin/users/[userId]/account', path: '/admin/users/' + citizenshipSubject.userId + '/account',
      exactHeading: 'Manage account', content: citizenshipSubject.username, exactContent: true,
      witness: 'section ul',
    },
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
    {
      actor: group, template: '/payroll/[batchId]/close', path: `/payroll/${unit.batchId}/close`,
      exactHeading: 'Close batch', content: 'Only a processed payroll process can be closed.',
    },
    ...[group, company].flatMap(actor => [
      {
        actor, template: '/payroll/cp21/[employmentId]/preview', path: cp21 + '/preview',
        exactHeading: 'CP21 — notice of an employee leaving Malaysia', content: citizenshipSubject.name,
        witness: `form[data-cp21-typed][action="${cp21}/preview"]`, inlinePdf: cp21 + '/pdf',
      },
      {
        actor, template: '/payroll/cp22/[employmentId]/preview', path: cp22 + '/preview',
        exactHeading: 'Review the CP22 before you produce it', content: citizenshipSubject.name,
        witness: `form[action="${cp22}/preview"]`,
      },
      { actor, template: '/payroll/transactions/tp1/[year]/[month]', path: tp1Month, ...tp1Form },
    ]),
    {
      actor: company, template: '/payroll/transactions/tp1/[year]', path: tp1 + tp1Query,
      redirectTo: tp1Month, ...tp1Form,
    },
  ];
}

async function payrollCorrectionState(db, fixture) {
  const actor = fixture.users[0];
  const { batchId } = fixture.tenants[0].companies[0];
  const [state] = await db`
    select b.status, p.status as period_status, count(s.id)::int as slips,
      coalesce(sum(s.net_pay), 0)::text as total_net
    from payroll_batch b
    join pay_period p on p.id = b.pay_period_id and p.tenant_id = b.tenant_id
    left join payslip s on s.batch_id = b.id and s.tenant_id = b.tenant_id
    where b.id = ${batchId}::uuid and b.tenant_id = ${actor.tenantId}::uuid
    group by b.status, p.status
  `;
  assert(state?.status === 'processed' && state.period_status === 'open' && state.slips === 50,
    'Expected a processed, open fictional run with 50 payslips');
  return state;
}

async function organisationLifecycleRoutes(db, fixture) {
  const [group, company] = fixture.users;
  assert.equal(group.role, 'groupHR');
  assert.equal(company.role, 'companyHR');
  assert.equal(group.tenantId, company.tenantId);
  const [record] = await db`
    select id, legal_name, country from company
    where tenant_id = ${company.tenantId}::uuid and id = ${company.companyId}::uuid and archived_at is null
  `;
  assert(record?.legal_name && record.country === 'MY', 'Expected the fictional Malaysian company');
  const [ownJoiner] = fixture.joiners;
  const cases = await db`
    select id from lc_onboarding_case
    where tenant_id = ${company.tenantId}::uuid and company_id = ${company.companyId}::uuid
      and coalesce(data->'source'->>'fullName', data->'local'->>'fullName') = ${ownJoiner}
  `;
  assert.equal(cases.length, 1, 'Expected the seeded company-scoped onboarding case');
  const organisation = `/admin/organization/${record.id}`;
  const { onboarding, offboarding, asset, request, joiner, leaver, model, justification } = fixture.lifecycleRecords;
  const lifecycleRoutes = [
    {
      template: '/lifecycle/v9/onboarding/[id]', path: `/lifecycle/v9/onboarding/${cases[0].id}`,
      exactHeading: ownJoiner, witness: '.onb-workspace a[href="/lifecycle/v9"]',
    },
    {
      template: '/lifecycle/onboarding/[number]', path: `/lifecycle/onboarding/${onboarding.number}`,
      exactHeading: `${onboarding.number} · ${joiner}`,
      content: 'Collect new hire bank account details for payroll setup', exactContent: true,
    },
    {
      template: '/lifecycle/offboarding/[number]', path: `/lifecycle/offboarding/${offboarding.number}`,
      exactHeading: `${offboarding.number} · ${leaver}`,
      witness: `form:has(input[name="number"][value="${offboarding.number}"]) button[name="outcome"][value="accepted"]`,
    },
    {
      template: '/lifecycle/requisitions/[number]', path: `/lifecycle/requisitions/${onboarding.requisitionNumber}`,
      exactHeading: `${onboarding.requisitionNumber} · ${joiner}`,
      witness: `form:has(input[name="number"][value="${onboarding.requisitionNumber}"]):has(input[name="key"][value="laptop_issue"]) select[name="assetCode"]`,
    },
    {
      template: '/lifecycle/assets/[code]', path: `/lifecycle/assets/${asset.code}`,
      exactHeading: `${asset.code} · Laptop`, content: model, witness: 'a[href="/lifecycle/assets"]',
    },
    {
      template: '/lifecycle/asset-requests/[number]', path: `/lifecycle/asset-requests/${request.number}`,
      exactHeading: `${request.number} · Laptop`, content: justification,
      witness: `form:has(input[name="number"][value="${request.number}"]) select[name="handler"]`,
    },
  ];
  return [
    {
      actor: group, template: '/admin/organization/[companyId]', path: organisation,
      exactHeading: record.legal_name,
      witness: `form[data-save-section="company"]:has(input[name="id"][value="${record.id}"]) input[name="legalName"]`,
    },
    {
      actor: group, template: '/admin/organization/[companyId]/view', path: organisation + '/view',
      exactHeading: record.legal_name, witness: `a[data-company-edit-link][href^="${organisation}"]`,
    },
    {
      actor: group, template: '/admin/organization/[companyId]/statutory', path: organisation + '/statutory',
      exactHeading: 'Statutory Payment Setup', content: record.legal_name,
      witness: `form[data-statutory-form]:has(input[name="companyId"][value="${record.id}"]) input[name="epfEmployerNo"]`,
    },
    ...lifecycleRoutes.flatMap(route => [group, company].map(actor => ({ ...route, actor }))),
    ...[group, company].map(actor => ({
      actor, template: '/lifecycle/onboarding/cases/[id]', path: `/lifecycle/onboarding/cases/${cases[0].id}`,
      exactHeading: ownJoiner, witness: '.onb-workspace a[href="/lifecycle/onboarding"]',
    })),
  ];
}

async function performanceRoutes(db, fixture) {
  const [group, company, manager, , employee] = fixture.users;
  assert.deepEqual([group.role, company.role, manager.role, employee.role], ['groupHR', 'companyHR', 'manager', 'employee']);
  const { cycleId, name } = fixture.performanceRecords;
  const [subject] = await db`
    select r.id, r.reviewer_employment_id
    from performance_review r join review_cycle c on c.id = r.cycle_id and c.tenant_id = r.tenant_id
    where c.id = ${cycleId}::uuid and c.tenant_id = ${employee.tenantId}::uuid and c.status = 'open'
      and c.company_id = ${employee.companyId}::uuid and r.employment_id = ${employee.employmentId}::uuid
  `;
  assert.equal(subject?.reviewer_employment_id, manager.employmentId, 'Expected the seeded subject-to-manager review');
  const cycle = '/performance/' + cycleId;
  const reviewHeading = `${employee.name} · ${name}`;
  return [
    ...[group, company].flatMap(actor => [
      {
        actor, template: '/performance/[cycleId]', path: cycle, exactHeading: name,
        witness: `a[href="${cycle}/cycle/calendar"]`,
      },
      {
        actor, template: '/performance/[cycleId]/[section]/[tab]', path: cycle + '/cycle/calendar',
        exactHeading: 'Cycle', content: name, exactContent: true,
        witness: `form:has(input[name="cycleId"][value="${cycleId}"]) button[type="submit"]`,
      },
      {
        actor, template: '/performance/[cycleId]/release', path: cycle + '/release',
        exactHeading: 'Release results', content: name, exactContent: true,
        witness: 'form select[name="companyId"]',
      },
    ]),
    {
      actor: employee, template: '/performance/review/[reviewId]', path: '/performance/review/' + subject.id,
      exactHeading: reviewHeading, content: 'KPI scorecard', exactContent: true,
    },
    {
      actor: manager, template: '/performance/team/[reviewId]', path: '/performance/team/' + subject.id,
      exactHeading: reviewHeading, content: 'KPI scorecard', exactContent: true,
    },
  ];
}

async function payrollCorrectionRoutes(db, fixture) {
  const [group, company] = fixture.users;
  const subject = fixture.users[4];
  const { batchId, historicalBatchId } = fixture.tenants[0].companies[0];
  assert.equal(group.role, 'groupHR');
  assert.equal(company.role, 'companyHR');
  assert.equal(subject.companyId, group.companyId);
  assert.equal(subject.companyId, company.companyId);
  const [history] = await db`
    select a.pay_period, c.legal_name as company_name
    from payroll_batch a
    join payslip p on p.batch_id = a.id and p.tenant_id = a.tenant_id
    join company c on c.id = a.company_id and c.tenant_id = a.tenant_id
    where a.id = ${historicalBatchId}::uuid and a.tenant_id = ${company.tenantId}::uuid
      and a.company_id = ${company.companyId}::uuid and a.status = 'closed'
      and p.employment_id = ${subject.employmentId}::uuid
  `;
  assert.match(history?.pay_period ?? '', /^\d{4}-\d{2}$/);
  const year = history.pay_period.slice(0, 4);
  return [
    ...[
      ['remove', 'Remove Employee Payroll', subject.name],
      ['reprocess', 'Reprocess selected employees', subject.name],
      ['reset', 'Reset Payroll Process', history.company_name],
    ].map(([operation, exactHeading, content]) => ({
      actor: group, exactHeading, template: '/payroll/[batchId]/' + operation,
      path: '/payroll/' + batchId + '/' + operation, content,
      witness: `form:has(input[name="batchId"][value="${batchId}"]) textarea[name="reason"]`,
    })),
    ...[group, company].map(actor => ({
      actor, template: '/payroll/statutory-forms/[formId]',
      path: `/payroll/statutory-forms/my.cp8d?companyId=${company.companyId}&year=${year}`,
      exactHeading: 'Form E / CP8D — annual (LHDN)', content: subject.name, exactContent: true,
      witness: `table tbody a[href="/payroll/reports/ea/${subject.employmentId}?year=${year}"]`,
    })),
  ];
}

async function personnelMovementRoutes(db, fixture) {
  return Promise.all(['groupHR', 'companyHR'].map(async role => {
    const actor = fixture.users.find(user => user.role === role && user.tenant === 0);
    const subject = actor && fixture.users.find(user =>
      user.role === 'employee' && user.tenant === actor.tenant && user.company === actor.company);
    assert(actor && subject, 'Expected a scoped fictional Personnel movement actor and subject');
    const events = await db`select id from domain_event
      where tenant_id=${actor.tenantId}::uuid and subject_employment_id=${subject.employmentId}::uuid
        and event_type='employment.hired'`;
    assert.equal(events.length, 1, 'Expected one native hire event for the fixture employment');
    return {
      actor, template: '/admin/personnel/[employmentId]/movement/[mode]/[movementId]',
      path: `/admin/personnel/${subject.employmentId}/movement/view/${events[0].id}`,
      content: subject.name, witness: '#section-movement-detail dd:text-is("Hired")',
    };
  }));
}

function payrollFormulaEvaluationRoutes(fixture) {
  const [group, company] = fixture.users;
  const evaluation = fixture.payrollFormulaEvaluation;
  assert.equal(group.role, 'groupHR');
  assert.equal(company.role, 'companyHR');
  assert.equal(evaluation.companyId, company.companyId);
  assert.match(evaluation.id, /^[0-9a-f-]{36}$/i);
  assert.equal(Number(evaluation.amount), 25);
  assert.equal(evaluation.componentCode, 'PERF_TRACE_AMOUNT');
  return [group, company].map(actor => ({
    actor, template: '/payroll/formula-builder/evaluations/[id]',
    path: '/payroll/formula-builder/evaluations/' + evaluation.id,
    exactHeading: 'Saved formula calculation', content: evaluation.componentCode, exactContent: true,
    witness: 'dl div:has(dt:text-is("Calculated amount")) dd:text-is("' + evaluation.amount + '")',
  }));
}

function importHistoryRoutes(fixture) {
  const [group, company] = fixture.users;
  const { companyId, employeeCode, employeeName, personnel, payroll } = fixture.importHistory;
  assert.equal(group.role, 'groupHR');
  assert.equal(company.role, 'companyHR');
  assert.equal(group.companyId, companyId);
  assert.equal(company.companyId, companyId);
  for (const id of [personnel.attemptId, personnel.runId, payroll.attemptId, payroll.recordId]) {
    assert.match(id, /^[0-9a-f-]{36}$/i);
  }
  const personnelBase = '/admin/personnel/import/history';
  const payrollBase = '/payroll/history-import';
  const personnelRun = `${personnelBase}/runs/${personnel.runId}`;
  const payrollLog = `${payrollBase}/logs/${payroll.attemptId}`;
  return [group, company].flatMap(actor => [
    { actor, template: personnelBase + '/[attemptId]', path: personnelBase + '/' + personnel.attemptId,
      exactHeading: personnel.file, witness: `tbody td:has-text("${employeeName}")` },
    { actor, template: personnelBase + '/runs/[runId]', path: personnelRun,
      exactHeading: personnel.file, witness: `div:has(dl dd:text-is("1")) a[href="${personnelBase}/${personnel.runId}/error-log"]` },
    { actor, template: payrollBase + '/logs/[attemptId]', path: payrollLog,
      exactHeading: payroll.file, witness: `a[href="${payrollLog}/report"]` },
    { actor, template: payrollBase + '/records/[recordId]', path: payrollBase + '/records/' + payroll.recordId,
      exactHeading: `${employeeCode} · ${employeeName}`, witness: `a[href="${payrollLog}"]:text-is("${payroll.file}")` },
  ]);
}

function personnelDirectoryRoutes(fixture) {
  const [group, company] = fixture.users;
  assert.equal(group.role, 'groupHR');
  assert.equal(company.role, 'companyHR');
  assert.equal(group.companyId, company.companyId);
  const subject = fixture.users.find(user => user.role === 'employee' && user.companyId === company.companyId);
  assert(subject, 'Expected a fictional employee in the shared company');
  const template = '/admin/personnel';
  const witness = `tbody tr[data-employment-id="${subject.employmentId}"]`;
  const search = new URLSearchParams({q: subject.name});
  const companySearch = new URLSearchParams({q: subject.name,company: company.companyId});
  return [group, company].flatMap(actor => [
    { actor, template, path: template, witness: 'tbody tr[data-employment-id]', scenario: 'directory open' },
    { actor, template, path: template + '?' + search, witness, scenario: 'employee search' },
    { actor, template, path: template + '?' + companySearch, witness, scenario: 'company-filtered search' },
  ]);
}

export async function measureFixtureRecordCensus({ db, fixture, origin, compiledPages, signedInContext, report, save, payrollCorrections, personnelMovement, payrollFormulaEvaluation, importHistory, personnelDirectory }) {
  const before = payrollCorrections ? await payrollCorrectionState(db, fixture) : null;
  const cases = personnelMovement ? await personnelMovementRoutes(db, fixture)
    : payrollFormulaEvaluation ? payrollFormulaEvaluationRoutes(fixture)
    : importHistory ? importHistoryRoutes(fixture)
    : personnelDirectory ? personnelDirectoryRoutes(fixture)
    : payrollCorrections ? await payrollCorrectionRoutes(db, fixture)
    : [
      ...await fixtureRoutes(db, fixture), ...await workLocationRoutes(db, fixture),
      ...await organisationLifecycleRoutes(db, fixture), ...await performanceRoutes(db, fixture),
    ];
  assert(cases.every(row => compiledPages.has(row.template)), 'A planned record route is absent from the measured build');
  report.fixtureRecordCensus = { plannedTemplates: new Set(cases.map(row => row.template)).size, plannedJourneys: cases.length, observations: [] };
  const rows = report.fixtureRecordCensus.observations;
  save();
  for (const entry of cases) {
    const context = await signedInContext(entry.actor);
    try {
      const page = await context.newPage();
      for (const pass of ['first', 'repeat']) {
        const row = { template: entry.template, role: entry.actor.role, pass, outcome: 'browser-failure', step: 'response',
          ...(entry.scenario && {scenario: entry.scenario}) };
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
  if (before) {
    assert.deepEqual(await payrollCorrectionState(db, fixture), before, 'Opening correction forms must preserve the run');
    report.payrollCorrectionRunPreserved = true;
    save();
  }
  assert.equal(rows.length, cases.length * 2);
  assert(rows.every(row => row.outcome === 'usable-content'), 'One or more fictional record screens missed their readiness witness');
}
