/**
 * 690d4400 — Unpaid Leave showed Taken 0.00 after approval, and the column was faithfully reporting the
 * wrong quantity.
 *
 * THE CAUSE, not a guess. `finalizeLeaveApproval` writes the ledger debit as `-(approvedDays - unpaidDays)`
 * — only the part that came OUT OF A BALANCE. For a fully unpaid leave those are equal, so the debit row is
 * written with 0.00 days. The row EXISTS; it is zero. A Taken column derived from debits then reports 0.00
 * for someone who was absent all week, which is what the reporter saw.
 *
 * So the fix is not "make UPL special". `taken` now means ABSENCE for every leave code — debit + unpaid —
 * which also repairs a case the reporter had not hit: a PAID leave that went part-unpaid because the
 * balance ran out. Those unpaid days used to vanish from Taken too.
 *
 * ⚠️ WHAT THIS DELIBERATELY BREAKS, AND WHY IT IS STILL RIGHT. 39136455 (r306) shipped Share / Pending
 * Share on the promise that Balance = Brought Forward + Entitlement + Share − Taken − Pending − Pending
 * Share. That identity held only because `taken` was balance-spend. It now holds for fully-paid leave and
 * NOT for part-unpaid leave, because absence legitimately exceeds what came off the balance. The plan put
 * that trade to the reporter in writing before it was built, and BALANCE ITSELF IS UNAFFECTED: it is
 * `sum(leave_ledger.days)` and is never re-derived from these columns (6574c6b4 — re-deriving it once
 * turned a true +14 into −14).
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { and, eq, sql } from 'drizzle-orm';
import * as schema from '../db/schema';
import { adminCtx, closeAll, migrateTestDb, owner, resetDb, seedBase, seedEntitlement, type Base } from './harness';
import { hireEmployee } from '../core/org';
import { leaveBalances } from '../core/read';
import { decideLeave, requestLeave } from '../core/leave';

let b: Base;
const uniq = (p: string) => `${p} ${randomUUID().slice(0, 6)}`;

async function leaveTypeRow(opts: { name?: string; paid?: boolean } = {}) {
  const [row] = await owner.db
    .insert(schema.leaveType)
    .values({
      tenantId: b.tenantId,
      code: `U${randomUUID().slice(0, 6).toUpperCase()}`,
      name: opts.name ?? uniq('Unpaid Leave'),
      paid: opts.paid ?? false,
      counting: 'calendar_days',
      // THE SHAPE THE REPORTER ACTUALLY HAS. `allow_unpaid_leave` is what makes a request with no balance
      // behind it become UNPAID (unpaidDays = days − available, core/leave.ts ~:3683) instead of being
      // refused outright. Without it the submit guard throws InsufficientLeaveBalanceOnSubmitError and no
      // unpaid day is ever recorded — so the fixture would not reproduce the fault at all.
      allowUnpaidLeave: true,
    })
    .returning({ id: schema.leaveType.id });
  return row.id;
}

const hire = () =>
  hireEmployee(adminCtx(b), {
    person: { fullName: 'UPL Emp', primaryEmail: `upl_${randomUUID().slice(0, 8)}@t.local` },
    companyId: b.companyId,
    departmentId: b.deptA,
    employmentType: 'full_time',
    hiredOn: '2020-01-01',
  });

const ledgerTotal = async (employmentId: string, leaveTypeId: string) => {
  const [r] = await owner.db
    .select({ n: sql<string>`coalesce(sum(${schema.leaveLedger.days}), 0)` })
    .from(schema.leaveLedger)
    .where(
      and(eq(schema.leaveLedger.employmentId, employmentId), eq(schema.leaveLedger.leaveTypeId, leaveTypeId)),
    );
  return Number(r.n);
};

const rowFor = async (employmentId: string, leaveTypeId: string) => {
  const rows = await leaveBalances(adminCtx(b), employmentId, 'en', { includeHidden: true });
  return rows.find((r) => r.leaveTypeId === leaveTypeId);
};

beforeAll(async () => {
  await migrateTestDb();
});
afterAll(async () => {
  await closeAll();
});
beforeEach(async () => {
  await resetDb();
  b = await seedBase();
});

describe('690d4400 · the reported fault', () => {
  it('an approved leave on a type with NO entitlement shows the days taken, not 0.00', async () => {
    const upl = await leaveTypeRow({ name: uniq('Unpaid Leave') });
    const { employmentId } = await hire();
    const ctx = adminCtx(b);

    const req = await requestLeave(ctx, {
      employmentId,
      leaveTypeId: upl,
      startDate: '2026-06-01',
      endDate: '2026-06-05',
      today: '2026-05-01',
    });
    await decideLeave(ctx, { leaveRequestId: req.leaveRequestId, decision: 'approved' });

    const row = await rowFor(employmentId, upl);
    expect(row, 'the type must still appear on Employee Balances').toBeTruthy();
    // THE REGRESSION ARM. Before this item the ledger debit was 0.00 and this read 0.00.
    expect(row!.taken, 'five days away is five days taken').toBe(5);
  });

  /**
   * NON-VACUITY, from the other side: the LEDGER is still 0.00 for that leave, because unpaid leave really
   * does take nothing out of a balance. If this ever reads −5 the fix has started moving balances, which is
   * the one thing it must not do.
   */
  it('and the ledger still moved NOTHING — unpaid leave costs no balance', async () => {
    const upl = await leaveTypeRow({ name: uniq('Unpaid Leave') });
    const { employmentId } = await hire();
    const ctx = adminCtx(b);

    const before = await ledgerTotal(employmentId, upl);
    const req = await requestLeave(ctx, {
      employmentId,
      leaveTypeId: upl,
      startDate: '2026-06-01',
      endDate: '2026-06-05',
      today: '2026-05-01',
    });
    await decideLeave(ctx, { leaveRequestId: req.leaveRequestId, decision: 'approved' });

    expect(await ledgerTotal(employmentId, upl), 'the balance is untouched, as unpaid means').toBe(before);
    expect((await rowFor(employmentId, upl))!.balance, 'and the Balance column with it').toBe(before);
  });

  it('a PENDING unpaid leave is not Taken yet — it is Pending Approval', async () => {
    const upl = await leaveTypeRow({ name: uniq('Unpaid Leave') });
    const { employmentId } = await hire();

    await requestLeave(adminCtx(b), {
      employmentId,
      leaveTypeId: upl,
      startDate: '2026-06-01',
      endDate: '2026-06-03',
      today: '2026-05-01',
    });

    const row = await rowFor(employmentId, upl);
    expect(row!.taken, 'nothing is taken until it is approved').toBe(0);
    expect(row!.pending).toBe(3);
  });

  it('a REJECTED unpaid leave counts as nothing at all', async () => {
    const upl = await leaveTypeRow({ name: uniq('Unpaid Leave') });
    const { employmentId } = await hire();
    const ctx = adminCtx(b);

    const req = await requestLeave(ctx, {
      employmentId,
      leaveTypeId: upl,
      startDate: '2026-06-01',
      endDate: '2026-06-03',
      today: '2026-05-01',
    });
    await decideLeave(ctx, { leaveRequestId: req.leaveRequestId, decision: 'rejected', rejectReason: 'not approved' });

    const row = await rowFor(employmentId, upl);
    expect(row!.taken).toBe(0);
    expect(row!.pending).toBe(0);
  });
});

describe('690d4400 · a PAID type is unaffected, which is what keeps the change honest', () => {
  it('an ordinary paid leave still reports the same Taken it always did, and still spends the balance', async () => {
    const annual = b.annualLeaveTypeId;
    await seedEntitlement(adminCtx(b), { leaveTypeId: annual, annualDays: 14, validFrom: '2026-01-01' });
    const { employmentId } = await hire();
    const ctx = adminCtx(b);

    await owner.db.insert(schema.leaveLedger).values({
      tenantId: b.tenantId,
      employmentId,
      leaveTypeId: annual,
      entryType: 'accrual',
      days: '14.00',
      effectiveOn: '2026-01-01',
    });

    const req = await requestLeave(ctx, {
      employmentId,
      leaveTypeId: annual,
      startDate: '2026-06-01',
      endDate: '2026-06-03',
      today: '2026-05-01',
    });
    await decideLeave(ctx, { leaveRequestId: req.leaveRequestId, decision: 'approved' });

    const row = await rowFor(employmentId, annual);
    expect(row!.taken, 'three paid days taken').toBe(3);
    // Fully paid ⇒ absence and balance-spend are the same number, so the r306 identity still closes here.
    expect(row!.balance, 'and three days came off the balance').toBe(11);
    expect(row!.balance).toBe(row!.accrued - row!.taken);
  });
});
