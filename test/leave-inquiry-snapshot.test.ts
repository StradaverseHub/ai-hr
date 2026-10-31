import { randomUUID } from 'node:crypto';
import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import * as s from '../db/schema';
import { hireEmployee } from '../core/org';
import { collectInquiryExport, leaveInquirySnapshot, leaveInquiryContext, leaveInquiryBalancePairs, leaveInquiryRecordsPage, leaveInquiryRecordsPageTx } from '../core/leave-inquiry';
import { inquiryBalancePage } from '../app/(app)/leave/employee-balances/inquiry-data';
import { parseInquiryQuery } from '../lib/leave-inquiry-query';
import { todayInKualaLumpur } from '../lib/hr-date';
import { adminCtx, closeAll, migrateTestDb, owner, resetDb, seedBase, type Base } from './harness';
let b: Base, workers: { employmentId: string; personId: string }[], typeId: string;
const today = todayInKualaLumpur();
const query = (params = {}, kind: 'balances' | 'records' = 'balances') => parseInquiryQuery({ asOf: today, ...params }, kind);
beforeAll(migrateTestDb);
afterAll(closeAll);
beforeEach(async () => {
  await resetDb(); b = await seedBase(); const ctx = adminCtx(b); workers = [];
  for (const [code, name] of [['E-Z', 'Alpha employee'], ['E-A', 'Zulu employee']]) workers.push(await hireEmployee(ctx, { person: { fullName: name, primaryEmail: `${randomUUID()}@snapshot.test` }, employeeCode: code, companyId: b.companyId, departmentId: b.deptA, employmentType: 'full_time', hiredOn: `${Number(today.slice(0, 4)) - 1}-01-01` }));
  const [type] = await owner.db.insert(s.leaveType).values({ tenantId: b.tenantId, code: 'ZZZ', name: 'Second sorted type' }).returning(); typeId = type.id;
  await owner.db.insert(s.leaveLedger).values({ tenantId: b.tenantId, employmentId: workers[0].employmentId, leaveTypeId: b.annualLeaveTypeId, entryType: 'accrual', days: '5', effectiveOn: `${today.slice(0, 4)}-01-01` });
});

describe('23e87eef: global Leave Code ordering before paging', () => {
  it.each(['asc', 'desc'] as const)('sorts the whole filtered set by Leave Code %s, with stable employee ties across page boundaries', async dir => {
    const ctx = adminCtx(b), q = query({ sort: 'type', dir, type: [b.annualLeaveTypeId, typeId] }), scope = await leaveInquiryContext(ctx, [b.companyId], q);
    const all = await leaveInquiryBalancePairs(ctx, scope, q, 'en', { limit: 20, offset: 0 });
    expect(all.total).toBe(4);
    expect(all.rows.map(r => r.code)).toEqual(dir === 'asc' ? ['ANNUAL', 'ANNUAL', 'ZZZ', 'ZZZ'] : ['ZZZ', 'ZZZ', 'ANNUAL', 'ANNUAL']);
    expect(all.rows.map(r => r.employee.employeeCode)).toEqual(['E-A', 'E-Z', 'E-A', 'E-Z']);
    const pages = [];
    for (let offset = 0; offset < 4; offset++) pages.push(...(await leaveInquiryBalancePairs(ctx, scope, q, 'en', { limit: 1, offset })).rows);
    expect(pages).toEqual(all.rows);
    expect(new Set(pages.map(r => `${r.employee.employmentId}|${r.leaveTypeId}`)).size).toBe(4);
  });
  it('threads the Department filter through the records count and rows', async () => {
    const ctx = adminCtx(b);
    await owner.db.insert(s.leaveRequest).values({ tenantId: b.tenantId, employmentId: workers[0].employmentId, leaveTypeId: b.annualLeaveTypeId, startDate: today, endDate: today, days: '1', status: 'pending' });
    const q = query({ department: b.deptB }, 'records'), scope = await leaveInquiryContext(ctx, [b.companyId], q);
    expect(await leaveInquiryRecordsPage(ctx, scope, q)).toEqual({ rows: [], total: 0 });
    expect((await leaveInquiryRecordsPage(ctx, scope, query({ department: b.deptA }, 'records'))).total).toBe(1);
  });
});

describe('23e87eef: one explicit authorized export snapshot', () => {
  it('retains all 400 original filtered IDs across OFFSET pages when an insertion and status change keep the total unchanged', async () => {
    const ctx = adminCtx(b), stamp = Date.parse(`${today}T00:00:00Z`), q = query({ status: 'pending', type: b.annualLeaveTypeId, sort: 'applied', dir: 'desc' }, 'records');
    const original = await owner.db.insert(s.leaveRequest).values(Array.from({ length: 400 }, (_, i) => ({ tenantId: b.tenantId, employmentId: workers[0].employmentId, leaveTypeId: b.annualLeaveTypeId, startDate: today, endDate: today, days: '1', status: 'pending' as const, createdAt: new Date(stamp + i * 1000) }))).returning({ id: s.leaveRequest.id, createdAt: s.leaveRequest.createdAt });
    const oldest = [...original].sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())[0];
    let inserted = '';
    const exported = await leaveInquirySnapshot(ctx, [b.companyId], q, async (tx, scope) => {
      const [state] = await tx.execute(sql`select current_setting('transaction_isolation') as isolation,current_setting('transaction_read_only') as readonly`) as unknown as { isolation: string; readonly: string }[];
      expect(state).toEqual({ isolation: 'repeatable read', readonly: 'on' });
      return collectInquiryExport(async window => {
        const page = await leaveInquiryRecordsPageTx(tx, ctx, scope, q, window);
        if (window.offset === 0) {
          expect(page.total).toBe(400); expect(page.rows).toHaveLength(200);
          const [added] = await owner.db.insert(s.leaveRequest).values({ tenantId: b.tenantId, employmentId: workers[0].employmentId, leaveTypeId: b.annualLeaveTypeId, startDate: today, endDate: today, days: '1', status: 'pending', createdAt: new Date(stamp + 500_000) }).returning({ id: s.leaveRequest.id }); inserted = added.id;
          await owner.db.update(s.leaveRequest).set({ status: 'approved' }).where(eq(s.leaveRequest.id, oldest.id));
        }
        return page;
      });
    });
    expect(exported).toHaveLength(400); expect(new Set(exported.map(r => r.id)).size).toBe(400);
    expect(new Set(exported.map(r => r.id))).toEqual(new Set(original.map(r => r.id))); expect(exported.some(r => r.id === inserted)).toBe(false);
    const freshScope = await leaveInquiryContext(ctx, [b.companyId], q), fresh = await leaveInquiryRecordsPage(ctx, freshScope, q, { limit: 500, offset: 0 });
    expect(fresh.total).toBe(400); expect(fresh.rows.some(r => r.id === inserted)).toBe(true); expect(fresh.rows.some(r => r.id === oldest.id)).toBe(false);
  });
  it('keeps authorized membership, type labels and canonical balance hydration in the same source snapshot', async () => {
    const ctx = adminCtx(b), q = query({ sort: 'type', type: [b.annualLeaveTypeId, typeId] });
    const result = await leaveInquirySnapshot(ctx, [b.companyId], q, async (tx, scope) => {
      const before = await inquiryBalancePage(ctx, scope, q, 'en', { limit: 200, offset: 0 }, tx);
      await owner.db.update(s.leaveType).set({ code: 'AAA', name: 'Changed concurrently' }).where(eq(s.leaveType.id, typeId));
      await owner.db.insert(s.leaveLedger).values({ tenantId: b.tenantId, employmentId: workers[0].employmentId, leaveTypeId: b.annualLeaveTypeId, entryType: 'adjustment', days: '3', effectiveOn: today });
      const after = await inquiryBalancePage(ctx, scope, q, 'en', { limit: 200, offset: 0 }, tx);
      return { before, after };
    });
    const facts = (page: typeof result.before) => page.rows.map(r => ({ employee: r.employee.employmentId, type: r.leaveTypeId, code: r.code, name: r.leaveType, available: r.available, balance: r.balance }));
    expect(facts(result.after)).toEqual(facts(result.before)); expect(result.after.rows.map(r => r.code)).toEqual(['ANNUAL', 'ANNUAL', 'ZZZ', 'ZZZ']);
    const scope = await leaveInquiryContext(ctx, [b.companyId], q), fresh = await inquiryBalancePage(ctx, scope, q, 'en', { limit: 200, offset: 0 });
    expect(fresh.rows.map(r => r.code)).toEqual(['AAA', 'AAA', 'ANNUAL', 'ANNUAL']);
    const value = (page: typeof fresh) => page.rows.find(r => r.employee.employmentId === workers[0].employmentId && r.leaveTypeId === b.annualLeaveTypeId)!.available;
    expect(value(fresh)).toBe(value(result.before) + 3);
  });
  it('retains role/company fences and refuses an actual write inside the snapshot', async () => {
    const ctx = adminCtx(b), q = query();
    await expect(leaveInquirySnapshot({ ...ctx, roles: ['employee'] }, [b.companyId], q, async () => [])).rejects.toThrow('Forbidden');
    const other = await seedBase(), foreignCtx = adminCtx(other);
    const rows = await leaveInquirySnapshot(foreignCtx, [b.companyId], q, async (tx, scope) => leaveInquiryRecordsPageTx(tx, foreignCtx, scope, q));
    expect(rows).toEqual({ rows: [], total: 0 });
    await expect(leaveInquirySnapshot(ctx, [b.companyId], q, async (tx, scope) => leaveInquiryRecordsPageTx(tx, { ...ctx }, scope, q))).rejects.toThrow('Forbidden');
    await expect(leaveInquirySnapshot(ctx, [b.companyId], q, tx => tx.update(s.company).set({ legalName: 'Must never persist' }).where(eq(s.company.id, b.companyId)))).rejects.toThrow();
    expect((await owner.db.select().from(s.company).where(eq(s.company.id, b.companyId)))[0].legalName).toBe('Acme Sdn Bhd');
  });
});

// The concurrency checks exercise the owners; this contract pins the routes that must use them.
it('both export routes pass the same explicit snapshot through membership and canonical hydration', async () => {
  const { readFile } = await import('node:fs/promises');
  const balances = await readFile(new URL('../app/(app)/leave/employee-balances/export/route.ts', import.meta.url), 'utf8');
  const records = await readFile(new URL('../app/(app)/leave/employee-records/export/route.ts', import.meta.url), 'utf8');
  const hydration = await readFile(new URL('../app/(app)/leave/employee-balances/inquiry-data.ts', import.meta.url), 'utf8');
  const rows = await readFile(new URL('../app/(app)/leave/employee-balances/rows.ts', import.meta.url), 'utf8');
  for (const route of [balances, records]) {
    expect(route).toContain('leaveInquirySnapshot(session, scopeIds, query, async (tx, inquiry)');
    expect(route).not.toContain('await leaveInquiryContext(');
  }
  expect(balances).toContain('inquiryBalancePage(session, inquiry, query, locale, window, tx)');
  expect(records).toContain('leaveInquiryRecordsPageTx(tx, session, inquiry, query, window)');
  expect(hydration).toContain('leaveInquiryBalancePairsTx(tx, ctx, scope, query, locale, window)');
  expect(hydration).toContain('{ requestedTypeIds, tx }');
  expect(rows).toContain('leaveBalancesTx(opts.tx, ctx, employmentId, locale, balanceOptions)');
  expect(rows).toContain('leaveEntitlementBreakdownTx(opts.tx, employmentId, id, asOf, locale, { derivation: true })');
});
