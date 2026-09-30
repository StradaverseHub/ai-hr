/**
 * r367 (073233bb) — THE MONEY HALF OF LEAVE HISTORY DATA IMPORT, AND THE ROUND THAT REVERSED IT.
 *
 * ── WHAT THIS FILE WAS, AND WHY IT IS NOT DELETED ──────────────────────────────────────────────────
 *
 * r362 (3f15ffdb) made one promise above all others: importing history does NOT touch anybody's leave
 * balance. Every case in this file used to be that promise. It rested on a sentence the product PRINTED
 * as a statement of fact — "the balances you migrate already have this leave removed from them" — which
 * is a claim about the CUSTOMER'S DATA that this product never asked about and cannot verify. For a
 * tenant whose entitlement is generated from the entitlement tables with nothing brought forward it is
 * false: those are whole-year allowances, not net figures. The reporter of 073233bb is that tenant, and
 * their leave was recorded and never deducted.
 *
 * So r367 asks instead of assuming (`openingBalancesAreNet`, default NO) and the promise SPLITS in two.
 * Both halves are pinned here, and the r362 half is pinned under its option rather than removed: a
 * customer arriving with their own closing balances is a real migration shape, and r362 shipped one day
 * before the report against it.
 *
 * ⚠️ A BALANCE ASSERTION OVER AN EMPLOYEE WITH NO LEAVE DATA PASSES WHATEVER THE CODE DOES. Every case
 * below therefore gives the employee a REAL, NON-ZERO opening balance first and asserts the exact figure
 * afterwards, so both "unchanged" and "down by three" are measurements rather than tautologies. The
 * opening accrual is asserted to be non-zero IN ITS OWN RIGHT, before anything else happens.
 *
 * ── THE THREE r362 EXCLUSIONS, WHICH INVERT ────────────────────────────────────────────────────────
 *
 * r362 narrowed three money paths because an imported row was UNCHARGED. r367 makes it charged, so all
 * three are re-derived here, each with its own control:
 *
 *  1. core/leave.ts `applyLeaveCancellationApprovalTx` — narrowed on the LEDGER (`chargedDays > 0`) and
 *     therefore needed NO change. A charged imported record now takes the live branch: the whole-span
 *     debit is reversed and only the survivors are re-debited. The UNCHARGED shape r362 fixed is still
 *     reachable (`openingBalancesAreNet: true`) and still pinned, as is the non-imported row that proves
 *     the guard is about the ledger and not about the import marker.
 *  2. core/payroll.ts `unpaidDaysByEmployment` — excluded on the marker, which is now wrong for a charged
 *     row. Moved to core/leave-charge.ts `leaveDaysAreThisSystems()`: excluded only when imported AND
 *     uncharged. Three cases: the charged import counts, the uncharged import does not, and an ordinary
 *     approved unpaid request that happens to carry no ledger row STILL counts — that last one is what
 *     holds the predicate to the conjunction rather than to a pure ledger test, which would have changed
 *     pay on rows nobody reported.
 *  3. core/leave-encashment.ts `approvedLeaveDaysAfter` — same change, same reasoning, same shape of
 *     evidence.
 *
 * ── AND THE END-TO-END MONEY CASE ──────────────────────────────────────────────────────────────────
 *
 * The last describe block walks the whole path the defect reached: Taken, Balance and the frozen
 * unused-leave figure at resignation, each asserted against a CONTROL employee who was not imported for,
 * so the difference between them is the imported days and nothing else.
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
import {
  approvedLeaveDaysAfter,
  computeEncashableDays,
  encashmentSnapshotForEmployment,
  setEncashmentPolicy,
} from '../core/leave-encashment';
import { decideResignation, submitResignation } from '../core/offboarding';
import { unpaidDaysByEmployment } from '../core/payroll';
import { commitLeaveHistoryImport, validateLeaveHistoryImport } from '../core/leave-history-import';
import { leaveBalances, leaveEntitlementBreakdown, listLeaveRequestsPage } from '../core/read';
import { todayInKualaLumpur } from '../lib/hr-date';
import {
  adminCtx,
  closeAll,
  createAppUser,
  harnessSnapshot,
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
/** The days every three-day case imports. Named so an assertion reads as arithmetic, not as a literal. */
const IMPORTED = 3;

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
/** A sparse row -> the dense record the server actions build. Every contract key present, values strings. */
const recs = (rows: Row[]): Record<string, string>[] =>
  rows.map((r) => Object.fromEntries(HEADERS.map((h) => [h, r[h] ?? ''])));

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

/** The migrated opening balance: a real accrual, so every figure below is measured against something. */
async function openingAccrual(employmentId: string, days = OPENING) {
  await owner.db.insert(schema.leaveLedger).values({
    tenantId: b.tenantId,
    employmentId,
    leaveTypeId: b.annualLeaveTypeId,
    entryType: 'accrual',
    days: `${days}.00`,
    effectiveOn: addDays(TODAY, -365),
  });
}

/** Count of leave_ledger rows for an employment — the strongest form of "no balance moved". */
async function ledgerRowCount(employmentId = subject.employmentId, leaveTypeId?: string): Promise<number> {
  const rows = await owner.db
    .select({ id: schema.leaveLedger.id, typeId: schema.leaveLedger.leaveTypeId })
    .from(schema.leaveLedger)
    .where(eq(schema.leaveLedger.employmentId, employmentId));
  return leaveTypeId ? rows.filter((r) => r.typeId === leaveTypeId).length : rows.length;
}

/** Every ledger row sourced to a leave request, for the subject. The r367 debit is one of these. */
async function sourcedRows(employmentId = subject.employmentId) {
  const rows = await owner.db
    .select({
      id: schema.leaveLedger.id,
      leaveTypeId: schema.leaveLedger.leaveTypeId,
      entryType: schema.leaveLedger.entryType,
      days: schema.leaveLedger.days,
      effectiveOn: schema.leaveLedger.effectiveOn,
      sourceRequestId: schema.leaveLedger.sourceRequestId,
    })
    .from(schema.leaveLedger)
    .where(eq(schema.leaveLedger.employmentId, employmentId))
    // §8: any asserted array from a query needs an ORDER BY.
    .orderBy(schema.leaveLedger.effectiveOn, schema.leaveLedger.id);
  return rows.filter((r) => r.sourceRequestId != null);
}

/** The subject's leave_request rows, oldest start date first. */
async function requestRows(employmentId = subject.employmentId) {
  return owner.db
    .select({
      id: schema.leaveRequest.id,
      status: schema.leaveRequest.status,
      startDate: schema.leaveRequest.startDate,
      days: schema.leaveRequest.days,
      entitlementYear: schema.leaveRequest.entitlementYear,
      importedHistory: schema.leaveRequest.importedHistory,
    })
    .from(schema.leaveRequest)
    .where(eq(schema.leaveRequest.employmentId, employmentId))
    .orderBy(schema.leaveRequest.startDate, schema.leaveRequest.id);
}

/** One three-day past Annual Leave record, with a unique reference. */
const pastAnnual = (over: Row = {}): Record<string, string>[] =>
  recs([
    {
      employee_no: subject.code,
      leave_reference: `LV/MIG/${randomUUID().slice(0, 8)}`,
      leave_code: 'ANNUAL',
      leave_start_date: P_MON,
      leave_end_date: P_WED,
      number_of_day: String(IMPORTED),
      remark: 'Data Migration',
      ...over,
    },
  ]);

/** The Taken and Balance figures the balance screens show for ANNUAL. */
async function annualRow(employmentId = subject.employmentId) {
  const rows = await leaveBalances(adminCtx(b), employmentId);
  return rows.find((r) => r.leaveTypeId === b.annualLeaveTypeId)!;
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
  await openingAccrual(subject.employmentId);
});

describe('the fixture itself, asserted before anything is measured against it', () => {
  it('has a real, non-zero Annual Leave balance and exactly one ledger row', async () => {
    // Guards EVERY case below from the vacuity the header warns about: with a zero opening balance, a
    // balance assertion passes whatever the code does.
    expect(await ledgerBalance(subject.employmentId, b.annualLeaveTypeId)).toBe(OPENING);
    expect(await ledgerRowCount()).toBe(1);
    const row = await annualRow();
    expect(Number(row.balance)).toBe(OPENING);
    expect(Number(row.taken)).toBe(0);
  });
});

describe('r367 DEFAULT — the import takes the days off the balance', () => {
  it('three days of past Annual Leave take exactly three days off, and the debit is sourced to the record', async () => {
    const res = await commitLeaveHistoryImport(adminCtx(b), { records: pastAnnual() });
    expect(res.imported).toBe(1);

    const [req] = await requestRows();
    expect(req.status).toBe('approved');
    expect(req.importedHistory).toBe(true);

    // THE FIX. Not "roughly": exactly 27.00, and it is 30 − 3 rather than a coincidence.
    expect(await ledgerBalance(subject.employmentId, b.annualLeaveTypeId)).toBe(OPENING - IMPORTED);
    expect(await ledgerRowCount()).toBe(2);

    // …and the debit is the shape `finalizeLeaveApproval` writes, because everything downstream depends
    // on that shape: `source_request_id` is what attributes Taken to the filed code, what makes a
    // cancellation reverse it, and what core/leave-charge.ts tests.
    const sourced = await sourcedRows();
    expect(sourced).toHaveLength(1);
    expect(sourced[0].sourceRequestId).toBe(req.id);
    expect(sourced[0].entryType).toBe('debit');
    expect(Number(sourced[0].days)).toBe(-IMPORTED);
    expect(sourced[0].effectiveOn).toBe(P_MON);
    expect(sourced[0].leaveTypeId).toBe(b.annualLeaveTypeId);
  });

  it('the Taken figure on the balance screens moves by exactly the imported days', async () => {
    const before = await annualRow();
    expect(Number(before.taken)).toBe(0);
    expect(Number(before.balance)).toBe(OPENING);

    await commitLeaveHistoryImport(adminCtx(b), { records: pastAnnual() });

    const after = await annualRow();
    // The reporter's screenshot read TAKEN 0.00 beside six records that plainly existed. This is that
    // screen, and this is the figure that was wrong.
    expect(Number(after.taken)).toBe(Number(before.taken) + IMPORTED);
    expect(Number(after.balance)).toBe(Number(before.balance) - IMPORTED);
  });

  it('both tabs read the same record: it is in Employee Leave Record AND in the Taken figure', async () => {
    await commitLeaveHistoryImport(adminCtx(b), { records: pastAnnual() });

    // Employee Leave Record, narrowed exactly as its page narrows it.
    const page = await listLeaveRequestsPage(adminCtx(b), {
      employmentIds: [subject.employmentId],
      leaveTypeIds: [b.annualLeaveTypeId],
      limit: 50,
      offset: 0,
    });
    expect(page.total).toBe(1);
    expect(Number(page.rows[0].days)).toBe(IMPORTED);

    // …and Employee Balances, for the same employee and the same code.
    expect(Number((await annualRow()).taken)).toBe(IMPORTED);
  });

  it('a row that cannot be written leaves NO orphan debit: each record writes both halves or neither', async () => {
    // The debit goes in the SAME per-row transaction as the record. A second row naming an employee
    // that does not exist is rejected outright, so exactly one record and exactly one debit are written —
    // the pairing, asserted by count rather than assumed from the code.
    const res = await commitLeaveHistoryImport(adminCtx(b), {
      records: [...pastAnnual(), ...pastAnnual({ employee_no: 'NO-SUCH-EMPLOYEE' })],
    });
    expect(res.imported).toBe(1);
    expect(res.failed).toBe(1);
    expect(await requestRows()).toHaveLength(1);
    expect(await sourcedRows()).toHaveLength(1);
    expect(await ledgerBalance(subject.employmentId, b.annualLeaveTypeId)).toBe(OPENING - IMPORTED);
  });
});

describe('r362 PRESERVED — openingBalancesAreNet: true moves nothing', () => {
  it('writes the record and NO ledger row at all, and the balance is exactly the opening figure', async () => {
    const res = await commitLeaveHistoryImport(adminCtx(b), {
      records: pastAnnual(),
      openingBalancesAreNet: true,
    });
    expect(res.imported).toBe(1);
    const [req] = await requestRows();
    expect(req.status).toBe('approved');

    // Untouched, to the day — and not because a debit and a credit cancelled out: no row was written.
    expect(await ledgerBalance(subject.employmentId, b.annualLeaveTypeId)).toBe(OPENING);
    expect(await ledgerRowCount()).toBe(1);
    expect(await sourcedRows()).toHaveLength(0);
  });

  it('…and the Taken figure does not move either, which is what that answer means', async () => {
    await commitLeaveHistoryImport(adminCtx(b), { records: pastAnnual(), openingBalancesAreNet: true });
    const row = await annualRow();
    expect(Number(row.taken)).toBe(0);
    expect(Number(row.balance)).toBe(OPENING);
  });

  it('the option is read from THIS call, not from the preview: the two answers write different things', async () => {
    // Same file, same tenant, two runs. The only difference is the answer, and the balance proves it was
    // the answer that decided — a default that silently won would make one of these two assertions fail.
    await commitLeaveHistoryImport(adminCtx(b), { records: pastAnnual(), openingBalancesAreNet: true });
    expect(await ledgerBalance(subject.employmentId, b.annualLeaveTypeId)).toBe(OPENING);
    await commitLeaveHistoryImport(adminCtx(b), { records: pastAnnual(), openingBalancesAreNet: false });
    expect(await ledgerBalance(subject.employmentId, b.annualLeaveTypeId)).toBe(OPENING - IMPORTED);
  });
});

describe('the balance-impact preview, which is what nobody had before Confirm import', () => {
  it('states the records, the days and the balance either side of the import', async () => {
    const p = await validateLeaveHistoryImport(adminCtx(b), { records: pastAnnual() });
    expect(p.deducts).toBe(true);
    expect(p.balanceImpact).toHaveLength(1);
    const [impact] = p.balanceImpact;
    expect(impact.employeeNo).toBe(subject.code);
    expect(impact.employeeName).toBe('Balance Subject');
    expect(impact.leaveCode).toBe('ANNUAL');
    expect(impact.records).toBe(1);
    expect(impact.days).toBe(IMPORTED);
    expect(impact.balanceBefore).toBe(OPENING);
    expect(impact.balanceAfter).toBe(OPENING - IMPORTED);
    expect(impact.goesNegative).toBe(false);
    // A preview writes nothing.
    expect(await ledgerRowCount()).toBe(1);
  });

  it('the preview figure is the figure the commit produces — one derivation, not two', async () => {
    const p = await validateLeaveHistoryImport(adminCtx(b), { records: pastAnnual() });
    const promised = p.balanceImpact[0].balanceAfter;
    // Re-validate the SAME references would be duplicates, so the commit uses its own fresh file.
    const p2 = await validateLeaveHistoryImport(adminCtx(b), { records: pastAnnual() });
    expect(p2.balanceImpact[0].balanceAfter).toBe(promised);
    await commitLeaveHistoryImport(adminCtx(b), { records: pastAnnual() });
    expect(await ledgerBalance(subject.employmentId, b.annualLeaveTypeId)).toBe(promised);
  });

  it('flags a line that would take a balance below zero rather than doing it quietly', async () => {
    // The reporter's own Annual Leave line: 0.00 earned so far this year, so deducting takes it negative.
    const other = await hire('No Balance Yet');
    const p = await validateLeaveHistoryImport(adminCtx(b), {
      records: recs([
        {
          employee_no: other.code,
          leave_reference: `LV/MIG/${randomUUID().slice(0, 8)}`,
          leave_code: 'ANNUAL',
          leave_start_date: P_MON,
          leave_end_date: P_WED,
          number_of_day: '11',
        },
      ]),
    });
    expect(p.balanceImpact).toHaveLength(1);
    expect(p.balanceImpact[0].balanceBefore).toBe(0);
    expect(p.balanceImpact[0].balanceAfter).toBe(-11);
    expect(p.balanceImpact[0].goesNegative).toBe(true);
    // Flagged, NOT refused: an employee who really took more than they had earned is a fact about the
    // past, and a migration that rejected the row would lose real history.
    expect(p.rows[0].status).toBe('valid');
  });

  it('counts only the rows that will be written — an error row and a duplicate move nothing', async () => {
    const dup = `LV/MIG/${randomUUID().slice(0, 8)}`;
    await commitLeaveHistoryImport(adminCtx(b), {
      records: pastAnnual({ leave_reference: dup }),
      openingBalancesAreNet: true,
    });
    const p = await validateLeaveHistoryImport(adminCtx(b), {
      records: [
        ...pastAnnual({ leave_reference: dup }), // already imported ⇒ duplicate
        ...pastAnnual({ leave_code: 'NO-SUCH-CODE' }), // ⇒ error
        ...pastAnnual(), // ⇒ the only writable row
      ],
    });
    expect(p.duplicateCount).toBe(1);
    expect(p.errorCount).toBe(1);
    expect(p.validCount).toBe(1);
    expect(p.balanceImpact).toHaveLength(1);
    expect(p.balanceImpact[0].records).toBe(1);
    expect(p.balanceImpact[0].days).toBe(IMPORTED);
  });

  it('says nothing will move when the answer is that the balances are already net', async () => {
    const p = await validateLeaveHistoryImport(adminCtx(b), {
      records: pastAnnual(),
      openingBalancesAreNet: true,
    });
    expect(p.deducts).toBe(false);
    expect(p.balanceImpact).toEqual([]);
    // …and the rows are still previewed: the option decides the balance, never what is importable.
    expect(p.validCount).toBe(1);
  });
});

describe('the entitlement year is filled from the cycle the start date falls in', () => {
  it('a blank Entitlement Year column is stored as the cycle year, and the preview shows it', async () => {
    const p = await validateLeaveHistoryImport(adminCtx(b), { records: pastAnnual({ entitlement_year: '' }) });
    await commitLeaveHistoryImport(adminCtx(b), { records: pastAnnual({ entitlement_year: '' }) });
    const [req] = await requestRows();

    // The figure is not invented: it is the year of the entitlement CYCLE the start date falls in, which
    // is exactly what Employee Balances prints in its Ent. year column (rows.ts: bd.cycleStart.slice(0,4)).
    const bd = await leaveEntitlementBreakdown(adminCtx(b), subject.employmentId, b.annualLeaveTypeId, P_MON);
    expect(bd).not.toBeNull();
    expect(req.entitlementYear).toBe(Number(bd!.cycleStart.slice(0, 4)));
    // …and the preview stated the same thing before the write, rather than an empty cell.
    expect(p.rows[0].entitlementYear).toBe(bd!.cycleStart.slice(0, 4));
  });

  it('a stated Entitlement Year is still stored verbatim — the fill is for a BLANK column only', async () => {
    const stated = String(Number(P_MON.slice(0, 4)) - 1);
    await commitLeaveHistoryImport(adminCtx(b), { records: pastAnnual({ entitlement_year: stated }) });
    const [req] = await requestRows();
    expect(req.entitlementYear).toBe(Number(stated));
  });
});

describe('EXCLUSION 1 — cancelling an imported record (core/leave.ts applyLeaveCancellationApprovalTx)', () => {
  /**
   * A migration legitimately carries an APPROVED FUTURE leave: someone booked next month's holiday in the
   * system being replaced. That is the shape that makes the give-back path reachable, because the notice
   * period is counted from today — so it is the shape these cases use.
   */
  async function importFutureWeek(openingBalancesAreNet = false): Promise<string> {
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
      openingBalancesAreNet,
    });
    const rows = await requestRows();
    return rows[0].id;
  }

  async function allowEmployeeCancellation() {
    await updateLeaveType(adminCtx(b), {
      id: b.annualLeaveTypeId,
      name: 'Annual Leave',
      employeeCancelApproved: true,
      cancelAutoApprove: true,
      cancelNoticeDays: 0,
    });
  }

  it('CHARGED: a whole give-back returns exactly the imported days — the guard needed no change', async () => {
    const id = await importFutureWeek();
    expect(await ledgerBalance(subject.employmentId, b.annualLeaveTypeId)).toBe(OPENING - 5);
    await allowEmployeeCancellation();

    const out = await requestLeaveCancellation(subjectCtx, {
      leaveRequestId: id,
      cancelDates: [MON, TUE, WED, THU, FRI],
      today: TODAY,
    });
    expect(out.status).toBe('approved');
    // Back to the opening figure: the debit r367 wrote was reversed, in full and only once.
    expect(await ledgerBalance(subject.employmentId, b.annualLeaveTypeId)).toBe(OPENING);
  });

  it('CHARGED: a PARTIAL give-back returns only the cancelled day and keeps the survivors charged', async () => {
    const id = await importFutureWeek();
    await allowEmployeeCancellation();

    await requestLeaveCancellation(subjectCtx, { leaveRequestId: id, cancelDates: [WED], today: TODAY });

    // One day back out of five: 30 − 5 + 1 = 26. The survivors stay charged, which is what the whole
    // reverse-then-re-debit dance in applyLeaveCancellationApprovalTx is for.
    expect(
      await ledgerBalance(subject.employmentId, b.annualLeaveTypeId),
      'a charged imported record must give back the cancelled day and only that day',
    ).toBe(OPENING - 4);
    const rows = await requestRows();
    expect(rows.some((r) => r.status === 'cancelled' && r.startDate === WED)).toBe(true);
    expect(rows.some((r) => r.status === 'approved')).toBe(true);
  });

  it('UNCHARGED (openingBalancesAreNet): a partial give-back still debits nothing — r362’s fix, kept', async () => {
    const id = await importFutureWeek(true);
    expect(await ledgerRowCount()).toBe(1);
    await allowEmployeeCancellation();

    // Before r362 this reversed 0.00 (correctly, nothing was charged) and then inserted a brand-new
    // −4.00 debit for the surviving segment, so 30 became 26 — four days off a balance that had never
    // been charged for this leave at all.
    const out = await requestLeaveCancellation(subjectCtx, { leaveRequestId: id, cancelDates: [WED], today: TODAY });
    expect(out.status).toBe('approved');
    expect(
      await ledgerBalance(subject.employmentId, b.annualLeaveTypeId),
      'giving one day back out of an uncharged request must not debit the other four',
    ).toBe(OPENING);
    expect(await ledgerRowCount(), 'no ledger row at all should have been written').toBe(1);
  });

  it('the guard tests the LEDGER, not the import marker: any uncharged approved row is safe', async () => {
    // The fix must not be "imported rows are special". It is "re-debit only what was charged", and this
    // case is what makes that difference observable: an ordinary approved request — NOT imported,
    // `imported_history` false — that happens to carry no sourced ledger debit. A round that narrowed the
    // guard to `importedHistory` would pass every case above and fail this one.
    await allowEmployeeCancellation();
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

describe('EXCLUSION 2 — unpaid days payroll deducts (core/payroll.ts unpaidDaysByEmployment)', () => {
  let uplId: string;
  let uplCode: string;
  let periodStart: string;
  let periodEnd: string;

  beforeEach(async () => {
    uplCode = `UPL${randomUUID().slice(0, 4).toUpperCase()}`;
    const created = await createLeaveType(adminCtx(b), { code: uplCode, name: 'Unpaid Leave', paid: false });
    uplId = created.id;
    periodStart = `${P_MON.slice(0, 7)}-01`;
    periodEnd = addDays(periodStart, 30);
  });

  const unpaidDays = () =>
    withTenant(adminCtx(b), (tx) => unpaidDaysByEmployment(tx, periodStart, periodEnd));

  /** An ordinary approved unpaid request, inserted directly and carrying NO ledger row. */
  async function ordinaryUnpaidRequest() {
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
  }

  const importUnpaid = (openingBalancesAreNet: boolean) =>
    commitLeaveHistoryImport(adminCtx(b), {
      records: pastAnnual({ leave_code: uplCode }),
      openingBalancesAreNet,
    });

  it('the control: an ordinary approved unpaid request IS deducted', async () => {
    await ordinaryUnpaidRequest();
    expect((await unpaidDays()).get(subject.employmentId), 'the control row must be deducted').toBe(1);
  });

  it('UNCHARGED import is NOT deducted — a migration tool must not move pay (r362, kept)', async () => {
    await ordinaryUnpaidRequest();
    await importUnpaid(true);
    expect(
      (await unpaidDays()).get(subject.employmentId),
      'importing three days of past unpaid leave must not cut this month’s salary',
    ).toBe(1);
  });

  it('⚠️ CHARGED import IS deducted — the exclusion r367 had to invert', async () => {
    await ordinaryUnpaidRequest();
    await importUnpaid(false);
    // The days really are in the ledger now, sourced to an approved unpaid-type request. Leaving them out
    // of the pay they reduce would be the NEW defect: r362's exclusion was about UNCHARGED rows, and this
    // row is charged.
    expect(
      (await unpaidDays()).get(subject.employmentId),
      'a charged imported unpaid record must be deducted like any other approved unpaid request',
    ).toBe(1 + IMPORTED);
  });

  it('⚠️ AND A NON-IMPORTED ROW WITH NO LEDGER DEBIT IS STILL DEDUCTED — the predicate is the conjunction', async () => {
    // This is the case that stops the next round "simplifying" core/leave-charge.ts into a pure ledger
    // test. `ordinaryUnpaidRequest` writes NO ledger row (it is inserted directly, exactly as a row
    // written by older code or by a data fix would be). A pure `NOT EXISTS (sourced debit)` exclusion
    // would drop it, and a salary would move on a row nobody reported.
    await ordinaryUnpaidRequest();
    expect(await sourcedRows()).toHaveLength(0);
    expect((await unpaidDays()).get(subject.employmentId)).toBe(1);
  });
});

describe('EXCLUSION 3 — the final-pay hint (core/leave-encashment.ts approvedLeaveDaysAfter)', () => {
  const lastWorkingDay = TODAY;
  const daysAfter = () =>
    withTenant(adminCtx(b), (tx) =>
      approvedLeaveDaysAfter(tx, subject.employmentId, b.annualLeaveTypeId, lastWorkingDay),
    );

  /** An ORDINARY approved request after the last working day — the control. */
  async function ordinaryFutureLeave() {
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
  }

  const importFutureAnnual = (openingBalancesAreNet: boolean) =>
    commitLeaveHistoryImport(adminCtx(b), {
      records: pastAnnual({ leave_start_date: TUE, leave_end_date: THU }),
      openingBalancesAreNet,
    });

  it('the control: an ordinary future approved leave raises the hint', async () => {
    await ordinaryFutureLeave();
    expect(await daysAfter(), 'an ordinary future approved leave must still raise the hint').toBe(1);
  });

  it('UNCHARGED import raises no hint — its premise is false and its remedy gives nothing back (r362, kept)', async () => {
    await ordinaryFutureLeave();
    await importFutureAnnual(true);
    expect(await daysAfter(), 'uncharged imported history must not be added to the final-pay hint').toBe(1);
  });

  it('⚠️ CHARGED import DOES raise the hint — the premise is now true and the remedy now works', async () => {
    await ordinaryFutureLeave();
    await importFutureAnnual(false);
    // These days ARE debited and will never be taken, which is exactly what this hint exists to name —
    // in the one figure that is paid out. And cancelling the request now genuinely reverses a charge, so
    // the documented remedy closes instead of looping.
    expect(
      await daysAfter(),
      'a charged imported record after the last working day is a debited day that cannot be taken',
    ).toBe(1 + IMPORTED);
  });
});

describe('THE MONEY: what the missing debit was doing to final pay', () => {
  /**
   * The whole defect, end to end, measured against a CONTROL employee who has the same opening balance
   * and no import — so the difference between the two figures is the imported days and nothing else.
   *
   * `core/leave-encashment.ts` freezes unused Annual Leave at resignation off `ledgerBalanceOf`, the same
   * signed ledger sum every balance screen shows. A missing debit therefore left the frozen figure — the
   * one that is PAID — high by exactly the days that had been recorded and never deducted.
   */
  async function resignAndFreeze(employmentId: string, personId: string) {
    const u = await createAppUser(b.tenantId, personId, 'employee');
    const asEmployee: SessionContext = {
      tenantId: b.tenantId,
      userId: u,
      roles: ['employee'],
      personId,
      entitlements: harnessSnapshot(b.tenantId),
    };
    const res = await submitResignation(asEmployee, {
      employmentId,
      lastWorkingDay: addDays(TODAY, 30),
      today: TODAY,
    });
    await decideResignation(adminCtx(b), { requestId: res.requestId, decision: 'accepted' });
    return encashmentSnapshotForEmployment(adminCtx(b), employmentId);
  }

  it('Taken, Balance and the frozen encashable figure all move by exactly the imported days', async () => {
    await setEncashmentPolicy(adminCtx(b), { companyId: b.companyId, enabled: true, autoFreeze: true });

    // The control: same opening balance, nothing imported.
    const control = await hire('Encashment Control');
    await openingAccrual(control.employmentId);
    expect(await ledgerBalance(control.employmentId, b.annualLeaveTypeId)).toBe(OPENING);

    // The subject: three days of past Annual Leave imported, with the balances NOT already net.
    await commitLeaveHistoryImport(adminCtx(b), { records: pastAnnual() });

    const subjRow = await annualRow();
    const ctrlRow = await annualRow(control.employmentId);
    expect(Number(ctrlRow.taken)).toBe(0);
    expect(Number(ctrlRow.balance)).toBe(OPENING);
    expect(Number(subjRow.taken)).toBe(IMPORTED);
    expect(Number(subjRow.balance)).toBe(OPENING - IMPORTED);

    const subjSnap = await resignAndFreeze(subject.employmentId, subject.personId);
    const ctrlSnap = await resignAndFreeze(control.employmentId, control.personId);
    expect(subjSnap).not.toBeNull();
    expect(ctrlSnap).not.toBeNull();

    // The control is paid for its whole balance; the subject for three days fewer. Absolute figures AND
    // the difference, so neither a wrong constant nor a wrong delta can pass.
    expect(ctrlSnap!.balanceDays).toBe(OPENING);
    expect(ctrlSnap!.encashableDays).toBe(computeEncashableDays(OPENING));
    expect(subjSnap!.balanceDays).toBe(OPENING - IMPORTED);
    expect(subjSnap!.encashableDays).toBe(computeEncashableDays(OPENING - IMPORTED));
    expect(
      ctrlSnap!.encashableDays - subjSnap!.encashableDays,
      'the final payment must be lower by exactly the days that were imported',
    ).toBe(IMPORTED);
  });

  it('…and answering "my balances are already net" pays the control figure, on purpose', async () => {
    await setEncashmentPolicy(adminCtx(b), { companyId: b.companyId, enabled: true, autoFreeze: true });
    await commitLeaveHistoryImport(adminCtx(b), { records: pastAnnual(), openingBalancesAreNet: true });
    const snap = await resignAndFreeze(subject.employmentId, subject.personId);
    // Correct for that answer: the opening balance already had those days removed, so the ledger is
    // right as it stands and the payment is right too. This is the case that would have been BROKEN by
    // "always deduct", which is why the option exists rather than a one-way change.
    expect(snap!.balanceDays).toBe(OPENING);
    expect(snap!.encashableDays).toBe(computeEncashableDays(OPENING));
  });
});
