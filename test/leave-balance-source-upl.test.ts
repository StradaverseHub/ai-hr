/**
 * Balance Deduction Source (feedback cdf9ca48) + Allow Unpaid Leave / UPL (feedback a7fab30b).
 *
 * Two settings, built and tested together because the combination is the case that has no answer unless both
 * exist: a leave type that BORROWS another type's balance and ALSO allows unpaid leave must measure its
 * unpaid overflow against the BORROWED balance.
 *
 * cdf9ca48 — leave_type.balance_source_type_id. NULL (default) = the type spends its own balance, exactly as
 * before. Set = the submit-time guard, the approval-time gate, the approval ledger debit and every reversal
 * all move to the source type's ledger, while the leave_request row (and therefore leave history) still names
 * the type the employee applied for. updateLeaveType refuses self-reference and chains in either direction.
 *
 * a7fab30b — leave_type.allow_unpaid_leave. false (default) = the existing allow_negative_balance rule
 * decides. true = the application goes through, and the days the balance could not cover are recorded on
 * leave_request.unpaid_days: the ledger debits only the covered part, and payroll deducts the rest through
 * its existing unpaid-leave route. A PART-covered request splits — it is never all-or-nothing.
 *
 * Harness note (mirrors leave-negative-balance.test.ts): requestLeave's WITH CHECK RLS is
 * app.can_see_employment(employment_id), so the applicant ctx must OWN the employmentId. Balance is seeded by
 * inserting an `accrual` leave_ledger row (owner db, bypasses RLS).
 */
import { randomUUID } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import * as schema from '../db/schema';
import { hireEmployee } from '../core/org';
import {
  requestLeave,
  editLeaveRequest,
  decideLeave,
  adminCancelLeave,
  availableLeaveBalance,
  leaveBalance,
  previewLeaveDeduction,
  leaveTypeApplySummary,
  InsufficientLeaveBalanceOnSubmitError,
} from '../core/leave';
import { unpaidLeaveDaysForPeriod } from '../core/payroll';
import { updateLeaveType } from '../core/admin';
import { listLeaveTypes } from '../core/read';
import { withTenant } from '../db/client';
import type { SessionContext } from '../db/client';
import {
  adminCtx,
  closeAll,
  createAppUser,
  latestEventPayload,
  migrateTestDb,
  owner,
  resetDb,
  seedBase,
  type Base,
} from './harness';

let b: Base;

async function hireEmployeeCtx(): Promise<{ ctx: SessionContext; employmentId: string }> {
  const { employmentId, personId } = await hireEmployee(adminCtx(b), {
    person: { fullName: 'Src', primaryEmail: `src_${randomUUID().slice(0, 8)}@t.local` },
    companyId: b.companyId,
    departmentId: b.deptA,
    employmentType: 'full_time',
    hiredOn: '2020-01-01',
  });
  const userId = await createAppUser(b.tenantId, personId, 'employee');
  return { ctx: { tenantId: b.tenantId, userId, roles: ['employee'], personId }, employmentId };
}

function uniq(prefix: string): string {
  return `${prefix}_${randomUUID().slice(0, 8).toUpperCase().replace(/-/g, '')}`;
}

/** Calendar-counted leave type so day math is trivial (1 calendar day == 1 leave day). */
async function leaveType(
  opts: { balanceSourceTypeId?: string; allowUnpaidLeave?: boolean; allowNegativeBalance?: boolean } = {},
): Promise<string> {
  const [row] = await owner.db
    .insert(schema.leaveType)
    .values({
      tenantId: b.tenantId,
      code: uniq('SRC'),
      name: uniq('Src'),
      paid: true,
      counting: 'calendar_days',
      ...opts,
    })
    .returning({ id: schema.leaveType.id });
  return row.id;
}

async function grant(employmentId: string, leaveTypeId: string, days: number): Promise<void> {
  await owner.db.insert(schema.leaveLedger).values({
    tenantId: b.tenantId,
    employmentId,
    leaveTypeId,
    entryType: 'accrual',
    days: days.toFixed(2),
    effectiveOn: '2020-01-01',
  });
}

async function requestRow(id: string) {
  const [row] = await owner.db.select().from(schema.leaveRequest).where(eq(schema.leaveRequest.id, id));
  return row;
}

/** The ledger rows this request produced, by leave type — the fact the whole feature turns on. */
async function ledgerFor(requestId: string): Promise<{ leaveTypeId: string; days: number }[]> {
  const rows = await owner.db
    .select({ leaveTypeId: schema.leaveLedger.leaveTypeId, days: schema.leaveLedger.days })
    .from(schema.leaveLedger)
    .where(eq(schema.leaveLedger.sourceRequestId, requestId));
  return rows.map((r) => ({ leaveTypeId: r.leaveTypeId, days: Number(r.days) }));
}

async function typeName(id: string): Promise<string> {
  const [row] = await owner.db.select({ name: schema.leaveType.name }).from(schema.leaveType).where(eq(schema.leaveType.id, id));
  return row.name;
}

// A single calendar day == 1 leave day for a calendar_days type.
const D1 = '2026-06-01';
const D2 = '2026-06-02';
const D3 = '2026-06-03'; // 3-day span D1..D3 inclusive
const D5 = '2026-06-05'; // 5-day span D1..D5 inclusive

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

describe('cdf9ca48 · balance_source_type_id — schema default & persistence', () => {
  it('defaults to NULL ⇒ the type spends its own balance (every existing row unchanged)', async () => {
    const id = await leaveType();
    const [row] = await owner.db
      .select({ v: schema.leaveType.balanceSourceTypeId, upl: schema.leaveType.allowUnpaidLeave })
      .from(schema.leaveType)
      .where(eq(schema.leaveType.id, id));
    expect(row.v).toBeNull();
    expect(row.upl).toBe(false);
  });

  it('updateLeaveType persists both settings and records before/after on leave-type.updated', async () => {
    const annual = await leaveType();
    const emergency = await leaveType();
    const name = await typeName(emergency);
    await updateLeaveType(adminCtx(b), { id: emergency, name, balanceSourceTypeId: annual, allowUnpaidLeave: true });
    const [after] = await owner.db
      .select({ src: schema.leaveType.balanceSourceTypeId, upl: schema.leaveType.allowUnpaidLeave })
      .from(schema.leaveType)
      .where(eq(schema.leaveType.id, emergency));
    expect(after.src).toBe(annual);
    expect(after.upl).toBe(true);
    const payload = (await latestEventPayload(b.tenantId, emergency, 'leave-type.updated')) as {
      before: Record<string, unknown>;
      after: Record<string, unknown>;
    };
    expect(payload.before.balanceSourceTypeId).toBeNull();
    expect(payload.after.balanceSourceTypeId).toBe(annual);
    expect(payload.before.allowUnpaidLeave).toBe(false);
    expect(payload.after.allowUnpaidLeave).toBe(true);
  });

  it('surfaces both settings on listLeaveTypes so the admin panel round-trips them', async () => {
    const annual = await leaveType();
    const emergency = await leaveType({ balanceSourceTypeId: annual, allowUnpaidLeave: true });
    const rows = await listLeaveTypes(adminCtx(b), {});
    const row = rows.find((r) => r.id === emergency);
    expect(row?.balanceSourceTypeId).toBe(annual);
    expect(row?.allowUnpaidLeave).toBe(true);
  });

  it('a save from another sub-form leaves both columns untouched (tri-state)', async () => {
    const annual = await leaveType();
    const emergency = await leaveType({ balanceSourceTypeId: annual, allowUnpaidLeave: true });
    const name = await typeName(emergency);
    // 9861b8a4 — the negative-balance sub-form must post its floor alongside the switch. This test is
    // about the OTHER columns staying untouched, so the pair is supplied and the assertions below are
    // unchanged: a save from one sub-form still leaves balance source and unpaid-leave alone.
    await updateLeaveType(adminCtx(b), {
      id: emergency,
      name,
      allowNegativeBalance: true,
      maxNegativeBalance: 5,
    });
    const [after] = await owner.db
      .select({ src: schema.leaveType.balanceSourceTypeId, upl: schema.leaveType.allowUnpaidLeave })
      .from(schema.leaveType)
      .where(eq(schema.leaveType.id, emergency));
    expect(after.src).toBe(annual);
    expect(after.upl).toBe(true);
  });
});

describe('cdf9ca48 · configuration validation — no self-reference, no chains', () => {
  it('refuses a leave type pointing at itself', async () => {
    const id = await leaveType();
    await expect(
      updateLeaveType(adminCtx(b), { id, name: await typeName(id), balanceSourceTypeId: id }),
    ).rejects.toThrow(/cannot deduct from itself/i);
  });

  it('refuses a source that itself deducts from another type (no chains)', async () => {
    const annual = await leaveType();
    const middle = await leaveType({ balanceSourceTypeId: annual });
    const leaf = await leaveType();
    await expect(
      updateLeaveType(adminCtx(b), { id: leaf, name: await typeName(leaf), balanceSourceTypeId: middle }),
    ).rejects.toThrow(/already deducts from another leave type/i);
  });

  it('refuses giving a source to a type that is ALREADY somebody else’s source (the other direction)', async () => {
    const annual = await leaveType();
    await leaveType({ balanceSourceTypeId: annual }); // a borrower of annual now exists
    const other = await leaveType();
    await expect(
      updateLeaveType(adminCtx(b), { id: annual, name: await typeName(annual), balanceSourceTypeId: other }),
    ).rejects.toThrow(/already deducts from this leave type/i);
  });

  it('ALLOWS several types to draw on the same source (that is an ordinary setup)', async () => {
    const annual = await leaveType();
    const a = await leaveType();
    const c = await leaveType();
    await updateLeaveType(adminCtx(b), { id: a, name: await typeName(a), balanceSourceTypeId: annual });
    await updateLeaveType(adminCtx(b), { id: c, name: await typeName(c), balanceSourceTypeId: annual });
    const rows = await listLeaveTypes(adminCtx(b), {});
    expect(rows.find((r) => r.id === a)?.balanceSourceTypeId).toBe(annual);
    expect(rows.find((r) => r.id === c)?.balanceSourceTypeId).toBe(annual);
  });

  it('clears the source when null is passed (back to own balance)', async () => {
    const annual = await leaveType();
    const borrower = await leaveType({ balanceSourceTypeId: annual });
    await updateLeaveType(adminCtx(b), {
      id: borrower,
      name: await typeName(borrower),
      balanceSourceTypeId: null,
    });
    const [after] = await owner.db
      .select({ src: schema.leaveType.balanceSourceTypeId })
      .from(schema.leaveType)
      .where(eq(schema.leaveType.id, borrower));
    expect(after.src).toBeNull();
  });
});

describe('cdf9ca48 · the reporter’s scenario — Emergency Leave drawing on Annual Leave', () => {
  it('10 days Annual, 2 days Emergency ⇒ Annual falls to 8 and the history still says Emergency', async () => {
    const { ctx, employmentId } = await hireEmployeeCtx();
    const annual = await leaveType();
    const emergency = await leaveType({ balanceSourceTypeId: annual });
    await grant(employmentId, annual, 10);

    const { leaveRequestId } = await requestLeave(ctx, {
      employmentId,
      leaveTypeId: emergency,
      startDate: D1,
      endDate: D2,
      today: D1,
    });
    await decideLeave(adminCtx(b), { leaveRequestId, decision: 'approved' });

    // The balance moved on ANNUAL…
    expect(await withTenant(adminCtx(b), (tx) => leaveBalance(tx, employmentId, annual))).toBe(8);
    // …and Emergency itself carries no balance at all.
    expect(await withTenant(adminCtx(b), (tx) => leaveBalance(tx, employmentId, emergency))).toBe(0);
    // …while the request — the row leave history reads — is still the Emergency type.
    expect((await requestRow(leaveRequestId)).leaveTypeId).toBe(emergency);
    expect(await ledgerFor(leaveRequestId)).toEqual([{ leaveTypeId: annual, days: -2 }]);
  });

  it('the submit-time guard measures the SOURCE balance (insufficient Annual blocks Emergency)', async () => {
    const { ctx, employmentId } = await hireEmployeeCtx();
    const annual = await leaveType();
    const emergency = await leaveType({ balanceSourceTypeId: annual });
    await grant(employmentId, annual, 1);
    await expect(
      requestLeave(ctx, { employmentId, leaveTypeId: emergency, startDate: D1, endDate: D3, today: D1 }),
    ).rejects.toThrow(InsufficientLeaveBalanceOnSubmitError);
  });

  it('a PENDING borrowing application reserves the source balance (no collective overshoot)', async () => {
    const { ctx, employmentId } = await hireEmployeeCtx();
    const annual = await leaveType();
    const emergency = await leaveType({ balanceSourceTypeId: annual });
    await grant(employmentId, annual, 3);
    // 3 pending Emergency days reserve all 3 Annual days…
    await requestLeave(ctx, { employmentId, leaveTypeId: emergency, startDate: D1, endDate: D3, today: D1 });
    expect(await withTenant(adminCtx(b), (tx) => availableLeaveBalance(tx, employmentId, annual))).toBe(0);
    // …so a 1-day ANNUAL application is now refused even though the raw ledger still reads 3.
    await expect(
      requestLeave(ctx, { employmentId, leaveTypeId: annual, startDate: '2026-07-01', endDate: '2026-07-01', today: D1 }),
    ).rejects.toThrow(InsufficientLeaveBalanceOnSubmitError);
  });

  it('the apply-form summary and preview report the SOURCE balance, not an empty one', async () => {
    const { ctx, employmentId } = await hireEmployeeCtx();
    const annual = await leaveType();
    const emergency = await leaveType({ balanceSourceTypeId: annual });
    await grant(employmentId, annual, 10);
    const summary = await leaveTypeApplySummary(ctx, { employmentId, leaveTypeId: emergency });
    expect(summary.balance).toBe(10);
    const preview = await previewLeaveDeduction(ctx, {
      employmentId,
      leaveTypeId: emergency,
      startDate: D1,
      endDate: D2,
    });
    expect(preview.balanceAvailable).toBe(10);
    expect(preview.balanceAfter).toBe(8);
  });

  it('cancelling an approved borrowed leave gives the days back to the SOURCE ledger', async () => {
    const { ctx, employmentId } = await hireEmployeeCtx();
    const annual = await leaveType();
    const emergency = await leaveType({ balanceSourceTypeId: annual });
    await grant(employmentId, annual, 10);
    const { leaveRequestId } = await requestLeave(ctx, {
      employmentId,
      leaveTypeId: emergency,
      startDate: D1,
      endDate: D2,
      today: D1,
    });
    await decideLeave(adminCtx(b), { leaveRequestId, decision: 'approved' });
    expect(await withTenant(adminCtx(b), (tx) => leaveBalance(tx, employmentId, annual))).toBe(8);
    await adminCancelLeave(adminCtx(b), { leaveRequestId, reason: 'not needed' });
    expect(await withTenant(adminCtx(b), (tx) => leaveBalance(tx, employmentId, annual))).toBe(10);
    // Nothing was ever credited to the borrowing type.
    expect(await withTenant(adminCtx(b), (tx) => leaveBalance(tx, employmentId, emergency))).toBe(0);
  });
});

describe('cdf9ca48 · Emergency Leave keeps its decomposition until a source is configured', () => {
  /** An EMERGENCY-coded type; the hardcoded decomposition also needs ANNUAL + UNPAID to exist. */
  async function emergencySetup() {
    const [el] = await owner.db
      .insert(schema.leaveType)
      .values({ tenantId: b.tenantId, code: 'EMERGENCY', name: 'Emergency Leave', paid: true, counting: 'calendar_days' })
      .returning({ id: schema.leaveType.id });
    const [upl] = await owner.db
      .insert(schema.leaveType)
      .values({ tenantId: b.tenantId, code: 'UNPAID', name: 'Unpaid Leave', paid: false, counting: 'calendar_days' })
      .returning({ id: schema.leaveType.id });
    const [annual] = await owner.db
      .select({ id: schema.leaveType.id })
      .from(schema.leaveType)
      .where(and(eq(schema.leaveType.tenantId, b.tenantId), eq(schema.leaveType.code, 'ANNUAL')));
    return { el: el.id, upl: upl.id, annual: annual.id };
  }

  it('WITHOUT a source: decomposes into ANNUAL + UNPAID children, no EMERGENCY row (unchanged)', async () => {
    const { ctx, employmentId } = await hireEmployeeCtx();
    const { el, annual } = await emergencySetup();
    await grant(employmentId, annual, 10);
    await requestLeave(ctx, {
      employmentId,
      leaveTypeId: el,
      startDate: D1,
      endDate: D2,
      today: D1,
      unpaidConsent: true,
    });
    const rows = await owner.db
      .select({ leaveTypeId: schema.leaveRequest.leaveTypeId })
      .from(schema.leaveRequest)
      .where(eq(schema.leaveRequest.employmentId, employmentId));
    expect(rows.every((r) => r.leaveTypeId !== el)).toBe(true);
    expect(rows.some((r) => r.leaveTypeId === annual)).toBe(true);
  });

  it('WITH a source: one EMERGENCY row is persisted and Annual Leave is what falls', async () => {
    const { ctx, employmentId } = await hireEmployeeCtx();
    const { el, annual } = await emergencySetup();
    await updateLeaveType(adminCtx(b), { id: el, name: 'Emergency Leave', balanceSourceTypeId: annual });
    await grant(employmentId, annual, 10);
    const { leaveRequestId } = await requestLeave(ctx, {
      employmentId,
      leaveTypeId: el,
      startDate: D1,
      endDate: D2,
      today: D1,
    });
    const rows = await owner.db
      .select({ id: schema.leaveRequest.id, leaveTypeId: schema.leaveRequest.leaveTypeId })
      .from(schema.leaveRequest)
      .where(eq(schema.leaveRequest.employmentId, employmentId));
    expect(rows).toHaveLength(1);
    expect(rows[0].leaveTypeId).toBe(el);
    await decideLeave(adminCtx(b), { leaveRequestId, decision: 'approved' });
    expect(await withTenant(adminCtx(b), (tx) => leaveBalance(tx, employmentId, annual))).toBe(8);
  });
});

describe('a7fab30b · Allow Unpaid Leave — the part-covered split', () => {
  it('reporter scenario: 2 days balance, 5 days applied ⇒ 2 paid + 3 unpaid, ONE request', async () => {
    const { ctx, employmentId } = await hireEmployeeCtx();
    const lt = await leaveType({ allowUnpaidLeave: true });
    await grant(employmentId, lt, 2);

    const { leaveRequestId } = await requestLeave(ctx, {
      employmentId,
      leaveTypeId: lt,
      startDate: D1,
      endDate: D5,
      today: D1,
    });
    const row = await requestRow(leaveRequestId);
    expect(Number(row.days)).toBe(5);
    expect(Number(row.unpaidDays)).toBe(3);
    // ONE request, not two — the split lives on the row, not in a second application.
    const all = await owner.db
      .select({ id: schema.leaveRequest.id })
      .from(schema.leaveRequest)
      .where(eq(schema.leaveRequest.employmentId, employmentId));
    expect(all).toHaveLength(1);

    await decideLeave(adminCtx(b), { leaveRequestId, decision: 'approved' });
    // Only the covered 2 days came off the balance.
    expect(await ledgerFor(leaveRequestId)).toEqual([{ leaveTypeId: lt, days: -2 }]);
    expect(await withTenant(adminCtx(b), (tx) => leaveBalance(tx, employmentId, lt))).toBe(0);
  });

  it('a FULLY covered request on an opted-in type is entirely paid (no spurious unpaid days)', async () => {
    const { ctx, employmentId } = await hireEmployeeCtx();
    const lt = await leaveType({ allowUnpaidLeave: true });
    await grant(employmentId, lt, 10);
    const { leaveRequestId } = await requestLeave(ctx, {
      employmentId,
      leaveTypeId: lt,
      startDate: D1,
      endDate: D3,
      today: D1,
    });
    expect((await requestRow(leaveRequestId)).unpaidDays).toBeNull();
    await decideLeave(adminCtx(b), { leaveRequestId, decision: 'approved' });
    expect(await withTenant(adminCtx(b), (tx) => leaveBalance(tx, employmentId, lt))).toBe(7);
  });

  it('a ZERO balance makes the whole request unpaid and still lets it through', async () => {
    const { ctx, employmentId } = await hireEmployeeCtx();
    const lt = await leaveType({ allowUnpaidLeave: true });
    const { leaveRequestId } = await requestLeave(ctx, {
      employmentId,
      leaveTypeId: lt,
      startDate: D1,
      endDate: D3,
      today: D1,
    });
    expect(Number((await requestRow(leaveRequestId)).unpaidDays)).toBe(3);
    await decideLeave(adminCtx(b), { leaveRequestId, decision: 'approved' });
    // Nothing to debit ⇒ the balance never goes negative.
    expect(await withTenant(adminCtx(b), (tx) => leaveBalance(tx, employmentId, lt))).toBe(0);
  });

  it('allow_unpaid_leave=false keeps the existing refusal (nothing changes for other types)', async () => {
    const { ctx, employmentId } = await hireEmployeeCtx();
    const lt = await leaveType({ allowUnpaidLeave: false });
    await grant(employmentId, lt, 2);
    await expect(
      requestLeave(ctx, { employmentId, leaveTypeId: lt, startDate: D1, endDate: D5, today: D1 }),
    ).rejects.toThrow(InsufficientLeaveBalanceOnSubmitError);
  });

  it('tells the employee the split BEFORE submitting (previewLeaveDeduction)', async () => {
    const { ctx, employmentId } = await hireEmployeeCtx();
    const lt = await leaveType({ allowUnpaidLeave: true });
    await grant(employmentId, lt, 2);
    const preview = await previewLeaveDeduction(ctx, {
      employmentId,
      leaveTypeId: lt,
      startDate: D1,
      endDate: D5,
    });
    expect(preview.days).toBe(5);
    expect(preview.unpaidDays).toBe(3);
    // The balance only drops by the covered part, so the previewed "after" is what approval will produce.
    expect(preview.balanceAfter).toBe(0);
  });

  it('stamps the split on the submitted event (the balance moves later, so it cannot be recomputed)', async () => {
    const { ctx, employmentId } = await hireEmployeeCtx();
    const lt = await leaveType({ allowUnpaidLeave: true });
    await grant(employmentId, lt, 2);
    const { leaveRequestId } = await requestLeave(ctx, {
      employmentId,
      leaveTypeId: lt,
      startDate: D1,
      endDate: D5,
      today: D1,
    });
    const payload = (await latestEventPayload(
      b.tenantId,
      leaveRequestId,
      'leave-request.submitted',
    )) as Record<string, unknown>;
    expect(payload.unpaidDays).toBe(3);
    expect(payload.paidDays).toBe(2);
  });

  it('an edit RE-SPLITS rather than carrying the old figure forward', async () => {
    const { ctx, employmentId } = await hireEmployeeCtx();
    const lt = await leaveType({ allowUnpaidLeave: true });
    await grant(employmentId, lt, 2);
    const { leaveRequestId } = await requestLeave(ctx, {
      employmentId,
      leaveTypeId: lt,
      startDate: D1,
      endDate: D5,
      today: D1,
    });
    expect(Number((await requestRow(leaveRequestId)).unpaidDays)).toBe(3);
    // Shrink it back inside the balance ⇒ the unpaid portion must CLEAR, not linger.
    await editLeaveRequest(ctx, { leaveRequestId, leaveTypeId: lt, startDate: D1, endDate: D2, today: D1 });
    expect((await requestRow(leaveRequestId)).unpaidDays).toBeNull();
  });

  it('payroll deducts the unpaid portion through the existing unpaid-leave route', async () => {
    const { ctx, employmentId } = await hireEmployeeCtx();
    const lt = await leaveType({ allowUnpaidLeave: true });
    await grant(employmentId, lt, 2);
    const { leaveRequestId } = await requestLeave(ctx, {
      employmentId,
      leaveTypeId: lt,
      startDate: D1,
      endDate: D5,
      today: D1,
    });
    await decideLeave(adminCtx(b), { leaveRequestId, decision: 'approved' });
    const unpaid = await unpaidLeaveDaysForPeriod(adminCtx(b), '2026-06-01', '2026-06-30');
    // 3 unpaid days — NOT the whole 5-day span, and not 0.
    expect(unpaid.get(employmentId)).toBe(3);
  });

  it('a fully PAID approved request contributes nothing to payroll’s unpaid days', async () => {
    const { ctx, employmentId } = await hireEmployeeCtx();
    const lt = await leaveType({ allowUnpaidLeave: true });
    await grant(employmentId, lt, 10);
    const { leaveRequestId } = await requestLeave(ctx, {
      employmentId,
      leaveTypeId: lt,
      startDate: D1,
      endDate: D3,
      today: D1,
    });
    await decideLeave(adminCtx(b), { leaveRequestId, decision: 'approved' });
    const unpaid = await unpaidLeaveDaysForPeriod(adminCtx(b), '2026-06-01', '2026-06-30');
    expect(unpaid.get(employmentId) ?? 0).toBe(0);
  });
});

describe('cdf9ca48 × a7fab30b · a type that BOTH borrows and allows unpaid leave', () => {
  it('measures the unpaid overflow against the BORROWED balance and debits only the covered part', async () => {
    const { ctx, employmentId } = await hireEmployeeCtx();
    const annual = await leaveType();
    const emergency = await leaveType({ balanceSourceTypeId: annual, allowUnpaidLeave: true });
    await grant(employmentId, annual, 2);

    const { leaveRequestId } = await requestLeave(ctx, {
      employmentId,
      leaveTypeId: emergency,
      startDate: D1,
      endDate: D5,
      today: D1,
    });
    // 5 requested, 2 days of ANNUAL available ⇒ 3 unpaid (measured on the borrowed balance, not its own 0).
    expect(Number((await requestRow(leaveRequestId)).unpaidDays)).toBe(3);

    await decideLeave(adminCtx(b), { leaveRequestId, decision: 'approved' });
    expect(await ledgerFor(leaveRequestId)).toEqual([{ leaveTypeId: annual, days: -2 }]);
    expect(await withTenant(adminCtx(b), (tx) => leaveBalance(tx, employmentId, annual))).toBe(0);
    expect(await withTenant(adminCtx(b), (tx) => leaveBalance(tx, employmentId, emergency))).toBe(0);
    // The record the employee sees is still the type they applied for.
    expect((await requestRow(leaveRequestId)).leaveTypeId).toBe(emergency);
    const unpaid = await unpaidLeaveDaysForPeriod(adminCtx(b), '2026-06-01', '2026-06-30');
    expect(unpaid.get(employmentId)).toBe(3);
  });
});

describe('no regression for types that opt into neither setting', () => {
  it('an ordinary type still debits its own ledger for the whole span', async () => {
    const { ctx, employmentId } = await hireEmployeeCtx();
    const lt = await leaveType();
    await grant(employmentId, lt, 10);
    const { leaveRequestId } = await requestLeave(ctx, {
      employmentId,
      leaveTypeId: lt,
      startDate: D1,
      endDate: D3,
      today: D1,
    });
    expect((await requestRow(leaveRequestId)).unpaidDays).toBeNull();
    await decideLeave(adminCtx(b), { leaveRequestId, decision: 'approved' });
    expect(await ledgerFor(leaveRequestId)).toEqual([{ leaveTypeId: lt, days: -3 }]);
    expect(await withTenant(adminCtx(b), (tx) => leaveBalance(tx, employmentId, lt))).toBe(7);
    const [led] = await owner.db
      .select({ id: schema.leaveLedger.id })
      .from(schema.leaveLedger)
      .where(and(eq(schema.leaveLedger.employmentId, employmentId), eq(schema.leaveLedger.entryType, 'debit')));
    expect(led).toBeDefined();
  });
});
