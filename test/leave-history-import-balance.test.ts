/**
 * 3f15ffdb (r362) — THE MONEY HALF OF LEAVE HISTORY DATA IMPORT.
 *
 * The approved plan makes one promise above all others and the reporter raised it themselves (ticket
 * point 9): importing history does NOT touch anybody's leave balance. Every case in this file is that
 * promise, or one of the three paths that had to be fixed for it to survive contact with the rest of
 * the system.
 *
 * ⚠️ A BALANCE ASSERTION OVER AN EMPLOYEE WITH NO LEAVE DATA PASSES WHATEVER THE CODE DOES. Every
 * case below therefore gives the employee a REAL, NON-ZERO opening balance first and asserts the exact
 * figure afterwards, so "unchanged" is a measurement rather than a tautology. The opening accrual is
 * asserted to be non-zero in its own right before anything else happens.
 *
 * ── WHAT WAS WRONG BEFORE THIS ROUND, and is pinned here ────────────────────────────────────────
 *
 *  1. core/leave.ts `applyLeaveCancellationApprovalTx` — the whole-span reversal is guarded on
 *     `chargedDays > 0`; the PER-SEGMENT RE-DEBIT was not. Giving one day back out of an approved
 *     request that carries no ledger debit reversed nothing and then inserted a fresh debit for the
 *     surviving segment: a deduction against a balance that was never charged. Reachable by an
 *     ORDINARY EMPLOYEE, because a migration legitimately carries an approved FUTURE leave (someone
 *     booked next month's holiday in the system being replaced) and the give-back notice window is
 *     counted from today. The fix tests the LEDGER, not the import marker, and the last case in that
 *     block is what holds it to that.
 *  2. core/payroll.ts `unpaidDaysByEmployment` reads `leave_request`, not the ledger, and admits any
 *     approved request of an unpaid type starting in the period. One imported unpaid record dated in
 *     a not-yet-run period would have cut that person's salary. A data-migration tool must not move
 *     money, so imported history is excluded.
 *  3. core/leave-encashment.ts `approvedLeaveDaysAfter` raises a final-pay hint whose stated premise
 *     ("already debited at approval") is false for these rows, and whose documented remedy (cancel
 *     the request) correctly gives back nothing — a loop that cannot close. Excluded.
 */
import { eq } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import * as schema from '../db/schema';
import { withTenant } from '../db/client';
import type { SessionContext } from '../db/client';
import { hireEmployee, setReportingLine } from '../core/org';
import { createLeaveType, updateLeaveType } from '../core/admin';
import { setLeaveApprovalPolicy } from '../core/leave-approval-policy';
import { requestLeaveCancellation } from '../core/leave';
import { approvedLeaveDaysAfter } from '../core/leave-encashment';
import { unpaidDaysByEmployment } from '../core/payroll';
import { commitLeaveHistoryImport } from '../core/leave-history-import';
import { leaveBalances } from '../core/read';
import { todayInKualaLumpur } from '../lib/hr-date';
import {
  adminCtx,
  closeAll,
  createAppUser,
  ledgerBalance,
  migrateTestDb,
  owner,
  resetDb,
  seedBase,
  type Base,
} from './harness';

let b: Base;
let subject: { personId: string; employmentId: string; code: string };
let subjectCtx: SessionContext;
let manager: { personId: string; employmentId: string };

const TODAY = todayInKualaLumpur();
const addDays = (iso: string, n: number) =>
  new Date(Date.parse(`${iso}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
/** Monday of the first full week at least 21 days out — every date derived from it is future. */
const MON = (() => {
  let d = addDays(TODAY, 21);
  while ((new Date(`${d}T00:00:00Z`).getUTCDay() || 7) !== 1) d = addDays(d, 1);
  return d;
})();
const TUE = addDays(MON, 1);
const WED = addDays(MON, 2);
const THU = addDays(MON, 3);
const FRI = addDays(MON, 4);
/** A settled past week, for the ordinary historical case. */
const P_MON = (() => {
  let d = addDays(TODAY, -120);
  while ((new Date(`${d}T00:00:00Z`).getUTCDay() || 7) !== 1) d = addDays(d, 1);
  return d;
})();
const P_WED = addDays(P_MON, 2);

/** The opening balance every case starts from. Non-zero ON PURPOSE — see the header. */
const OPENING = 30;

const HEADERS = [
  'employee_no',
  'leave_reference',
  'leave_code',
  'entitlement_year',
  'leave_start_date',
  'leave_end_date',
  'number_of_day',
  'session',
  'entry_date',
  'submit_date',
  'approved_date',
  'remark',
];
type Row = Partial<Record<string, string>>;
const recs = (rows: Row[]) => rows.map((r) => Object.fromEntries(HEADERS.map((h) => [h, r[h] ?? ''])));

async function hire(name: string) {
  const { employmentId } = await hireEmployee(adminCtx(b), {
    person: { fullName: name, primaryEmail: `lhb_${randomUUID().slice(0, 8)}@t.local` },
    companyId: b.companyId,
    departmentId: b.deptA,
    employmentType: 'full_time',
    hiredOn: addDays(TODAY, -800),
  });
  const [row] = await owner.db
    .select({ personId: schema.employment.personId, code: schema.employment.employeeCode })
    .from(schema.employment)
    .where(eq(schema.employment.id, employmentId));
  return { employmentId, personId: row.personId, code: row.code! };
}

/** Count of leave_ledger rows for the subject — the strongest form of "no balance moved". */
async function ledgerRowCount(leaveTypeId?: string): Promise<number> {
  const rows = await owner.db
    .select({ id: schema.leaveLedger.id, typeId: schema.leaveLedger.leaveTypeId })
    .from(schema.leaveLedger)
    .where(eq(schema.leaveLedger.employmentId, subject.employmentId));
  return leaveTypeId ? rows.filter((r) => r.typeId === leaveTypeId).length : rows.length;
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
  await setLeaveApprovalPolicy(adminCtx(b), { companyId: b.companyId, levels: ['direct_manager'] });
  subject = await hire('Balance Subject');
  const u = await createAppUser(b.tenantId, subject.personId, 'employee');
  subjectCtx = { tenantId: b.tenantId, userId: u, personId: subject.personId, roles: ['employee'] };
  manager = await hire('Balance Manager');
  await createAppUser(b.tenantId, manager.personId, 'manager');
  await setReportingLine(adminCtx(b), {
    subordinateEmploymentId: subject.employmentId,
    managerEmploymentId: manager.employmentId,
    lineType: 'administrative',
    validFrom: addDays(TODAY, -800),
  });
  // THE MIGRATED OPENING BALANCE. This is the figure the whole decision turns on: it ALREADY has the
  // past leave taken out of it, which is why importing the records must not deduct them again.
  await owner.db.insert(schema.leaveLedger).values({
    tenantId: b.tenantId,
    employmentId: subject.employmentId,
    leaveTypeId: b.annualLeaveTypeId,
    entryType: 'accrual',
    days: `${OPENING}.00`,
    effectiveOn: addDays(TODAY, -365),
  });
});

describe('the promise: importing history moves no balance', () => {
  it('the fixture itself has a real, non-zero balance before anything is imported', async () => {
    // Guards every case below from the vacuity the header warns about.
    expect(await ledgerBalance(subject.employmentId, b.annualLeaveTypeId)).toBe(OPENING);
    expect(await ledgerRowCount()).toBe(1);
  });

  it('importing three days of past Annual Leave leaves the balance at exactly the opening figure', async () => {
    const res = await commitLeaveHistoryImport(adminCtx(b), {
      records: recs([
        {
          employee_no: subject.code,
          leave_reference: 'LV/MIG/0001',
          leave_code: 'ANNUAL',
          leave_start_date: P_MON,
          leave_end_date: P_WED,
          number_of_day: '3',
          remark: 'Data Migration',
        },
      ]),
    });
    expect(res.imported).toBe(1);
    // The record is there…
    const [req] = await owner.db
      .select({ id: schema.leaveRequest.id, status: schema.leaveRequest.status })
      .from(schema.leaveRequest)
      .where(eq(schema.leaveRequest.employmentId, subject.employmentId));
    expect(req.status).toBe('approved');
    // …and the balance is untouched, to the day. Not "roughly": exactly 30.
    expect(await ledgerBalance(subject.employmentId, b.annualLeaveTypeId)).toBe(OPENING);
    // …and not because a debit and a credit cancelled out: NO ledger row was written at all.
    expect(await ledgerRowCount()).toBe(1);
  });

  it('the Taken figure on the balance screens does not move either, which the plan told the reporter', async () => {
    const before = await leaveBalances(adminCtx(b), subject.employmentId);
    const beforeRow = before.find((r) => r.leaveTypeId === b.annualLeaveTypeId)!;
    expect(Number(beforeRow.balance)).toBe(OPENING);

    await commitLeaveHistoryImport(adminCtx(b), {
      records: recs([
        {
          employee_no: subject.code,
          leave_reference: 'LV/MIG/0002',
          leave_code: 'ANNUAL',
          leave_start_date: P_MON,
          leave_end_date: P_WED,
          number_of_day: '3',
        },
      ]),
    });

    const after = await leaveBalances(adminCtx(b), subject.employmentId);
    const afterRow = after.find((r) => r.leaveTypeId === b.annualLeaveTypeId)!;
    // DISCLOSED TO THE REPORTER IN THE APPROVED PLAN, in these words: "An imported leave shows in the
    // employee's leave history, but it is not added to the Taken figure on the balance screens. That
    // figure counts what has actually come off the balance, and by design we have not taken it off."
    expect(Number(afterRow.balance)).toBe(Number(beforeRow.balance));
    expect(Number(afterRow.taken)).toBe(Number(beforeRow.taken));
  });
});

describe('cancelling an imported record gives nothing back — and, since r362, takes nothing either', () => {
  /**
   * A migration legitimately carries an APPROVED FUTURE leave: someone booked next month's holiday in
   * the system being replaced. That is the shape that makes the give-back path reachable, because the
   * cancellation notice period is counted from today — so it is the shape this case uses.
   */
  async function importFutureWeek(): Promise<string> {
    await commitLeaveHistoryImport(adminCtx(b), {
      records: recs([
        {
          employee_no: subject.code,
          leave_reference: 'LV/MIG/FUTURE',
          leave_code: 'ANNUAL',
          leave_start_date: MON,
          leave_end_date: FRI,
          number_of_day: '5',
          remark: 'Data Migration',
        },
      ]),
    });
    const [req] = await owner.db
      .select({ id: schema.leaveRequest.id })
      .from(schema.leaveRequest)
      .where(eq(schema.leaveRequest.employmentId, subject.employmentId));
    return req.id;
  }

  it('a WHOLE give-back credits nothing, because nothing was ever charged', async () => {
    const id = await importFutureWeek();
    await updateLeaveType(adminCtx(b), {
      id: b.annualLeaveTypeId,
      name: 'Annual Leave',
      employeeCancelApproved: true,
      cancelAutoApprove: true,
      cancelNoticeDays: 0,
    });
    const out = await requestLeaveCancellation(subjectCtx, {
      leaveRequestId: id,
      cancelDates: [MON, TUE, WED, THU, FRI],
      today: TODAY,
    });
    expect(out.status).toBe('approved');
    expect(await ledgerBalance(subject.employmentId, b.annualLeaveTypeId)).toBe(OPENING);
    expect(await ledgerRowCount()).toBe(1);
  });

  it('⚠️ A PARTIAL give-back does NOT debit the surviving days — the phantom deduction r362 fixed', async () => {
    const id = await importFutureWeek();
    await updateLeaveType(adminCtx(b), {
      id: b.annualLeaveTypeId,
      name: 'Annual Leave',
      employeeCancelApproved: true,
      cancelAutoApprove: true,
      cancelNoticeDays: 0,
    });

    // Give back ONE day of five. Before r362 this reversed 0.00 (correctly, nothing was charged) and
    // then inserted a brand-new -4.00 debit for the surviving segment, so a balance of 30 became 26 —
    // four days taken off a balance that had never been charged for this leave at all.
    const out = await requestLeaveCancellation(subjectCtx, { leaveRequestId: id, cancelDates: [WED], today: TODAY });
    expect(out.status).toBe('approved');

    expect(
      await ledgerBalance(subject.employmentId, b.annualLeaveTypeId),
      'giving one day back out of an uncharged request must not debit the other four',
    ).toBe(OPENING);
    expect(await ledgerRowCount(), 'no ledger row at all should have been written').toBe(1);
    // …and the split still happened: the request really was cancelled in part, so this is not passing
    // because nothing occurred.
    const rows = await owner.db
      .select({ id: schema.leaveRequest.id, status: schema.leaveRequest.status, s: schema.leaveRequest.startDate })
      .from(schema.leaveRequest)
      .where(eq(schema.leaveRequest.employmentId, subject.employmentId))
      .orderBy(schema.leaveRequest.startDate);
    expect(rows.length).toBeGreaterThan(1);
    expect(rows.some((r) => r.status === 'cancelled' && r.s === WED)).toBe(true);
    expect(rows.some((r) => r.status === 'approved')).toBe(true);
  });

  it('the guard tests the LEDGER, not the import marker: any uncharged approved row is safe', async () => {
    // The fix must not be "imported rows are special". It is "re-debit only what was charged", and
    // this case is what makes that difference observable: an ordinary approved request — NOT imported,
    // `imported_history` false — that happens to carry no sourced ledger debit. A later round that
    // narrowed the guard to `importedHistory` would pass every case above and fail this one.
    await updateLeaveType(adminCtx(b), {
      id: b.annualLeaveTypeId,
      name: 'Annual Leave',
      employeeCancelApproved: true,
      cancelAutoApprove: true,
      cancelNoticeDays: 0,
    });
    const [req] = await owner.db
      .insert(schema.leaveRequest)
      .values({
        tenantId: b.tenantId,
        employmentId: subject.employmentId,
        leaveTypeId: b.annualLeaveTypeId,
        startDate: MON,
        endDate: FRI,
        days: '5.00',
        durationType: 'full_day',
        status: 'approved',
        importedHistory: false,
      })
      .returning({ id: schema.leaveRequest.id });

    await requestLeaveCancellation(subjectCtx, { leaveRequestId: req.id, cancelDates: [WED], today: TODAY });

    expect(
      await ledgerBalance(subject.employmentId, b.annualLeaveTypeId),
      'an uncharged approved request must not be debited on a partial give-back, imported or not',
    ).toBe(OPENING);
    expect(await ledgerRowCount()).toBe(1);
  });
});

describe('an imported record never changes pay', () => {
  it('an imported UNPAID-type record is excluded from the unpaid-leave days payroll deducts', async () => {
    const { id: uplId } = await createLeaveType(adminCtx(b), {
      code: `UPL${randomUUID().slice(0, 4).toUpperCase()}`,
      name: 'Unpaid Leave',
      paid: false,
    });
    const periodStart = `${P_MON.slice(0, 7)}-01`;
    const periodEnd = addDays(`${P_MON.slice(0, 7)}-01`, 30);

    // An ordinary approved unpaid request in the same period IS deducted — the control, so the
    // exclusion below cannot pass because the read returns nothing for everybody.
    await owner.db.insert(schema.leaveRequest).values({
      tenantId: b.tenantId,
      employmentId: subject.employmentId,
      leaveTypeId: uplId,
      startDate: P_MON,
      endDate: P_MON,
      days: '1.00',
      durationType: 'full_day',
      status: 'approved',
    });
    const control = await withTenant(adminCtx(b), (tx) => unpaidDaysByEmployment(tx, periodStart, periodEnd));
    expect(control.get(subject.employmentId), 'the control row must be deducted').toBe(1);

    // …and the IMPORTED one, three days of the same unpaid type in the same period, is not.
    await commitLeaveHistoryImport(adminCtx(b), {
      records: recs([
        {
          employee_no: subject.code,
          leave_reference: 'LV/MIG/UPL',
          leave_code: (
            await owner.db
              .select({ c: schema.leaveType.code })
              .from(schema.leaveType)
              .where(eq(schema.leaveType.id, uplId))
          )[0].c,
          leave_start_date: P_MON,
          leave_end_date: P_WED,
          number_of_day: '3',
        },
      ]),
    });
    const after = await withTenant(adminCtx(b), (tx) => unpaidDaysByEmployment(tx, periodStart, periodEnd));
    expect(
      after.get(subject.employmentId),
      'importing three days of past unpaid leave must not cut this month’s salary',
    ).toBe(1);
  });
});

describe('an imported record raises no final-pay hint it cannot answer', () => {
  it('approvedLeaveDaysAfter ignores imported history', async () => {
    const lastWorkingDay = TODAY;

    // The control: an ORDINARY approved request after the last working day is counted, as before.
    await owner.db.insert(schema.leaveRequest).values({
      tenantId: b.tenantId,
      employmentId: subject.employmentId,
      leaveTypeId: b.annualLeaveTypeId,
      startDate: MON,
      endDate: MON,
      days: '1.00',
      durationType: 'full_day',
      status: 'approved',
    });
    const control = await withTenant(adminCtx(b), (tx) =>
      approvedLeaveDaysAfter(tx, subject.employmentId, b.annualLeaveTypeId, lastWorkingDay),
    );
    expect(control, 'an ordinary future approved leave must still raise the hint').toBe(1);

    // The imported one is not, because the hint's premise ("already debited at approval") is false for
    // it and its documented remedy — cancel the request — correctly gives back nothing.
    await commitLeaveHistoryImport(adminCtx(b), {
      records: recs([
        {
          employee_no: subject.code,
          leave_reference: 'LV/MIG/AFTER',
          leave_code: 'ANNUAL',
          leave_start_date: TUE,
          leave_end_date: THU,
          number_of_day: '3',
        },
      ]),
    });
    const after = await withTenant(adminCtx(b), (tx) =>
      approvedLeaveDaysAfter(tx, subject.employmentId, b.annualLeaveTypeId, lastWorkingDay),
    );
    expect(after, 'imported history must not be added to the final-pay hint').toBe(1);
  });
});
