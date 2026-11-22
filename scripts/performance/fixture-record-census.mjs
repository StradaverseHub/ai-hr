import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';

const workSiteName = 'Fictional Census Work Site';
const clockingPointName = 'Fictional Census Clocking Point';
const fixedItemCode = 'PERF-CENSUS-FIXED';
const fixedItemName = 'Fictional Census Fixed Allowance';
const fixedItemNote = 'Fictional census recurring allowance';

export async function seedFixedTransactionRecord(owner, fixture) {
  const company = fixture.users[1];
  const employee = fixture.users[4];
  assert.equal(company.role, 'companyHR');
  assert.equal(employee.tenantId, company.tenantId);
  assert.equal(employee.companyId, company.companyId);
  await owner.begin(async tx => {
    await tx`select set_config('app.tenant_id', ${company.tenantId}, true)`;
    const [item] = await tx`
      insert into pay_component (tenant_id, code, name, kind)
      values (${company.tenantId}, ${fixedItemCode}, ${fixedItemName}, 'allowance')
      returning id
    `;
    await tx`
      insert into employment_pay_component (tenant_id, employment_id, component_id, amount, valid_from, remarks)
      values (${company.tenantId}, ${employee.employmentId}, ${item.id}, 123.45,
        date_trunc('month', ${fixture.today}::date)::date, ${fixedItemNote})
    `;
  });
}

async function fixedTransactionRoutes(db, fixture) {
  const [group, company] = fixture.users;
  const employee = fixture.users[4];
  const records = await db`
    select fixed.id
    from employment_pay_component fixed
    join pay_component item on item.tenant_id = fixed.tenant_id and item.id = fixed.component_id
    where fixed.tenant_id = ${company.tenantId} and fixed.employment_id = ${employee.employmentId}
      and fixed.superseded_at is null and item.code = ${fixedItemCode}
  `;
  assert.equal(records.length, 1, 'Expected one fictional fixed transaction for the in-scope employee');
  const template = '/payroll/transactions/fixed/[id]';
  const path = '/payroll/transactions/fixed/' + records[0].id + '?employmentId=' + employee.employmentId;
  return [group, company].map(actor => ({
    actor, template, path,
    exactHeading: fixedItemCode + ' — ' + fixedItemName,
    witness: `form:has(input[name="amount"][value="123.45"]) input[name="remarks"][value="${fixedItemNote}"]`,
  }));
}

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
  const { cycleId, name, teamReviewId, objective } = fixture.performanceRecords;
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
      actor: manager, template: '/performance/team/[reviewId]', path: '/performance/team/' + teamReviewId,
      exactHeading: `${fixture.users[6].name} · ${name}`, content: objective, exactContent: true,
    },
  ];
}

async function performanceReportRecordRoutes(db, fixture) {
  const [group, company] = fixture.users;
  const employee = fixture.users[6];
  const performance = fixture.performanceRecords;
  assert(performance && employee.role === 'employee' && employee.companyId === company.companyId);
  const [rating] = await db`
    select rr.last_event, rr.snapshot->>'name' as name
    from performance_assessment_rating_record rr
    join performance_review r on r.id=rr.review_id and r.tenant_id=rr.tenant_id
    where r.id=${performance.teamReviewId}::uuid and r.cycle_id=${performance.cycleId}::uuid
      and r.employment_id=${employee.employmentId}::uuid and r.tenant_id=${employee.tenantId}::uuid
  `;
  assert.equal(rating?.last_event, 'pm_self_submit', 'Expected a rating from the native submission');
  assert.equal(rating.name, employee.name);
  const cycle = '/performance/' + performance.cycleId;
  const report = cycle + '/reports';
  const query = 'kind=participants&groupBy=person&status=all';
  return [group, company].flatMap(actor => [
    {
      actor, template: '/performance/[cycleId]/records', path: cycle + '/records',
      exactHeading: 'Rating records', content: performance.name, exactContent: true,
      witness: `tbody a[href="/performance/review/${performance.teamReviewId}"]:text-is(${JSON.stringify(employee.name)})`,
    },
    {
      actor, template: '/performance/[cycleId]/reports', path: report + '?' + query,
      exactHeading: 'Who takes part, person by person · ' + performance.name,
      witness: `tbody tr:has(td:text-is(${JSON.stringify(employee.name)})) td:text-is("Yes")`,
      download: {
        href: report + '/export?' + query + '&format=xlsx',
        filename: 'performance-report.xlsx',
        step: 'performance-report-download',
        measurement: 'performanceReportWorkbookMs',
      },
    },
  ]);
}

async function jobDescriptionRecordRoutes(db, fixture) {
  const [group, company] = fixture.users;
  const record = fixture.jobDescriptionRecord;
  assert(record && group.companyId === company.companyId);
  const [saved] = await db`
    select j.job_code, r.title, r.answers->'purpose'->0->>'purpose' as purpose, r.status
    from job_document j
    join job_document_revision r on r.job_id=j.id and r.tenant_id=j.tenant_id
    where j.tenant_id=${company.tenantId}::uuid and j.company_id=${company.companyId}::uuid
      and j.id=${record.jobId}::uuid and r.id=${record.revisionId}::uuid
  `;
  assert.deepEqual({ ...saved }, { job_code: record.code, title: record.title, purpose: record.purpose, status: 'draft' });
  const base = '/admin/job-descriptions/' + record.jobId;
  const query = '?revision=' + record.revisionId;
  return [group, company].flatMap(actor => [
    {
      actor, template: '/admin/job-descriptions/[id]', path: base + query + '&view=document',
      exactHeading: record.title, content: record.purpose, exactContent: true,
      witness: `a[href="${base}/print${query}"]`,
      download: { href: base + '/export' + query, filename: record.code + '-v1.txt',
        step: 'job-description-export', measurement: 'jobDescriptionExportMs', text: record.purpose },
    },
    {
      actor, template: '/admin/job-descriptions/[id]/print', path: base + '/print' + query,
      exactHeading: record.title, content: record.purpose, exactContent: true, print: true,
    },
  ]);
}

async function noticeRecordRoutes(db, fixture) {
  const [group, company, , , employee] = fixture.users;
  const record = fixture.noticeRecord;
  assert(record?.employmentId === employee.employmentId);
  const recipients = await db`
    select nr.employment_id, n.content_version, nr.first_viewed_at
    from notice_recipient nr join notice n on n.id=nr.notice_id and n.tenant_id=nr.tenant_id
    where n.id=${record.id}::uuid and n.tenant_id=${company.tenantId}::uuid
      and n.company_id=${company.companyId}::uuid and n.published_at is not null
    order by nr.employment_id
  `;
  assert.deepEqual([...recipients], [{ employment_id: employee.employmentId, content_version: 1, first_viewed_at: null }]);
  return [
    ...[group, company].map(actor => ({
      actor, template: '/admin/notice-board/[id]', path: '/admin/notice-board/' + record.id,
      exactHeading: record.title, content: 'This notice was published to 1 employee(s).', exactContent: true,
    })),
    {
      actor:employee, template:'/notices/[id]', path:'/notices/' + record.id + '?employmentId=' + employee.employmentId,
      exactHeading:record.title, content:record.body, exactContent:true, acknowledgeNotice:record.id,
    },
  ];
}

async function verifyNoticeAcknowledgement(page, main, db, entry, row, pass, timeout) {
  const {actor, acknowledgeNotice} = entry;
  const receipts = () => db`
    select actor_user_id, content_version, acknowledged_at, source_event_id
    from notice_acknowledgement where tenant_id=${actor.tenantId}::uuid
      and notice_id=${acknowledgeNotice}::uuid and employment_id=${actor.employmentId}::uuid
  `;
  const [view] = await db`
    select first_viewed_at from notice_recipient where tenant_id=${actor.tenantId}::uuid
      and notice_id=${acknowledgeNotice}::uuid and employment_id=${actor.employmentId}::uuid
  `;
  assert(view?.first_viewed_at, 'The recipient view must be recorded');
  const status = main.locator('p[role="status"] time');
  if (pass === 'first') {
    assert.equal((await receipts()).length, 0, 'Opening the notice must not record consent');
    const started = performance.now();
    const reply = page.waitForResponse(response => {
      const request = response.request();
      return request.method() === 'POST' && Boolean(request.headers()['next-action'])
        && new URL(response.url()).pathname === '/notices/' + acknowledgeNotice;
    }, { timeout });
    const clicked = main.getByRole('button',{name:'Acknowledge this version',exact:true}).click({timeout});
    const [response] = await Promise.all([reply,clicked]);
    assert.equal(response.status(),200);
    await status.waitFor({state:'visible',timeout});
    row.noticeAcknowledgementMs = Math.round(performance.now()-started);
  } else {
    await status.waitFor({state:'visible',timeout});
  }
  const rows = await receipts();
  assert.equal(rows.length,1);
  assert.equal(rows[0].actor_user_id,actor.userId);
  assert.equal(rows[0].content_version,1);
  assert(rows[0].acknowledged_at && rows[0].source_event_id);
  row.noticeAcknowledgementPersisted = true;
}

async function attendanceConfigurationRoutes(db, fixture) {
  const [group, company] = fixture.users;
  const records = fixture.attendanceConfigurationRecords;
  assert(records);
  const [source] = await db`
    select h.name as calendar, r.name as rule, a.name as allowance, a.code
    from holiday_group h
    join attendance_rule r on r.id=${records.ruleId}::uuid and r.tenant_id=h.tenant_id and r.is_default
    join attendance_allowance_policy a on a.id=${records.allowanceId}::uuid
      and a.tenant_id=h.tenant_id and a.company_id=${company.companyId}::uuid and a.amount=125
    where h.id=${records.calendarId}::uuid and h.tenant_id=${company.tenantId}::uuid and h.active
  `;
  assert.deepEqual({ ...source }, {
    calendar:records.calendarName, rule:'Standard', allowance:records.allowanceName, code:records.allowanceCode,
  });
  const rule = '/admin/attendance/schedule/' + records.ruleId;
  const allowance = '/admin/attendance-allowance/' + records.allowanceId;
  return [group, company].flatMap(actor => [
    { actor, template:'/admin/holidays/groups/[id]', path:'/admin/holidays/groups/' + records.calendarId,
      exactHeading:'Edit holiday group', witness:`input[name="name"][value="${records.calendarName}"]` },
    { actor, template:'/admin/attendance-policy/rules/[ruleId]', path:'/admin/attendance-policy/rules/' + records.ruleId,
      redirectTo:rule + '/edit', exactHeading:'Edit Schedule Group', content:'Standard', exactContent:true,
      witness:`a[href="${rule}"]` },
    { actor, template:'/admin/attendance/settings/formula-builder/[id]',
      path:'/admin/attendance/settings/formula-builder/' + records.ruleId,
      redirectTo:'/admin/attendance/settings', witness:'[data-tour="attendance-configuration"] a[href="/admin/attendance-allowance"]' },
    { actor, template:'/admin/attendance-allowance/[policyId]', path:allowance,
      exactHeading:records.allowanceCode + ' · ' + records.allowanceName, witness:`a[href="${allowance}?edit=1"]` },
  ]);
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
  const byRole = await Promise.all(['groupHR', 'companyHR'].map(async role => {
    const actor = fixture.users.find(user => user.role === role && user.tenant === 0);
    const subject = actor && fixture.users.find(user =>
      user.role === 'employee' && user.tenant === actor.tenant && user.company === actor.company);
    assert(actor && subject, 'Expected a scoped fictional Personnel movement actor and subject');
    const events = await db`select id from domain_event
      where tenant_id=${actor.tenantId}::uuid and subject_employment_id=${subject.employmentId}::uuid
        and event_type='employment.hired'`;
    assert.equal(events.length, 1, 'Expected one native hire event for the fixture employment');
    const profile = '/admin/personnel/' + subject.employmentId;
    const movement = profile + '/movement';
    const hired = movement + '/view/' + events[0].id;
    return [
      { actor, template: '/admin/personnel/[employmentId]', path: profile, exactHeading: subject.name,
        witness: '#section-personal-details form[data-save-section="person"]', personnelTabs: true, subject },
      { actor, template: '/personnel/[employmentId]', path: '/personnel/' + subject.employmentId,
        exactHeading: subject.name, witness: 'dl dd' },
      { actor, template: '/admin/personnel/[employmentId]/movement/[mode]', path: movement + '/history',
        content: subject.name, witness: `#section-assignment-history a[href^="${hired}"]` },
      { actor, template: '/admin/personnel/[employmentId]/movement/[mode]/[movementId]', path: hired,
        content: subject.name, witness: '#section-movement-detail dd:text-is("Hired")' },
    ];
  }));
  return byRole.flat();
}

async function attendanceRecordRoutes(db, fixture) {
  const [group, company] = fixture.users;
  assert.equal(group.role, 'groupHR');
  assert.equal(company.role, 'companyHR');
  assert.equal(group.tenantId, company.tenantId);
  const shifts = await db`select id from shift where tenant_id=${group.tenantId}::uuid
    and company_id is null and code='PERF-DAY' and archived_at is null`;
  assert.equal(shifts.length, 1);
  const mappingId = fixture.tenants[group.tenant].clockingMappingId;
  assert.match(mappingId, /^[0-9a-f-]{36}$/i);
  const mapping = '/admin/attendance/file-mappings/' + mappingId;
  const workflows = await db`select lineage_id from attendance_workflow_template
    where tenant_id=${company.tenantId}::uuid and company_id=${company.companyId}::uuid
      and code='PERF' and version=1 and superseded_at is null`;
  assert.equal(workflows.length, 1, 'Expected the seeded company Attendance approval workflow');
  const workflowName = 'Fictional performance approval';
  const workflow = '/admin/attendance/approval-workflow/' + workflows[0].lineage_id;
  const routes = [group, company].flatMap(actor => {
    const subject = fixture.users.find(user => user.role === 'employee' &&
      user.tenantId === actor.tenantId && user.companyId === actor.companyId);
    assert(subject, 'Expected a fictional employee in the selected company');
    return [
      { actor, template: '/admin/attendance/[shiftId]', path: '/admin/attendance/' + shifts[0].id,
        exactHeading: 'Edit shift', witness: '#shift-form input[name="code"][value="PERF-DAY"]' },
      { actor, template: '/admin/attendance/file-mappings/[mappingId]', path: mapping,
        exactHeading: 'PERF coded clocking CSV', witness: `a[href="${mapping}/edit"]` },
      { actor, template: '/admin/attendance/file-mappings/[mappingId]/edit', path: mapping + '/edit',
        witness: 'input[id$="-name"][value="PERF coded clocking CSV"]' },
      { actor, template: '/admin/attendance/schedule-assignment/[employmentId]',
        path: '/admin/attendance/schedule-assignment/' + subject.employmentId,
        content: subject.name, witness: 'dl dd' },
      { actor, template: '/attendance/individual/[date]',
        path: '/attendance/individual/' + fixture.today + '?emp=' + subject.employmentId,
        exactHeading: 'Attendance detail', content: subject.name, witness: ':text-is("09:00")' },
      { actor, template: '/admin/attendance/approval-workflow/[lineageId]', path: workflow,
        exactHeading: workflowName, witness: `a[href="${workflow}/edit"]` },
      { actor, template: '/admin/attendance/approval-workflow/[lineageId]/edit', path: workflow + '/edit',
        exactHeading: 'Edit ' + workflowName, witness: '#attendance-workflow-form input[name="code"][value="PERF"]' },
      { actor, template: '/admin/attendance/approval-workflow/[lineageId]/previews', path: workflow + '/previews',
        exactHeading: 'Preview History', content: workflowName, witness: 'button:text-is("Generate new preview")',
        ...(actor.role === 'companyHR' && { workflowPreviewLineage: workflows[0].lineage_id }) },
    ];
  });
  const employee = fixture.users.find(user => user.role === 'employee' &&
    user.tenantId === company.tenantId && user.companyId === company.companyId);
  assert(employee, 'Expected a signed-in employee with historical Attendance rows');
  routes.push({
    actor: employee, template: '/attendance/my-records/[date]',
    path: '/attendance/my-records/' + fixture.today + '?employmentId=' + employee.employmentId,
    exactHeading: 'Attendance detail', content: employee.name, witness: 'input[name="checkIn"][value="09:00"]',
  });
  return routes;
}

async function verifyAttendanceWorkflowPreview(page, db, entry, report, save) {
  const result = { role: entry.actor.role, status: 'failed' };
  report.attendanceWorkflowPreviewAction = result;
  const timeout = 15000;
  const main = page.locator('main:visible').first();
  const started = performance.now();
  try {
    await main.getByRole('button', { name: 'Generate new preview', exact: true }).click({ timeout });
    await page.waitForURL(url => url.pathname === entry.path && url.searchParams.has('id'), { timeout });
    await main.locator('dl dd').first().waitFor({ state: 'visible', timeout });
    const id = new URL(page.url()).searchParams.get('id');
    assert.match(id, /^[0-9a-f-]{36}$/i);
    const rows = await db`select company_ids, total_matching, template_version
      from attendance_workflow_preview
      where id=${id}::uuid and tenant_id=${entry.actor.tenantId}::uuid
        and lineage_id=${entry.workflowPreviewLineage}::uuid
        and generated_by_user_id=${entry.actor.userId}::uuid`;
    assert.equal(rows.length, 1);
    assert.deepEqual(rows[0].company_ids, [entry.actor.companyId]);
    assert.equal(rows[0].template_version, 1);
    assert(rows[0].total_matching > 0, 'Expected the preview to include the seeded employee cohort');
    result.status = 'passed';
  } finally {
    result.elapsedMs = Math.round(performance.now() - started);
    save();
  }
}

function payrollFormulaEvaluationRoutes(fixture) {
  const [group, company] = fixture.users;
  const evaluation = fixture.payrollFormulaEvaluation;
  assert.equal(group.role, 'groupHR');
  assert.equal(company.role, 'companyHR');
  assert.equal(evaluation.companyId, company.companyId);
  assert.match(evaluation.id, /^[0-9a-f-]{36}$/i);
  assert.match(evaluation.formulaId, /^[0-9a-f-]{36}$/i);
  assert.match(evaluation.cycleId, /^[0-9a-f-]{36}$/i);
  assert.equal(Number(evaluation.amount), 25);
  assert.equal(evaluation.componentCode, 'PERF_TRACE_AMOUNT');
  return [
    ...[group, company].map(actor => ({
      actor, template: '/payroll/formula-builder/evaluations/[id]',
      path: '/payroll/formula-builder/evaluations/' + evaluation.id,
      exactHeading: 'Saved formula calculation', content: evaluation.componentCode, exactContent: true,
      witness: 'dl div:has(dt:text-is("Calculated amount")) dd:text-is("' + evaluation.amount + '")',
    })),
    {
      actor: group, template: '/payroll/formula-builder/[id]',
      path: '/payroll/formula-builder/' + evaluation.formulaId + '?view=1',
      exactHeading: 'PERF_TRACE', witness: '[data-formula-source-panel] textarea',
      formulaSample: { source: 'Return {#Input} * 2', value: '12.5' },
    },
    {
      actor: group, template: '/admin/pay-components/[code]',
      path: '/admin/pay-components/' + evaluation.componentCode,
      exactHeading: 'Edit PERF_TRACE_AMOUNT',
      witness: 'form:has(input[name="code"][readonly][value="PERF_TRACE_AMOUNT"]) input[name="name"][value="Fictional trace amount"]',
    },
    ...[group, company].map(actor => ({
      actor, template: '/admin/payroll-cycle/[companyId]/[cycleId]',
      path: '/admin/payroll-cycle/' + evaluation.companyId + '/' + evaluation.cycleId,
      exactHeading: 'Fictional trace cycle',
      witness: 'form:has(input[name="name"][value="Fictional trace cycle"]) input[name="code"][value="PERF_TRACE"]',
    })),
  ];
}

async function verifyFormulaSample(page, main, source, value, row) {
  const timeout = 15000;
  row.step = 'formula-source';
  assert.equal(await main.locator('[data-formula-source-panel] textarea').inputValue({ timeout }), source);
  row.step = 'formula-page-hydration';
  await page.locator('button[data-tour="account"]:enabled').waitFor({ state: 'visible', timeout });
  row.step = 'formula-sample-tab';
  await main.getByRole('tab', { name: 'Sample values', exact: true }).click({ timeout });
  const sample = main.locator('#formula-test-sample');
  await sample.waitFor({ state: 'visible', timeout });
  row.step = 'formula-sample-input';
  await sample.getByRole('textbox', { name: 'Input (for example hours or days)', exact: true })
    .fill(value, { timeout });
  row.step = 'formula-sample-response';
  const started = performance.now();
  const action = page.waitForResponse(result =>
    result.request().method() === 'POST' && Boolean(result.request().headers()['next-action']),
  { timeout }).catch(() => null);
  await sample.getByRole('button', { name: 'Run test', exact: true }).click({ timeout });
  const result = await action;
  assert.equal(result?.status(), 200, 'Expected the native formula sample Server Action');
  row.step = 'formula-sample-result';
  const outcome = sample.getByRole('status');
  await outcome.getByText('Test passed', { exact: true }).waitFor({ state: 'visible', timeout });
  await outcome.getByText(/^25(?:\.0+)?$/).waitFor({ state: 'visible', timeout });
  row.sampleCalculationMs = Math.round(performance.now() - started);
}

function importHistoryRoutes(fixture) {
  const [group, company] = fixture.users;
  const { companyId, employeeCode, employeeName, personnel, payroll, taxBasis, fixed, individual } = fixture.importHistory;
  assert.equal(group.role, 'groupHR');
  assert.equal(company.role, 'companyHR');
  assert.equal(group.companyId, companyId);
  assert.equal(company.companyId, companyId);
  for (const id of [personnel.attemptId, personnel.runId, payroll.attemptId, payroll.recordId, taxBasis.id, fixed.groupHR.id, fixed.companyHR.id]) {
    assert.match(id, /^[0-9a-f-]{36}$/i);
  }
  const personnelBase = '/admin/personnel/import/history';
  const payrollBase = '/payroll/history-import';
  const personnelRun = `${personnelBase}/runs/${personnel.runId}`;
  const payrollLog = `${payrollBase}/logs/${payroll.attemptId}`;
  const fixedBase = '/payroll/transactions/fixed/imports';
  const individualBase = '/payroll/transactions/individual/imports';
  const fixedRead = actor => {
    const job = fixed[actor.role];
    const path = fixedBase + '/' + job.id;
    return { actor, template: fixedBase + '/[id]', path,
      exactHeading: 'Batch ' + job.id.slice(0, 8).toUpperCase(), content: job.file,
      witness: `tbody tr:has(td:text-is("${job.missingEmployee}")) td:has-text("does not exist")`,
      download: { href: path + '/errors', filename: 'fixed-transaction-import-errors.xlsx' } };
  };
  return [group, company].flatMap(actor => [
    { actor, template: personnelBase + '/[attemptId]', path: personnelBase + '/' + personnel.attemptId,
      exactHeading: personnel.file, witness: `tbody td:has-text("${employeeName}")` },
    { actor, template: personnelBase + '/runs/[runId]', path: personnelRun,
      exactHeading: personnel.file, witness: `div:has(dl dd:text-is("1")) a[href="${personnelBase}/${personnel.runId}/error-log"]` },
    { actor, template: payrollBase + '/logs/[attemptId]', path: payrollLog,
      exactHeading: payroll.file, witness: `a[href="${payrollLog}/report"]` },
    { actor, template: payrollBase + '/records/[recordId]', path: payrollBase + '/records/' + payroll.recordId,
      exactHeading: `${employeeCode} · ${employeeName}`, witness: `a[href="${payrollLog}"]:text-is("${payroll.file}")` },
    { actor, template: '/payroll/income-tax-recalculation/[id]', path: '/payroll/income-tax-recalculation/' + taxBasis.id,
      exactHeading: 'Recalculation ' + taxBasis.reference, content: employeeName, witness: 'dd[role="status"]:text-is("Completed")' },
    fixedRead(actor),
    ...individualImportRoutes(actor, individual[actor.role], individualBase),
  ]);
}

function individualImportRoutes(actor, job, base) {
  assert.match(job.id, /^[0-9a-f-]{36}$/i);
  assert.match(job.attemptId, /^[0-9a-f-]{36}$/i);
  const batch = base + '/batches/' + job.id;
  const attempt = base + '/' + job.attemptId;
  return [
    { actor, template: base + '/batches/[jobId]', path: batch, exactHeading: job.file,
      witness: `a[href="${attempt}"]`,
      download: { href: batch + '/workbook', filename: 'original-workbook.xlsx', hash: job.hash } },
    { actor, template: base + '/[attemptId]', path: attempt, exactHeading: 'View Details',
      content: job.file, witness: `a[href="${attempt}/errors"]` },
  ];
}

async function verifyRecordDownload(page, main, expected, row) {
  row.step = expected.step ?? (expected.hash ? 'import-original-download' : 'import-error-download');
  const timeout = 15000;
  const started = performance.now();
  const pending = page.waitForEvent('download', { timeout }).catch(() => null);
  await main.locator(`a[href="${expected.href}"]`).click({ timeout });
  const download = await pending;
  assert.equal(download?.suggestedFilename(), expected.filename);
  const response = await download.createReadStream();
  assert(response, 'Expected a record download');
  const chunks = [];
  for await (const chunk of response) chunks.push(chunk);
  const contents = Buffer.concat(chunks);
  if (expected.text) assert(contents.toString('utf8').includes(expected.text), 'Exported text is missing the expected record');
  else assert.equal(contents.subarray(0, 4).toString('hex'), '504b0304');
  if (expected.hash) assert.equal(createHash('sha256').update(contents).digest('hex'), expected.hash);
  row[expected.measurement ?? (expected.hash ? 'originalWorkbookMs' : 'errorWorkbookMs')] = Math.round(performance.now() - started);
}

async function verifyPersonnelTabs(page, main, row, remaining) {
  await page.waitForLoadState('domcontentloaded', { timeout: remaining() });
  const navigation = await page.evaluate(() => {
    const [entry] = performance.getEntriesByType('navigation');
    return entry ? { encodedBytes: entry.encodedBodySize, decodedBytes: entry.decodedBodySize } : null;
  });
  assert(navigation?.decodedBytes > 0, 'The Personnel document payload was not measured');
  const tabs = [
    ['family', '#section-family'],
    ['attendance', '#section-clocking-location'],
    ['payroll', '#section-compensation'],
    ['profile', '#section-personal-details'],
  ];
  row.personnelTabs = { document: navigation, initiallyHiddenPanels: [], switches: [] };
  for (const [tab, witness] of tabs.slice(0, -1)) {
    const hiddenPanel = main.locator(`[data-tabpanel="${tab}"][hidden]`).locator(witness);
    if (await hiddenPanel.count()) row.personnelTabs.initiallyHiddenPanels.push(tab);
  }
  for (const [tab, witness] of tabs) {
    row.step = 'personnel-tab-' + tab;
    const button = main.locator(`[role="tab"][aria-controls$="-panel-${tab}"]`);
    const panel = main.locator(`[data-tabpanel="${tab}"]`).locator(witness);
    const started = performance.now();
    await button.click({ timeout: remaining() });
    await panel.waitFor({ state: 'visible', timeout: remaining() });
    assert.equal(await button.getAttribute('aria-selected', { timeout: remaining() }), 'true');
    assert.equal(new URL(page.url()).searchParams.get('tab'), tab);
    row.personnelTabs.switches.push({ tab, elapsedMs: Math.round(performance.now() - started) });
  }
}

async function verifyPersonnelContactSave(page, db, entry, report, save) {
  const { actor, subject } = entry;
  assert.equal(subject.tenantId, actor.tenantId);
  assert.equal(subject.companyId, actor.companyId);
  const readContact = async () => {
    const [row] = await db`select p.home_phone from employment e
      join person p on p.id=e.person_id and p.tenant_id=e.tenant_id
      where e.id=${subject.employmentId}::uuid and e.tenant_id=${actor.tenantId}::uuid
        and e.company_id=${actor.companyId}::uuid and e.voided_at is null and e.terminated_on is null`;
    assert(row, 'Expected the scoped fictional Personnel record');
    return row.home_phone;
  };
  const original = await readContact();
  const marker = '03-9000' + String(actor.index).padStart(4, '0');
  assert.notEqual(original, marker);
  const result = { role: actor.role, steps: [], outcome: 'failed' };
  (report.personnelProfileActions ??= []).push(result);
  const profile = page.locator('main [data-tab-save-scope="profile"]:visible');
  const phoneSelector = 'form[data-save-section="contact"] input#perm-home-phone[name="homePhone"]';
  const phone = profile.locator(phoneSelector);
  const button = profile.getByRole('button', { name: 'Save Changes', exact: true });
  const dirty = profile.locator('[data-tab-save-count]');
  const timeout = 15000;

  async function submit(name, value) {
    const started = performance.now();
    const elapsed = () => Math.round(performance.now() - started);
    await phone.fill(value ?? '', { timeout });
    await dirty.waitFor({ state: 'visible', timeout });
    const timings = { dirtyVisibleMs: elapsed() };
    const pathname = new URL(page.url()).pathname;
    let actionRequest;
    const requested = request => {
      if (actionRequest || request.method() !== 'POST' || !request.headers()['next-action'] ||
          new URL(request.url()).pathname !== pathname) return;
      actionRequest = request;
      timings.actionRequestMs = elapsed();
    };
    const responded = response => {
      if (actionRequest && response.request() === actionRequest) timings.actionHeadersMs = elapsed();
    };
    const completed = request => {
      if (actionRequest && request === actionRequest) timings.actionBodyMs = elapsed();
    };
    page.on('request', requested);
    page.on('response', responded);
    page.on('requestfinished', completed);
    try {
      await button.click({ timeout });
      timings.clickReturnedMs = elapsed();
      await dirty.waitFor({ state: 'hidden', timeout });
      timings.dirtyClearedMs = elapsed();
      assert.equal(await profile.getByRole('alert').count(), 0, 'Personnel Save showed an error');
      assert.equal(await readContact(), value, 'Personnel Save did not persist through its owner');
      result.steps.push({ name, persistedMs: elapsed(), timings });
      save();
    } finally {
      page.off('request', requested);
      page.off('response', responded);
      page.off('requestfinished', completed);
    }
  }

  try {
    await page.waitForLoadState('load', { timeout });
    assert.equal(await phone.inputValue({ timeout }), original ?? '');
    try {
      await submit('save', marker);
    } finally {
      if ((await readContact()) === marker) await submit('restore', original);
    }
    assert.equal(await readContact(), original);
    assert.deepEqual(result.steps.map(step => step.name), ['save', 'restore']);
    const discardStarted = performance.now();
    await phone.fill(marker, { timeout });
    await dirty.waitFor({ state: 'visible', timeout });
    await profile.getByRole('button', { name: 'Discard Changes', exact: true }).click({ timeout });
    await page.waitForFunction(({ selector, value }) => document.querySelector(selector)?.value === value,
      { selector: phoneSelector, value: original ?? '' }, { timeout });
    await dirty.waitFor({ state: 'hidden', timeout });
    assert.equal(await readContact(), original, 'Discard must leave the last persisted value intact');
    result.discardMs = Math.round(performance.now() - discardStarted);
    result.outcome = 'passed';
  } finally {
    save();
  }
}

export async function measureFixtureRecordCensus({ db, fixture, origin, compiledPages, signedInContext, report, save, payrollCorrections, personnelMovement, payrollFormulaEvaluation, importHistory, attendanceRecords, performanceReportRecords, jobDescriptionRecords, noticeRecords, attendanceConfigurationRecords }) {
  const before = payrollCorrections ? await payrollCorrectionState(db, fixture) : null;
  const cases = personnelMovement ? await personnelMovementRoutes(db, fixture)
    : payrollFormulaEvaluation ? payrollFormulaEvaluationRoutes(fixture)
    : importHistory ? importHistoryRoutes(fixture)
    : attendanceRecords ? await attendanceRecordRoutes(db, fixture)
    : performanceReportRecords ? await performanceReportRecordRoutes(db, fixture)
    : jobDescriptionRecords ? await jobDescriptionRecordRoutes(db, fixture)
    : noticeRecords ? await noticeRecordRoutes(db, fixture)
    : attendanceConfigurationRecords ? await attendanceConfigurationRoutes(db, fixture)
    : payrollCorrections ? await payrollCorrectionRoutes(db, fixture)
    : [
      ...await fixtureRoutes(db, fixture), ...await workLocationRoutes(db, fixture),
      ...await fixedTransactionRoutes(db, fixture),
      ...await organisationLifecycleRoutes(db, fixture),
      ...(fixture.performanceRecordsUnavailable ? [] : await performanceRoutes(db, fixture)),
    ];
  assert(cases.every(row => compiledPages.has(row.template)), 'A planned record route is absent from the measured build');
  report.fixtureRecordCensus = { plannedTemplates: new Set(cases.map(row => row.template)).size, plannedJourneys: cases.length, observations: [],
    ...(fixture.performanceRecordsUnavailable && { missingFixture: 'Performance assessment cycle' }) };
  const rows = report.fixtureRecordCensus.observations;
  save();
  for (const entry of cases) {
    const context = await signedInContext(entry.actor);
    try {
      const page = await context.newPage();
      if (entry.print) {
        await page.addInitScript(() => {
          window.print = () => document.documentElement.setAttribute('data-fixture-printed', 'true');
        });
      }
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
          if (entry.formulaSample && pass === 'first') {
            row.formulaPageReadyMs = Math.round(performance.now() - started);
            await verifyFormulaSample(page, main, entry.formulaSample.source, entry.formulaSample.value, row);
          }
          if (entry.download && pass === 'first') {
            row[entry.download.measurement ? 'reportPageReadyMs' : 'importPageReadyMs'] = Math.round(performance.now() - started);
            await verifyRecordDownload(page, main, entry.download, row);
          }
          if (entry.print && pass === 'first') {
            row.step = 'job-description-print';
            const printStarted = performance.now();
            await main.getByRole('button', { name: 'Print / Save as PDF', exact: true }).click({ timeout: remaining() });
            await page.locator('html[data-fixture-printed="true"]').waitFor({ state: 'attached', timeout: remaining() });
            row.printMs = Math.round(performance.now() - printStarted);
          }
          if (entry.acknowledgeNotice) {
            row.noticePageReadyMs = Math.round(performance.now()-started);
            row.step = 'notice-acknowledgement';
            await verifyNoticeAcknowledgement(page,main,db,entry,row,pass,remaining());
          }
          if (entry.personnelTabs && pass === 'first') {
            row.personnelPageReadyMs = Math.round(performance.now() - started);
            row.step = 'personnel-document-payload';
            await verifyPersonnelTabs(page, main, row, remaining);
          }
          row.outcome = 'usable-content';
        } catch (error) {
          row.outcome = error.name === 'TimeoutError' ? 'timeout' : error.code === 'ERR_ASSERTION' ? 'assertion' : 'browser-failure';
        } finally {
          row.elapsedMs = Math.round(performance.now() - started);
          save();
        }
      }
      if (entry.personnelTabs && rows.at(-1).outcome === 'usable-content') {
        await verifyPersonnelContactSave(page, db, entry, report, save);
      }
      if (entry.workflowPreviewLineage && rows.at(-1).outcome === 'usable-content') {
        await verifyAttendanceWorkflowPreview(page, db, entry, report, save);
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
