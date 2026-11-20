import assert from 'node:assert/strict';

const reason = 'Fictional leave-inbox benchmark';
const homeCount = 12;
const groupCount = 120;

export async function seedApprovalsLeaveBrowserFixture(owner, fixture) {
  const [group, company] = fixture.users;
  assert.equal(group.role, 'groupHR');
  assert.equal(company.role, 'companyHR');
  assert.equal(group.tenantId, company.tenantId);
  assert.equal(group.companyId, company.companyId);
  assert.equal(group.leaveTypeId, company.leaveTypeId);

  const result = await owner.begin(async tx => {
    const [inserted] = await tx`
      with home_company as materialized (
        select e.id, (row_number() over(order by e.employee_code, e.id))::int as ordinal
        from employment e
        where e.tenant_id = ${group.tenantId}::uuid and e.company_id = ${company.companyId}::uuid
          and e.id not in (${group.employmentId}::uuid, ${company.employmentId}::uuid)
          and e.terminated_on is null and e.employee_code is not null
        order by e.employee_code, e.id limit ${homeCount}
      ), group_pool as materialized (
        select e.id, e.company_id, e.employee_code,
          row_number() over(partition by e.company_id order by e.employee_code, e.id) as company_ordinal
        from employment e
        where e.tenant_id = ${group.tenantId}::uuid and e.employee_code like 'PERF-SCALE-%'
      ), group_only as materialized (
        select id, (${homeCount} + row_number() over(order by company_ordinal, company_id, employee_code))::int as ordinal
        from group_pool order by company_ordinal, company_id, employee_code limit ${groupCount-homeCount}
      ), requests as (
        insert into leave_request (tenant_id, employment_id, leave_type_id, start_date, end_date, days, reason)
        select ${group.tenantId}::uuid, id, ${group.leaveTypeId}::uuid, ${fixture.today}::date + 1,
          ${fixture.today}::date + 2, 2, ${reason} || ' ' || lpad(ordinal::text, 3, '0')
        from (select * from home_company union all select * from group_only) subjects
        returning id, employment_id, start_date, end_date, reason
      ), dated as (
        insert into leave_request_date (tenant_id, leave_request_id, subject_employment_id, leave_date, days)
        select ${group.tenantId}::uuid, id, employment_id, day, 1
        from requests cross join lateral (values (end_date), (start_date)) as dates(day)
        where right(reason, 1) <> '0'
        returning id
      )
      select (select count(*)::int from requests) as requests,
        (select count(*)::int from home_company) as "companyRequests",
        (select count(*)::int from dated) as dates,
        to_char(${fixture.today}::date + 1, 'YYYY-MM-DD') as "firstDate",
        to_char(${fixture.today}::date + 2, 'YYYY-MM-DD') as "lastDate"
    `;
    assert.equal(inserted.requests, groupCount);
    assert.equal(inserted.companyRequests, homeCount);
    assert.equal(inserted.dates, 216);
    return inserted;
  });
  await owner`analyze public.leave_request, public.leave_request_date`;
  return result;
}

export async function measureApprovalsLeaveBrowser({ origin, signedInContext, fixture, report, save, assertContentAvailable }) {
  const path = '/approvals?category=leave';
  report.approvalsLeave = [];
  for (const actor of fixture.users.slice(0, 2)) {
    const context = await signedInContext(actor);
    try {
      const page = await context.newPage();
      const expected = actor.role === 'groupHR' ? groupCount : homeCount;
      const expectedControls = expected - Math.floor(expected / 10);
      const section = page.locator('main [data-tour="approvals-leave"]');
      const fixtureRows = section.locator('tbody tr').filter({ hasText: reason });
      const perDate = fixtureRows.filter({ hasText: reason + ' 001' });
      const wholeRequest = fixtureRows.filter({ hasText: reason + ' 010' });
      const review = perDate.getByRole('button', { name: 'Review dates', exact: true });
      const modal = page.getByRole('dialog', { name: 'Requested dates', exact: true });
      for (const pass of ['first', 'repeat-1', 'repeat-2']) {
        const row = { role: actor.role, pass, status: 'incomplete', step: 'document' };
        report.approvalsLeave.push(row);
        const started = performance.now();
        try {
          const response = await page.goto(origin + path, { waitUntil: 'commit', timeout: 20000 });
          assert.equal(response?.status(), 200);
          assert.equal(page.url(), origin + path);
          row.responseMs = Math.round(performance.now() - started);
          row.step = 'scoped-rows';
          await fixtureRows.nth(expected - 1).waitFor({ state: 'visible', timeout: 15000 });
          await review.waitFor({ state: 'visible', timeout: 15000 });
          assert.equal(await fixtureRows.count(), expected);
          assert.equal(await fixtureRows.getByRole('button', { name: 'Review dates', exact: true }).count(), expectedControls);
          row.step = 'decision-controls';
          assert.equal(await perDate.getByRole('checkbox').count(), 0);
          assert(await wholeRequest.getByRole('checkbox').isVisible());
          assert(await wholeRequest.getByRole('button', { name: 'Approve', exact: true }).isVisible());
          await assertContentAvailable(page);
          row.inboxReadyMs = Math.round(performance.now() - started);
          row.visibleRequests = expected;
          row.perDateControls = expectedControls;
          const clicked = performance.now();
          row.step = 'open-date-dialog';
          await review.click({ timeout: 15000 });
          await modal.waitFor({ state: 'visible', timeout: 15000 });
          assert.deepEqual(await modal.locator('tbody tr td:first-child').allTextContents(), [
            fixture.approvalsLeave.firstDate, fixture.approvalsLeave.lastDate,
          ]);
          row.dateDialogMs = Math.round(performance.now() - clicked);
          const closing = performance.now();
          row.step = 'close-date-dialog';
          await modal.getByRole('button', { name: 'Close', exact: true }).click({ timeout: 15000 });
          await modal.waitFor({ state: 'hidden', timeout: 15000 });
          row.closeDialogMs = Math.round(performance.now() - closing);
          row.status = 'observed';
          delete row.step;
        } finally {
          save();
        }
      }
    } finally {
      await context.close();
    }
  }
  assert.equal(report.approvalsLeave.length, 6);
}
