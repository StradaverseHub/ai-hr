import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { inquiryBalancePage } from '../app/leave/employee-balances/inquiry-data';
import { leaveInquiryBalancePairsTx, leaveInquirySnapshot } from '../core/leave-inquiry';
import { client, type Tx } from '../db/client';
import * as schema from '../db/schema';
import { parseInquiryQuery } from '../lib/leave-inquiry-query';
import { adminCtx, closeAll, migrateTestDb, owner, resetDb, seedBase } from './harness';

type Fact = { employmentId: string; typeId: string; kind: string; days: string; accrued: string | null };

async function readDatedFacts(tx: Tx, ids: readonly string[], asOf: string): Promise<Fact[]> {
  // This probe only receives IDs returned by the authorized inquiry within this snapshot.
  // Existing Leave code still owns the financial calculation and presentation.
  const requested = sql.join(ids.map(id => sql`${id}::uuid`), sql`, `);
  return Array.from(await tx.execute<Fact>(sql`
    with ledger as materialized (
      select employment_id, leave_type_id, entry_type, days, source_request_id
      from leave_ledger where employment_id in (${requested}) and effective_on <= ${asOf}::date
    ), requests as materialized (
      select employment_id, leave_type_id, status, days, unpaid_days from leave_request
      where employment_id in (${requested}) and start_date <= ${asOf}::date
        and status in ('pending', 'approved')
    ), facts as (
      select l.employment_id, l.leave_type_id, 'balance' as kind, coalesce(sum(l.days),0) as days,
        coalesce(sum(l.days) filter (where l.entry_type in ('accrual','in_lieu_accrual')),0) as accrued
      from ledger l join leave_type t on t.id=l.leave_type_id group by l.employment_id,l.leave_type_id
      union all
      select l.employment_id,coalesce(r.leave_type_id,l.leave_type_id),'filed',
        coalesce(-sum(l.days) filter (where l.entry_type='debit'),0),null
      from ledger l left join leave_request r on r.id=l.source_request_id
      group by l.employment_id,coalesce(r.leave_type_id,l.leave_type_id)
      union all
      select r.employment_id,r.leave_type_id,'pending',coalesce(sum(r.days),0),null
      from requests r join leave_type t on t.id=r.leave_type_id
      where r.status='pending' group by r.employment_id,r.leave_type_id
      union all
      select r.employment_id,r.leave_type_id,'unpaid',coalesce(sum(r.unpaid_days),0),null
      from requests r where r.status='approved' group by r.employment_id,r.leave_type_id
    )
    select employment_id as "employmentId",leave_type_id as "typeId",kind,
      days::text,accrued::text from facts
    order by "employmentId","typeId",kind
  `));
}

beforeAll(migrateTestDb);
afterAll(closeAll);

it('profiles the canonical dated balance page by displayed employee count', async () => {
  await resetDb();
  const base = await seedBase();
  const ctx = adminCtx(base);
  const extraCompanies = await owner.db.insert(schema.company).values(
    Array.from({ length: 69 }, (_, index) => ({
      tenantId: base.tenantId,
      legalName: 'Fictional Balance Company ' + index,
      parentCompanyId: base.companyId,
    })),
  ).returning({ id: schema.company.id });
  const companyIds = [base.companyId, ...extraCompanies.map(company => company.id)];
  const people = Array.from({ length: 1000 }, (_, index) => ({
    id: randomUUID(),
    tenantId: base.tenantId,
    fullName: 'Fictional balance subject ' + index,
    primaryEmail: 'fictional-leave-balance-' + index + '@example.invalid',
  }));
  await owner.db.insert(schema.person).values(people);
  const employments = people.map((person, index) => ({
    id: randomUUID(),
    tenantId: base.tenantId,
    companyId: index < 200 ? base.companyId : extraCompanies[(index - 200) % extraCompanies.length].id,
    personId: person.id,
    hiredOn: '2024-01-01',
    employeeCode: 'BAL-' + String(index).padStart(4, '0'),
  }));
  await owner.db.insert(schema.employment).values(employments);
  await owner.db.insert(schema.leaveLedger).values(employments.flatMap(employment => [
    {
      tenantId: base.tenantId, employmentId: employment.id, leaveTypeId: base.annualLeaveTypeId,
      entryType: 'accrual' as const, days: '9.00', effectiveOn: '2025-06-01',
    },
    {
      tenantId: base.tenantId, employmentId: employment.id, leaveTypeId: base.annualLeaveTypeId,
      entryType: 'debit' as const, days: '-2.00', effectiveOn: '2025-07-01',
    },
    {
      tenantId: base.tenantId, employmentId: employment.id, leaveTypeId: base.annualLeaveTypeId,
      entryType: 'accrual' as const, days: '5.00', effectiveOn: '2025-07-02',
    },
  ]));
  const cases = [
    { scope: 'group', ids: companyIds, size: '25', expectedRows: 25, total: 1000 },
    { scope: 'group', ids: companyIds, size: '50', expectedRows: 50, total: 1000 },
    { scope: 'group', ids: companyIds, size: '100', expectedRows: 100, total: 1000 },
    { scope: 'selected-company', ids: [base.companyId], size: '50', expectedRows: 50, total: 200 },
    { scope: 'selected-employee', ids: companyIds, size: '50', expectedRows: 1, total: 1 },
  ];
  const samples = [];
  for (const profile of cases) {
    const input = parseInquiryQuery({
      type: base.annualLeaveTypeId,
      asOf: '2025-07-01',
      size: profile.size,
      emp: profile.scope === 'selected-employee' ? employments[0].id : undefined,
    }, 'balances');
    const oldDebug = client.options.debug;
    let statements = 0, ledgerReads = 0, singleEmploymentLedgerReads = 0;
    client.options.debug = (_connection: number, statement: string) => {
      statements++;
      if (/\bfrom\s+"leave_ledger"/i.test(statement)) {
        ledgerReads++;
        if (/"leave_ledger"\."employment_id"\s*=\s*\$\d+/i.test(statement)) {
          singleEmploymentLedgerReads++;
        }
      }
    };
    const started = performance.now();
    try {
      const page = await leaveInquirySnapshot(ctx, profile.ids, input, (tx, scope) =>
        inquiryBalancePage(ctx, scope, input, 'en', input.pq, tx));
      const elapsedMs = Math.round(performance.now() - started);
      expect(page.total).toBe(profile.total);
      expect(page.rows).toHaveLength(profile.expectedRows);
      expect(page.rows.map(row => row.employee.employmentId)).toEqual(
        employments.slice(0, profile.expectedRows).map(employment => employment.id));
      expect(page.rows.every(row => row.balance === 7 && row.taken === 2)).toBe(true);
      expect(statements).toBeGreaterThan(0);
      samples.push({
        scope: profile.scope, visibleEmployees: page.rows.length, total: page.total,
        statements, ledgerReads, singleEmploymentLedgerReads, elapsedMs,
      });
    } finally {
      client.options.debug = oldDebug;
    }
  }
  console.info('LEAVE_BALANCE_SQL_PROFILE ' + JSON.stringify(samples));

  const [filedType] = await owner.db.insert(schema.leaveType).values({
    tenantId: base.tenantId, code: 'FILED', name: 'Fictional filed type',
  }).returning({ id: schema.leaveType.id });
  const employmentId = employments[0].id;
  const request = { tenantId: base.tenantId, employmentId, leaveTypeId: filedType.id };
  const [approved] = await owner.db.insert(schema.leaveRequest).values([
    { ...request, startDate: '2025-07-01', endDate: '2025-07-01', days: '2.00', status: 'approved', unpaidDays: '0.50' },
    { ...request, startDate: '2025-07-01', endDate: '2025-07-01', days: '1.25', status: 'pending' },
    { ...request, startDate: '2025-07-02', endDate: '2025-07-02', days: '4.00', status: 'pending' },
  ]).returning({ id: schema.leaveRequest.id });
  await owner.db.insert(schema.leaveLedger).values({
    tenantId: base.tenantId, employmentId, leaveTypeId: base.annualLeaveTypeId,
    entryType: 'debit', days: '-1.50', effectiveOn: '2025-07-01', sourceRequestId: approved.id,
  });

  const comparisons = [];
  for (const profile of [cases[2], cases[3]]) {
    const input = parseInquiryQuery({ type: base.annualLeaveTypeId, asOf: '2025-07-01', size: profile.size }, 'balances');
    await leaveInquirySnapshot(ctx, profile.ids, input, async (tx, scope) => {
      const page = await leaveInquiryBalancePairsTx(tx, ctx, scope, input, 'en');
      const ids = [...new Set(page.rows.map(row => row.employee.employmentId))].sort();
      expect(ids).toHaveLength(profile.expectedRows);

      const single = async () => {
        const rows: Fact[] = [];
        for (const id of ids) rows.push(...await readDatedFacts(tx, [id], input.asOf));
        return rows;
      };
      const batch = () => readDatedFacts(tx, ids, input.asOf);
      const timings = { single: [] as number[], batch: [] as number[] };
      for (let sample = 0; sample < 6; sample++) {
        let staged: Fact[] | undefined, grouped: Fact[] | undefined;
        for (const mode of sample % 2 ? ['batch', 'single'] as const : ['single', 'batch'] as const) {
          const started = performance.now();
          if (mode === 'batch') grouped = await batch();
          else staged = await single();
          timings[mode].push(performance.now() - started);
        }
        expect(grouped).toEqual(staged);
        expect(grouped?.filter(row => row.employmentId === employmentId)).toEqual(
          expect.arrayContaining([
            { employmentId, typeId: base.annualLeaveTypeId, kind: 'balance', days: '5.50', accrued: '9.00' },
            { employmentId, typeId: base.annualLeaveTypeId, kind: 'filed', days: '2.00', accrued: null },
            { employmentId, typeId: filedType.id, kind: 'filed', days: '1.50', accrued: null },
            { employmentId, typeId: filedType.id, kind: 'pending', days: '1.25', accrued: null },
            { employmentId, typeId: filedType.id, kind: 'unpaid', days: '0.50', accrued: null },
          ]),
        );
      }
      const median = (values: number[]) => {
        const ordered = [...values].sort((a, b) => a - b);
        return Math.round((ordered[2] + ordered[3]) / 2 * 100) / 100;
      };
      comparisons.push({
        scope: profile.scope, employees: ids.length, pairedSamples: timings.single.length,
        singleStatements: ids.length, batchStatements: 1,
        singleMedianMs: median(timings.single), batchMedianMs: median(timings.batch),
      });
    });
  }
  console.info('LEAVE_BALANCE_FACT_BATCH ' + JSON.stringify(comparisons));
}, 90000);
