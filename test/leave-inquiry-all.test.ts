import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { beforeAll, afterAll, describe, it, expect } from 'vitest';
import * as schema from '../db/schema';
import type { SessionContext } from '../db/client';
import { hireEmployee } from '../core/org';
import { setLeaveTypeRules, updateLeaveType } from '../core/admin';
import { decideLeave, openLeaveYear, requestLeave } from '../core/leave';
import { todayInKualaLumpur } from '../lib/hr-date';
import { leaveInquiryContext, leaveInquiryBalancePairs, leaveInquiryRecordsPage, collectInquiryExport } from '../core/leave-inquiry';
import { leaveBalances, leaveBalancesTx, leaveEntitlementBreakdown, leaveEntitlementBreakdownTx } from '../core/read';
import { withTenant } from '../db/client';
import { inquiryBalancePage } from '../app/(app)/leave/employee-balances/inquiry-data';
import { employeeBalanceRows } from '../app/(app)/leave/employee-balances/rows';
import { parseInquiryQuery, inquiryDate, inquiryScopeReturnPath } from '../lib/leave-inquiry-query';
import { adminCtx, migrateTestDb, resetDb, seedBase, seedEntitlement, closeAll, owner, type Base } from './harness';
let b: Base, ctx: SessionContext, company2: string, other: string, mine: string, empty: string, poolType: string;
const ids: string[] = [];
const q = (params = {}, kind: 'balances' | 'records' = 'balances') => parseInquiryQuery({ asOf: '2026-10-15', ...params }, kind);
beforeAll(async () => {
  await migrateTestDb(); await resetDb(); b = await seedBase(); ctx = adminCtx(b);
  const [c] = await owner.db.insert(schema.company).values({ tenantId: b.tenantId, legalName: 'Beta Inquiry' }).returning(); company2 = c.id;
  const [dept2] = await owner.db.insert(schema.department).values({ tenantId: b.tenantId, companyId: company2, name: 'Beta operations' }).returning();
  const hire = async (name: string, companyId: string) => (await hireEmployee(ctx, { person: { fullName: name, primaryEmail: `${randomUUID()}@inquiry.local` }, companyId, departmentId: companyId === b.companyId ? b.deptA : dept2.id, employmentType: 'full_time', hiredOn: '2024-01-01' })).employmentId;
  mine = await hire('Inquiry subject', b.companyId); other = await hire('Other company', company2); empty = await hire('No eligible types', b.companyId);
  await owner.db.update(schema.person).set({ gender: 'male' }).where(eq(schema.person.tenantId, b.tenantId));
  await owner.db.update(schema.person).set({ gender: 'female' }).where(eq(schema.person.id, (await owner.db.select().from(schema.employment).where(eq(schema.employment.id, empty)))[0].personId));
  await owner.db.update(schema.leaveType).set({ eligibility: { gender: ['male'] } }).where(eq(schema.leaveType.id, b.annualLeaveTypeId));
  const [pool] = await owner.db.insert(schema.leaveType).values({ tenantId: b.tenantId, code: 'BORROW', name: 'Borrowed leave', balanceSourceTypeId: b.annualLeaveTypeId, eligibility: { gender: ['male'] } }).returning(); poolType = pool.id;
  const people = await owner.db.insert(schema.person).values(Array.from({ length: 103 }, (_, i) => ({ tenantId: b.tenantId, fullName: 'Duplicate name', primaryEmail: `page-${i}@inquiry.local`, gender: 'male' }))).returning();
  const employees = await owner.db.insert(schema.employment).values(people.map((p, i) => ({ tenantId: b.tenantId, personId: p.id, companyId: b.companyId, employeeCode: `INQ-${String(i).padStart(4, '0')}`, hiredOn: '2024-01-01' }))).returning(); ids.push(...employees.map(e => e.id));
  await owner.db.insert(schema.leaveRequest).values(employees.map((e, i) => ({ tenantId: b.tenantId, employmentId: e.id, leaveTypeId: b.annualLeaveTypeId, startDate: '2026-09-01', endDate: '2026-09-01', days: '1', status: i % 2 ? 'cancelled' as const : 'pending' as const, createdAt: new Date('2026-10-14T16:30:00Z') })));
  await owner.db.insert(schema.leaveRequest).values([{ tenantId: b.tenantId, employmentId: other, leaveTypeId: b.annualLeaveTypeId, startDate: '2026-09-01', endDate: '2026-09-01', days: '1', status: 'pending' }, { tenantId: b.tenantId, employmentId: mine, leaveTypeId: poolType, startDate: '2026-09-02', endDate: '2026-09-02', days: '1', status: 'pending' }]);
  await owner.db.insert(schema.leaveLedger).values([{ tenantId: b.tenantId, employmentId: mine, leaveTypeId: b.annualLeaveTypeId, entryType: 'accrual', days: '12', effectiveOn: '2026-01-01' }, { tenantId: b.tenantId, employmentId: mine, leaveTypeId: b.annualLeaveTypeId, entryType: 'debit', days: '-2', effectiveOn: '2026-09-01' }]);
}, 90_000);
afterAll(closeAll);
describe('23e87eef: authorized All/single inquiry', () => {
  it('defaults to All and 50; strict dates, enumerations, offsets and redirects refuse malformed input', () => {
    expect(q().emp).toBeUndefined(); expect(q().pq.limit).toBe(50);
    for (const input of [{ emp: randomUUID() + 'bad' }, { asOf: '2026-02-30' }, { status: 'anything' }, { dir: 'down' }, { size: '500000' }, { page: '9007199254740991' }, { from: '2026-10-15', to: '2026-10-14' }]) expect(() => q(input)).toThrow();
    expect(inquiryDate('2024-02-29')).toBe(true); expect(inquiryDate('2026-02-29')).toBe(false);
    for (const value of ['https://evil.test', '//evil.test', '/leave/employee-balances?emp=x', '/other', null]) expect(inquiryScopeReturnPath(value)).toBeUndefined();
    expect(inquiryScopeReturnPath('/leave/employee-records')).toBe('/leave/employee-records');
  });
  it('rejects employee/manager, cross-company/tenant/unknown selection, forged contexts and changed selection', async () => {
    for (const role of ['employee', 'manager']) await expect(leaveInquiryContext({ ...ctx, roles: [role] }, [b.companyId], q())).rejects.toThrow('Forbidden');
    for (const emp of [other, randomUUID()]) await expect(leaveInquiryContext(ctx, [b.companyId], q({ emp }))).rejects.toThrow();
    const foreign = await seedBase(); await expect(leaveInquiryContext(adminCtx(foreign), [b.companyId], q({ emp: mine }))).rejects.toThrow();
    const scope = await leaveInquiryContext(ctx, [b.companyId], q());
    await expect(leaveInquiryRecordsPage(ctx, { ...scope }, q({}, 'records'))).rejects.toThrow('Forbidden');
    await expect(leaveInquiryBalancePairs(ctx, scope, q({ emp: mine }), 'en')).rejects.toThrow('Forbidden');
  });
  it('mixed HR/employee grants do not turn an own-employment company into an HR inquiry company', async () => {
    const [subject] = await owner.db.select().from(schema.employment).where(eq(schema.employment.id, other));
    const [user] = await owner.db.insert(schema.appUser).values({ tenantId: b.tenantId, personId: subject.personId, workosUserId: `mixed-${randomUUID()}` }).returning();
    const grants = [{ role: 'hr_admin' as const, companyId: b.companyId }, { role: 'employee' as const, companyId: company2 }];
    await owner.db.insert(schema.roleAssignment).values(grants.map(g => ({ tenantId: b.tenantId, appUserId: user.id, ...g })));
    const mixed = { ...ctx, userId: user.id, personId: subject.personId, roles: ['hr_admin', 'employee'], grants };
    const scope = await leaveInquiryContext(mixed, [b.companyId, company2], q()); expect(scope.companyIds).toEqual([b.companyId]);
    await expect(leaveInquiryContext(mixed, [b.companyId, company2], q({ emp: other }))).rejects.toThrow();
    const deptQuery = q({ department: b.deptA, type: b.annualLeaveTypeId });
    expect((await leaveInquiryBalancePairs(mixed, scope, deptQuery, 'en')).total).toBe(1);
  });
  it('empty scope returns no rows; immutable authorized snapshot ignores caller mutations', async () => {
    const scope = await leaveInquiryContext(ctx, [], q()); expect((await leaveInquiryBalancePairs(ctx, scope, q(), 'en')).total).toBe(0);
    expect((await leaveInquiryRecordsPage(ctx, scope, q({}, 'records'))).total).toBe(0);
    const safe = await leaveInquiryContext(ctx, [b.companyId], q({}, 'records')); safe.companyIds.push(company2);
    expect((await leaveInquiryRecordsPage(ctx, safe, q({}, 'records'))).rows.every(r => r.employmentId !== other)).toBe(true);
  });
  it('counts >100 employments in bounded chunks and pages duplicate names without missing or duplicate pairs', async () => {
    const query = q({ type: b.annualLeaveTypeId }); const scope = await leaveInquiryContext(ctx, [b.companyId], query);
    const first = await leaveInquiryBalancePairs(ctx, scope, query, 'en'); expect(first.rows).toHaveLength(50); expect(first.total).toBe(104);
    const all = await collectInquiryExport(window => leaveInquiryBalancePairs(ctx, scope, query, 'en', window)); expect(all).toHaveLength(104);
    expect(new Set(all.map(r => `${r.employee.employmentId}|${r.leaveTypeId}`)).size).toBe(104); expect(all.some(r => r.employee.employmentId === empty)).toBe(false);
    const second = await leaveInquiryBalancePairs(ctx, scope, query, 'en', { limit: 50, offset: 50 }); expect(second.rows).toEqual(all.slice(50, 100));
    const named = q({ sort: 'name', dir: 'desc', type: b.annualLeaveTypeId }); expect((await leaveInquiryBalancePairs(ctx, scope, named, 'en')).rows).toEqual((await leaveInquiryBalancePairs(ctx, scope, named, 'en')).rows);
  });
  it('hydrates selected pairs with the SAME canonical pool, pending and dated figures as individual/My Leave', async () => {
    const query = q({ emp: mine, type: poolType }); const scope = await leaveInquiryContext(ctx, [b.companyId], query);
    const page = await inquiryBalancePage(ctx, scope, query, 'en'); expect(page.rows).toHaveLength(1);
    const individual = (await employeeBalanceRows(ctx, mine, query.asOf, 'en')).find(r => r.leaveTypeId === poolType)!;
    const { employee, ...row } = page.rows[0]; expect(employee.employmentId).toBe(mine); expect(row).toEqual(individual); expect(row.available).toBe(9);
    const own = await employeeBalanceRows(ctx, mine, query.asOf, 'en', {}, { audience: 'self' });
    expect(own.find(r => r.leaveTypeId === b.annualLeaveTypeId)?.available).toBe(9);
    const none = q({ emp: empty }); expect((await inquiryBalancePage(ctx, await leaveInquiryContext(ctx, [b.companyId], none), none, 'en')).rows).toEqual([]);
  });
  it('All, single and My Leave retain real carry alongside approved and pending half-days', async () => {
    // A separate tenant keeps the existing pagination fixture unchanged. Every credit/debit below
    // comes from the configured Leave owners; no synthetic balance or raw ledger/request is inserted.
    const base = await seedBase(), admin = adminCtx(base), asOf = todayInKualaLumpur();
    const year = Number(asOf.slice(0, 4)), previousStart = `${year - 1}-01-01`, currentStart = `${year}-01-01`;
    await updateLeaveType(admin, {
      id: base.annualLeaveTypeId, name: 'Annual Leave', yearCycleOverride: 'c2c',
      durations: ['half_day_am', 'half_day_pm'], backdatingLimitDays: null, minAdvanceDays: null,
    });
    await setLeaveTypeRules(admin, {
      id: base.annualLeaveTypeId, accrualMethod: 'grant_on_hire_prorated',
      carryForwardEnabled: true, carryForwardMax: 12,
      carryForwardExpiryMonth: null, carryForwardExpiryDay: null,
    });
    await seedEntitlement(admin, { leaveTypeId: base.annualLeaveTypeId, annualDays: 12, validFrom: previousStart });
    const subject = await hireEmployee(admin, {
      person: { fullName: 'Carried half-day inquiry', primaryEmail: `${randomUUID()}@inquiry.local` },
      companyId: base.companyId, departmentId: base.deptA, employmentType: 'full_time', hiredOn: previousStart,
      grantLeaveTypes: [{ id: base.annualLeaveTypeId, code: 'ANNUAL' }],
    });
    await openLeaveYear(admin, { year, employmentIds: [subject.employmentId], leaveTypeIds: [base.annualLeaveTypeId] });
    const application = {
      employmentId: subject.employmentId, leaveTypeId: base.annualLeaveTypeId,
      startDate: currentStart, endDate: currentStart, today: asOf,
    };
    const approved = await requestLeave(admin, { ...application, durationType: 'half_day_am' });
    expect(approved.days).toBe(0.5);
    await decideLeave(admin, { leaveRequestId: approved.leaveRequestId, decision: 'approved' });
    const pending = await requestLeave(admin, { ...application, durationType: 'half_day_pm' });
    expect(pending.days).toBe(0.5);

    const allQuery = parseInquiryQuery({ asOf, type: base.annualLeaveTypeId }, 'balances');
    const all = await inquiryBalancePage(admin, await leaveInquiryContext(admin, [base.companyId], allQuery), allQuery, 'en');
    expect(all.total).toBe(1); expect(all.rows).toHaveLength(1);
    const { employee, ...row } = all.rows[0]; expect(employee.employmentId).toBe(subject.employmentId);
    const singleQuery = parseInquiryQuery({ asOf, emp: subject.employmentId, type: base.annualLeaveTypeId }, 'balances');
    const single = await inquiryBalancePage(admin, await leaveInquiryContext(admin, [base.companyId], singleQuery), singleQuery, 'en');
    expect(single.rows).toEqual(all.rows);
    const individual = (await employeeBalanceRows(admin, subject.employmentId, asOf, 'en')).find(r => r.leaveTypeId === base.annualLeaveTypeId);
    const myLeave = (await employeeBalanceRows(admin, subject.employmentId, asOf, 'en', {}, { audience: 'self' })).find(r => r.leaveTypeId === base.annualLeaveTypeId);
    expect(row).toEqual(individual); expect(row).toEqual(myLeave);
    // Literal business expectations distinguish carry from this year's grant, and gross balance
    // from the half-day reservation. Comparing two readers alone would not establish these figures.
    expect(row).toMatchObject({ broughtForward: 12, ytdEntitled: 12, taken: 0.5, pending: 0.5, forfeitedBf: 0, balance: 23.5, available: 23 });
    expect(row.breakdown).toMatchObject({ carriedForward: 12, currentYearEntitlement: 12, takenThisCycle: 0.5, pendingApproval: 0.5, balance: 23.5, totalAvailable: 23 });
    expect(row.breakdown?.transactions.some(transaction => transaction.sourceRequestId === approved.leaveRequestId && transaction.days === -0.5)).toBe(true);
    expect(row.breakdown?.transactions.some(transaction => transaction.sourceRequestId === pending.leaveRequestId)).toBe(false);
  });
  it('record count/page/export share scope, KL applied-day versus leave overlap and stable ties', async () => {
    const query = q({ from: '2026-10-15', to: '2026-10-15', dateMode: 'applied' }, 'records'); const scope = await leaveInquiryContext(ctx, [b.companyId], query);
    const page = await leaveInquiryRecordsPage(ctx, scope, query); expect(page.rows).toHaveLength(50); expect(page.total).toBe(103);
    const all = await collectInquiryExport(window => leaveInquiryRecordsPage(ctx, scope, query, window)); expect(all).toHaveLength(103); expect(new Set(all.map(r => r.id)).size).toBe(103); expect(all.slice(0, 50)).toEqual(page.rows);
    expect(all.every(r => r.company === 'Acme Sdn Bhd')).toBe(true);
    expect((await leaveInquiryRecordsPage(ctx, scope, q({ status: 'cancelled' }, 'records'))).total).toBe(51);
    const singleQuery = q({ emp: mine }, 'records');
    const singleScope = await leaveInquiryContext(ctx, [b.companyId], singleQuery);
    expect((await leaveInquiryRecordsPage(ctx, singleScope, singleQuery)).rows[0].department).toBe('Finance');
    expect((await leaveInquiryRecordsPage(ctx, scope, q({ from: '2026-10-15', to: '2026-10-15' }, 'records'))).total).toBe(0);
    expect((await leaveInquiryRecordsPage(ctx, scope, q({ q: `#${all[0].id.slice(0, 8)}` }, 'records'))).total).toBe(1);
    const both = await leaveInquiryContext(ctx, [b.companyId, company2], q({}, 'records')); expect((await leaveInquiryRecordsPage(ctx, both, q({}, 'records'))).total).toBe(105);
  });
  it('refuses oversized and changing exports instead of producing a partial file', async () => {
    await expect(collectInquiryExport(async () => ({ rows: [], total: 10_001 }))).rejects.toThrow('Export exceeds');
    await expect(collectInquiryExport(async w => ({ rows: [w.offset], total: w.offset ? 2 : 3 }))).rejects.toThrow('Results changed');
  });
  it('explicit Tx seams equal standalone canonical defaults and dated reads', async () => {
    const opts = { includeHidden: true, includeArchived: true, includeIneligible: true, asOf: '2026-10-15' };
    expect(await withTenant(ctx, tx => leaveBalancesTx(tx, ctx, mine, 'en', opts))).toEqual(await leaveBalances(ctx, mine, 'en', opts));
    expect(await withTenant(ctx, tx => leaveEntitlementBreakdownTx(tx, mine, b.annualLeaveTypeId, opts.asOf, 'en', {}))).toEqual(await leaveEntitlementBreakdown(ctx, mine, b.annualLeaveTypeId, opts.asOf, 'en'));
  });
});
