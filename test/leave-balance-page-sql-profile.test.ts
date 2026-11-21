import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { inquiryBalancePage } from '../app/leave/employee-balances/inquiry-data';
import { leaveInquirySnapshot } from '../core/leave-inquiry';
import { client } from '../db/client';
import * as schema from '../db/schema';
import { parseInquiryQuery } from '../lib/leave-inquiry-query';
import { adminCtx, closeAll, migrateTestDb, owner, resetDb, seedBase } from './harness';

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
}, 90000);
