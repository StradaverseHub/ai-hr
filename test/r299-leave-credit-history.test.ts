/**
 * 3fb1a611 (r299) · THE LEAVE CREDIT HISTORY IS DERIVED FROM THE LEDGER, AND IT ADDS UP.
 *
 * One ledger: listLeaveCreditMovements reads the Replacement Leave type's leave_ledger rows and describes each
 * one by what it links to — nothing is stored twice. The running total runs per (employee, leave type) in
 * effective_on, created_at, id order, so every row's "after" must equal the balance of the ledger rows up to it
 * in that order, and the last row's "after" must equal leaveBalance.
 *
 * Also here: Leave Adjustments refuses the Replacement Leave type (gap 8), and the Apply form's Expiring soon
 * figure (gap 9).
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { and, asc, eq } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import * as schema from '../db/schema';
import type { SessionContext } from '../db/client';
import { adminCtx, closeAll, createAppUser, entitledCtx, migrateTestDb, owner, resetDb, seedBase, setModule, type Base } from './harness';
import { hireEmployee, setReportingLine } from '../core/org';
import { setCompensation } from '../core/comp';
import { setRestDay } from '../core/roster';
import { setLeaveApprovalPolicy } from '../core/leave-approval-policy';
import { adminCancelLeave, decideLeave, leaveBalance, leaveTypeApplySummary, requestLeave } from '../core/leave';
import { applyLeaveAdjustmentBatch, LeaveAdjustmentError } from '../core/leave-adjustment';
import { commitLeaveImport, validateLeaveImport } from '../core/leave-import';
import { todayInKualaLumpur } from '../lib/hr-date';
import {
  EXPIRING_SOON_DAYS,
  grantLeaveCredit,
  listLeaveCreditMovements,
  listEarnedLeaveCredits,
  reverseLeaveCredit,
  runToilExpiry,
  setToilPolicy,
} from '../core/toil';
import { decideReplacementLeaveRequest, submitReplacementLeaveRequest } from '../core/replacement-request';

let b: Base;
let admin: SessionContext;

const TODAY = todayInKualaLumpur();
const addDays = (iso: string, n: number) => new Date(Date.parse(`${iso}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
const LAST_MONTH = (() => {
  const [y, m] = TODAY.split('-').map(Number);
  return new Date(Date.UTC(y, m - 2, 1)).toISOString().slice(0, 7);
})();
const nextMonday = (from: string) => {
  let d = from;
  while ((new Date(`${d}T00:00:00Z`).getUTCDay() || 7) !== 1) d = addDays(d, 1);
  return d;
};

async function hire(name: string) {
  const e = await hireEmployee(adminCtx(b), {
    person: { fullName: name, primaryEmail: `r299h_${randomUUID().slice(0, 8)}@t.local` },
    companyId: b.companyId,
    departmentId: b.deptA,
    employmentType: 'full_time',
    hiredOn: '2024-01-01',
  });
  await setCompensation(adminCtx(b), { employmentId: e.employmentId, basicSalary: 8000, monthlyAllowance: 0, effectiveFrom: '2024-01-01' });
  return e;
}

async function replacementTypeId() {
  const [lt] = await owner.db
    .select({ id: schema.leaveType.id })
    .from(schema.leaveType)
    .where(and(eq(schema.leaveType.tenantId, b.tenantId), eq(schema.leaveType.code, 'REPLACEMENT')));
  return lt.id;
}

beforeAll(async () => {
  await migrateTestDb();
});
afterAll(async () => {
  await closeAll();
});
beforeEach(async () => {
  await resetDb();
  b = await seedBase();
  await setModule(b.tenantId, 'toil', 'active');
  admin = await entitledCtx(b);
  await setLeaveApprovalPolicy(adminCtx(b), { companyId: b.companyId, levels: ['direct_manager'] });
  await setToilPolicy(admin, {
    companyId: b.companyId,
    enabled: true,
    accrualBasis: 'hours_worked',
    expiryDays: 90,
    onExpiry: 'lapse',
    allowFirstScheduleEligible: false,
    autoAccrueOnApproval: false,
    carryForwardAtYearEnd: false,
    employeeRequestEnabled: true,
  });
});

describe('Leave Credit history — derived, classified, and the running total is the balance', () => {
  it('every movement type appears once, with who did it, and each row’s after equals the ledger balance up to it', async () => {
    const emp = await hire('Aisyah History');
    const mgr = await hire('Mahmud Manager');
    await setReportingLine(adminCtx(b), {
      subordinateEmploymentId: emp.employmentId,
      managerEmploymentId: mgr.employmentId,
      lineType: 'administrative',
      validFrom: '2024-01-01',
    });
    const subCtx: SessionContext = {
      tenantId: b.tenantId,
      userId: await createAppUser(b.tenantId, emp.personId, 'employee'),
      personId: emp.personId,
      roles: ['employee'],
      entitlements: admin.entitlements,
    };
    const mgrCtx: SessionContext = {
      tenantId: b.tenantId,
      userId: await createAppUser(b.tenantId, mgr.personId, 'manager'),
      personId: mgr.personId,
      roles: ['manager'],
      entitlements: admin.entitlements,
    };
    const worked = (d: number) => `${LAST_MONTH}-${String(d).padStart(2, '0')}`;
    for (const d of [2, 3, 4, 5, 6]) await setRestDay(adminCtx(b), { employmentId: emp.employmentId, shiftDate: worked(d) });

    // 1 · earned through a request, approved by the manager
    const { requestId } = await submitReplacementLeaveRequest(subCtx, {
      employmentId: emp.employmentId,
      unit: 'day',
      lines: [{ workedDate: worked(2), days: 1 }],
      reason: 'Project deployment',
      today: TODAY,
    });
    await decideReplacementLeaveRequest(mgrCtx, { requestId, decision: 'approved' });
    // 2 · added by HR (x3: one to reverse, one to expire, one to use)
    const toReverse = await grantLeaveCredit(admin, { employmentId: emp.employmentId, workedDate: worked(3), days: 1, reason: 'Entered twice', today: TODAY });
    const toExpire = await grantLeaveCredit(admin, {
      employmentId: emp.employmentId,
      workedDate: worked(4),
      days: 0.5,
      reason: 'Half-day cover',
      expiresOn: addDays(TODAY, -1), // already past: the sweep below expires it
      today: TODAY,
    });
    await grantLeaveCredit(admin, { employmentId: emp.employmentId, workedDate: worked(5), days: 2, reason: 'Special approval', expiresOn: addDays(TODAY, 20), today: TODAY });
    // 3 · reversed
    await reverseLeaveCredit(admin, { accrualId: toReverse.accrualId, reason: 'Entered twice', today: TODAY });
    // 4 · expired (lapse policy)
    await runToilExpiry(admin, { today: TODAY });
    // 5 · used by Replacement Leave (approved by the manager), then 6 · returned by HR cancellation
    const mon = nextMonday(addDays(TODAY, 14));
    const leave = await requestLeave(subCtx, {
      employmentId: emp.employmentId,
      leaveTypeId: await replacementTypeId(),
      startDate: mon,
      endDate: mon,
      reason: 'Personal',
      today: TODAY,
    });
    await decideLeave(mgrCtx, { leaveRequestId: leave.leaveRequestId, decision: 'approved' });
    const beforeReturn = await listEarnedLeaveCredits(admin,{companyIds:[b.companyId],employmentId:emp.employmentId,today:TODAY,limit:1});
    expect(beforeReturn.matched).toBe(4);expect(beforeReturn.rows).toHaveLength(1);
    expect(beforeReturn.summary).toEqual({earned:4.5,used:1,expired:.5,available:2});
    const usedCredit=(await listEarnedLeaveCredits(admin,{employmentId:emp.employmentId,status:'partially_used',today:TODAY})).rows[0];
    expect(usedCredit.workedDate).toBe(worked(5));expect(usedCredit.used).toBe(1);
    expect(usedCredit.usage).toEqual([{requestId:leave.leaveRequestId,date:mon,days:1}]);
    await adminCancelLeave(admin, { leaveRequestId: leave.leaveRequestId, reason: 'Plans changed' });
    const afterReturn=await listEarnedLeaveCredits(admin,{companyIds:[b.companyId],employmentId:emp.employmentId,today:TODAY});
    expect(afterReturn.rows).toHaveLength(4);expect(afterReturn.summary).toEqual({earned:4.5,used:0,expired:.5,available:3});
    expect(afterReturn.rows.find(row=>row.accrualId===usedCredit.accrualId)).toMatchObject({used:0,available:2,status:'available',usage:[]});
    expect(afterReturn.rows.find(row=>row.accrualId===toReverse.accrualId)).toMatchObject({status:'reversed',reversible:false});
    expect(afterReturn.rows.find(row=>row.accrualId===toExpire.accrualId)).toMatchObject({status:'expired',available:0,expired:.5});
    expect((await listEarnedLeaveCredits(admin,{employmentId:emp.employmentId,status:'available',today:TODAY})).summary.available).toBe(3);

    const { rows, matched, truncated } = await listLeaveCreditMovements(admin, { companyIds: [b.companyId], today: TODAY });
    expect(truncated).toBe(false);
    expect(matched).toBe(rows.length);
    const movements = rows.map((r) => r.movement).sort();
    expect(movements).toEqual(
      ['added_hr', 'added_hr', 'added_hr', 'earned_request', 'expired', 'returned', 'reversed', 'used'].sort(),
    );

    const one = (m: string) => rows.filter((r) => r.movement === m);
    expect(one('earned_request')[0]).toMatchObject({ reason: 'Project deployment', actorName: 'Mahmud Manager', workedDayKind: 'rest_day', days: 1, status: 'available' });
    expect(one('reversed')[0]).toMatchObject({ reason: 'Entered twice', workedDate: worked(3), days: -1, status: 'reversed', expiresOn: null });
    expect(one('added_hr').find((r) => r.workedDate === worked(3))).toMatchObject({ status: 'reversed', reversible: false });
    expect(one('added_hr').find((r) => r.workedDate === worked(4))).toMatchObject({ status: 'expired', reversible: false });
    expect(one('added_hr').find((r) => r.workedDate === worked(5))).toMatchObject({ status: 'available', reversible: true, reason: 'Special approval' });
    expect(one('expired')[0]).toMatchObject({ accrualId: toExpire.accrualId, days: -0.5, status: 'expired' });
    expect(one('used')[0]).toMatchObject({ reason: 'Personal', actorName: 'Mahmud Manager', days: -1, status: 'used' });
    expect(one('returned')[0]).toMatchObject({ days: 1 });

    // THE RUNNING TOTAL: replay the ledger in the stated order and compare every row.
    const ledger = await owner.db
      .select({ id: schema.leaveLedger.id, days: schema.leaveLedger.days })
      .from(schema.leaveLedger)
      .where(and(eq(schema.leaveLedger.employmentId, emp.employmentId), eq(schema.leaveLedger.leaveTypeId, await replacementTypeId())))
      .orderBy(asc(schema.leaveLedger.effectiveOn), asc(schema.leaveLedger.createdAt), asc(schema.leaveLedger.id));
    expect(ledger.length).toBe(rows.length);
    let running = 0;
    const expectedAfter = new Map<string, { before: number; after: number }>();
    for (const r of ledger) {
      const before = running;
      running = Math.round((running + Number(r.days)) * 100) / 100;
      expectedAfter.set(r.id, { before, after: running });
    }
    for (const row of rows) {
      expect({ before: row.balanceBefore, after: row.balanceAfter }, row.movement).toEqual(expectedAfter.get(row.ledgerEntryId));
      expect(Math.round((row.balanceBefore + row.days) * 100) / 100).toBe(row.balanceAfter);
    }
    const bal = await owner.db.transaction(async (tx) => leaveBalance(tx as never, emp.employmentId, await replacementTypeId()));
    expect(running).toBe(bal);
    expect(bal).toBe(3); // 1 (request) + 2 (still available) — reversed, expired and the returned leave net out

    // Filters: movement, and a date range that excludes everything.
    expect((await listLeaveCreditMovements(admin, { movement: 'reversed', today: TODAY })).rows).toHaveLength(1);
    expect((await listLeaveCreditMovements(admin, { from: addDays(TODAY, 400), today: TODAY })).rows).toHaveLength(0);
    expect((await listLeaveCreditMovements(admin, { employmentId: mgr.employmentId, today: TODAY })).rows).toHaveLength(0);
  });
});

describe('Leave Adjustments refuses the Replacement Leave type (gap 8)', () => {
  it('refuses a batch that names it, alone or beside another type, and writes nothing', async () => {
    const emp = await hire('Adjusted');
    // A credit first, so the tenant's Replacement Leave type exists (and the employee has a real balance on it).
    await setRestDay(adminCtx(b), { employmentId: emp.employmentId, shiftDate: `${LAST_MONTH}-07` });
    await grantLeaveCredit(admin, { employmentId: emp.employmentId, workedDate: `${LAST_MONTH}-07`, days: 1, reason: 'creates the type', today: TODAY });
    const replacement = await replacementTypeId();
    const before = await owner.db.select({ id: schema.leaveLedger.id }).from(schema.leaveLedger).where(eq(schema.leaveLedger.employmentId, emp.employmentId));
    for (const leaveTypeIds of [[replacement], [b.annualLeaveTypeId, replacement]]) {
      const attempt = applyLeaveAdjustmentBatch(admin, {
        leaveTypeIds,
        days: 1,
        reason: 'Top up',
        effectiveOn: TODAY,
        targetMode: 'individual',
        employmentIds: [emp.employmentId],
      });
      await expect(attempt).rejects.toBeInstanceOf(LeaveAdjustmentError);
      await expect(attempt).rejects.toThrow(/Leave Credit/);
    }
    const after = await owner.db.select({ id: schema.leaveLedger.id }).from(schema.leaveLedger).where(eq(schema.leaveLedger.employmentId, emp.employmentId));
    expect(after.length).toBe(before.length);
    // Every other type still adjusts.
    await expect(
      applyLeaveAdjustmentBatch(admin, {
        leaveTypeIds: [b.annualLeaveTypeId],
        days: 1,
        reason: 'Top up',
        effectiveOn: TODAY,
        targetMode: 'individual',
        employmentIds: [emp.employmentId],
      }),
    ).resolves.toMatchObject({ written: 1 });
  });
});

describe('Leave import refuses the Replacement Leave type (same promise as gap 8)', () => {
  it('errors the row in the preview, commits nothing for it, and still imports another type', async () => {
    const emp = await hire('Imported');
    await setRestDay(adminCtx(b), { employmentId: emp.employmentId, shiftDate: `${LAST_MONTH}-08` });
    await grantLeaveCredit(admin, { employmentId: emp.employmentId, workedDate: `${LAST_MONTH}-08`, days: 1, reason: 'creates the type', today: TODAY });
    const [row] = await owner.db
      .select({ code: schema.employment.employeeCode })
      .from(schema.employment)
      .where(eq(schema.employment.id, emp.employmentId));
    const records = [
      { employee_id: row.code!, leave_type: 'REPLACEMENT', transaction_type: 'adjustment', days: '3', effective_date: TODAY },
      { employee_id: row.code!, leave_type: 'ANNUAL', transaction_type: 'adjustment', days: '1', effective_date: TODAY },
    ];
    const preview = await validateLeaveImport(admin, { records });
    expect(preview.rows[0].ok).toBe(false);
    expect(preview.rows[0].errors.join(' ')).toMatch(/Leave Credit/);
    expect(preview.rows[1].ok).toBe(true);

    const replacement = await replacementTypeId();
    const ledger = () =>
      owner.db
        .select({ id: schema.leaveLedger.id })
        .from(schema.leaveLedger)
        .where(and(eq(schema.leaveLedger.employmentId, emp.employmentId), eq(schema.leaveLedger.leaveTypeId, replacement)));
    const before = (await ledger()).length;
    await commitLeaveImport(admin, { records });
    expect((await ledger()).length, 'no Replacement Leave row written by import').toBe(before);
    const annual = await owner.db
      .select({ id: schema.leaveLedger.id })
      .from(schema.leaveLedger)
      .where(and(eq(schema.leaveLedger.employmentId, emp.employmentId), eq(schema.leaveLedger.leaveTypeId, b.annualLeaveTypeId), eq(schema.leaveLedger.entryType, 'adjustment')));
    expect(annual.length, 'the valid row beside it is still imported').toBe(1);
  });
});

describe('Apply form: Expiring soon (gap 9)', () => {
  it('counts only the unused part of active credits expiring within the window, and only for Replacement Leave', async () => {
    const emp = await hire('Expiring');
    const worked = (d: number) => `${LAST_MONTH}-${String(d).padStart(2, '0')}`;
    for (const d of [8, 9, 10, 11]) await setRestDay(adminCtx(b), { employmentId: emp.employmentId, shiftDate: worked(d) });
    const soon = await grantLeaveCredit(admin, { employmentId: emp.employmentId, workedDate: worked(8), days: 2, reason: 'r', expiresOn: addDays(TODAY, 5), today: TODAY });
    await grantLeaveCredit(admin, { employmentId: emp.employmentId, workedDate: worked(9), days: 1, reason: 'r', expiresOn: addDays(TODAY, EXPIRING_SOON_DAYS), today: TODAY });
    await grantLeaveCredit(admin, { employmentId: emp.employmentId, workedDate: worked(10), days: 4, reason: 'r', expiresOn: addDays(TODAY, EXPIRING_SOON_DAYS + 1), today: TODAY });
    const reversed = await grantLeaveCredit(admin, { employmentId: emp.employmentId, workedDate: worked(11), days: 8, reason: 'r', expiresOn: addDays(TODAY, 3), today: TODAY });
    await reverseLeaveCredit(admin, { accrualId: reversed.accrualId, reason: 'x', today: TODAY });
    // Half of the soonest credit already used.
    await owner.db.update(schema.toilAccrual).set({ daysTaken: '0.50' }).where(eq(schema.toilAccrual.id, soon.accrualId));

    const rl = await leaveTypeApplySummary(admin, { employmentId: emp.employmentId, leaveTypeId: await replacementTypeId() });
    expect(rl.expiringSoon).toBe(2.5); // 1.5 left of the first + 1 at the window's last day; not the 4, not the reversed 8
    const annual = await leaveTypeApplySummary(admin, { employmentId: emp.employmentId, leaveTypeId: b.annualLeaveTypeId });
    expect(annual.expiringSoon).toBeNull();
  });
});
