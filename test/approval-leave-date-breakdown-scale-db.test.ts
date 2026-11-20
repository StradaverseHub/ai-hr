import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { approvalLeaveDateBreakdowns } from '../core/approval-leave-date-breakdown';
import { leaveRequestDateBreakdown } from '../core/read';
import { adminCtx, closeAll, createAppUser, migrateTestDb, owner, resetDb, seedBase } from './harness';
import { observeNativeRead } from './helpers/native-read-observer';

beforeAll(migrateTestDb);
afterAll(closeAll);

it('reads a full leave inbox in one query and preserves the single-request scope and date order', async () => {
  await resetDb();
  const base = await seedBase();
  const outsider = await seedBase();
  const companies = await owner.client<{ id: string }[]>`
    insert into company (tenant_id, legal_name)
    select ${base.tenantId}::uuid, 'Fictional approval company ' || n
    from generate_series(1, 69) n
    returning id
  `;
  const companyIds = [base.companyId, ...companies.map(company => company.id)];
  await owner.client`
    with fixture as materialized (
      select n, gen_random_uuid() as person_id from generate_series(1, 1000) n
    ), people as (
      insert into person (id, tenant_id, full_name, primary_email)
      select person_id, ${base.tenantId}::uuid, 'Fictional approval employee ' || n, 'leave-approval-' || n || '@example.invalid'
      from fixture
      returning id
    )
    insert into employment (tenant_id, person_id, company_id, hired_on, employee_code)
    select ${base.tenantId}::uuid, people.id, (${companyIds}::uuid[])[1 + ((n - 1) % 70)], '2025-01-01', 'DATE-' || lpad(n::text, 4, '0')
    from fixture join people on people.id = fixture.person_id
  `;
  const subjects = await owner.client<{ id: string; company: string }[]>`
    select id, company_id as company from employment
    where tenant_id = ${base.tenantId}::uuid and employee_code like 'DATE-%'
    order by employee_code
  `;
  expect(subjects).toHaveLength(1000);
  expect(new Set(subjects.map(subject => subject.company)).size).toBe(70);

  const fixture = subjects.slice(0, 200).map((subject, index) => ({
    request: randomUUID(), subject: subject.id, company: subject.company, perDate: index % 5 !== 0,
  }));
  const fixtureJson = JSON.stringify(fixture);
  await owner.client`
    with requests as (
      insert into leave_request (id, tenant_id, employment_id, leave_type_id, start_date, end_date, days)
      select request, ${base.tenantId}::uuid, subject, ${base.annualLeaveTypeId}::uuid, '2026-11-23', '2026-11-24', 2
      from jsonb_to_recordset(${fixtureJson}::jsonb) as input(request uuid, subject uuid)
      returning id, employment_id
    )
    insert into leave_request_date (tenant_id, leave_request_id, subject_employment_id, leave_date, days)
    select ${base.tenantId}::uuid, requests.id, requests.employment_id, day, 1
    from requests
    join jsonb_to_recordset(${fixtureJson}::jsonb) as input(request uuid, "perDate" boolean)
      on input.request = requests.id and input."perDate"
    cross join (values ('2026-11-24'::date), ('2026-11-23'::date)) as dates(day)
  `;
  const scope = companyIds[1];
  const scopedUser = await createAppUser(base.tenantId, null, 'hr_admin');
  await owner.client`update role_assignment set company_id = ${scope}::uuid where app_user_id = ${scopedUser}::uuid`;
  const group = adminCtx(base);
  const company = { ...group, userId: scopedUser, grants: [{ role: 'hr_admin', companyId: scope } as const] };
  const ids = fixture.map(row => row.request).reverse();
  const probe = observeNativeRead({ captureQueries: true });
  try {
    expect(await approvalLeaveDateBreakdowns(group, [])).toEqual(new Map());
    expect(probe.queries).toHaveLength(0);
    const dates = await approvalLeaveDateBreakdowns(group, [...ids, ids[0]]);
    expect(probe.queries).toHaveLength(1);
    expect(probe.properties).toHaveLength(1);
    expect(dates.size).toBe(160);
    expect(probe.queries[0].rows).toBe(320);
    for (const row of fixture) {
      expect(dates.get(row.request)?.map(date => date.leaveDate) ?? []).toEqual(row.perDate ? ['2026-11-23', '2026-11-24'] : []);
    }
  } finally {
    probe.restore();
  }
  const all = await approvalLeaveDateBreakdowns(group, ids);
  const inCompany = fixture.filter(row => row.company === scope);
  const scoped = await approvalLeaveDateBreakdowns(company, ids);
  expect([...scoped.keys()].sort()).toEqual(inCompany.filter(row => row.perDate).map(row => row.request).sort());
  for (const row of inCompany) {
    expect(scoped.get(row.request) ?? []).toEqual(await leaveRequestDateBreakdown(company, row.request));
    expect(all.get(row.request) ?? []).toEqual(await leaveRequestDateBreakdown(group, row.request));
  }
  const outsideCompany = fixture.find(row => row.company !== scope && row.perDate)!;
  expect(scoped.has(outsideCompany.request)).toBe(false);
  expect(await leaveRequestDateBreakdown(company, outsideCompany.request)).toEqual([]);
  expect(await approvalLeaveDateBreakdowns(adminCtx(outsider), ids)).toEqual(new Map());
}, 120000);
