/**
 * Feedback 082fa566 (contested re-fix) — the Request-Leave popup's "Available" must BE the available balance.
 *
 * r74 renamed the popup's third column from Balance to Available and said so explicitly: "The VALUE is
 * unchanged … this is a label fix and not a recalculation." The reporter came back with the consequence: the
 * popup shows 13.5 where the leave type's own Leave Summary shows 8.5.
 *
 * REPRODUCTION (the 5.0 gap, accounted for before anything was changed): the popup was rendering
 * `leaveTypeApplySummary.balance` — the RAW ledger sum, gross of pending — under a header that says
 * Available, while core/read.ts `leaveBalances` defines `available = balance − pending`. An employee with a
 * 13.5-day ledger and 5.0 days of submitted-but-undecided leave therefore read 13.5 on the popup and 8.5 on
 * the card 200px away. The gap is exactly the pending reservation — nothing else.
 *
 * The tests below pin all three of the figures that have to agree, on ONE seeded employee, so a future edit
 * cannot fix one surface and leave the others behind:
 *   popup Available  ==  leaveBalances.available  ==  availableLeaveBalance (the submit-time guard)
 * and the r72 (cdf9ca48) invariant that the popup's Pending is the guard's reserve verbatim, expressed as the
 * identity that makes the number checkable on screen: balance − pending = available.
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import * as schema from '../db/schema';
import { hireEmployee } from '../core/org';
import { requestLeave, availableLeaveBalance, leaveBalance, leaveTypeApplySummary } from '../core/leave';
import { leaveBalances } from '../core/read';
import { withTenant } from '../db/client';
import type { SessionContext } from '../db/client';
import {
  adminCtx,
  closeAll,
  createAppUser,
  migrateTestDb,
  owner,
  resetDb,
  seedBase,
  type Base,
} from './harness';

let b: Base;

async function hireEmployeeCtx(): Promise<{ ctx: SessionContext; employmentId: string }> {
  const { employmentId, personId } = await hireEmployee(adminCtx(b), {
    person: { fullName: 'Avail', primaryEmail: `avail_${randomUUID().slice(0, 8)}@t.local` },
    companyId: b.companyId,
    departmentId: b.deptA,
    employmentType: 'full_time',
    hiredOn: '2020-01-01',
  });
  const userId = await createAppUser(b.tenantId, personId, 'employee');
  return { ctx: { tenantId: b.tenantId, userId, roles: ['employee'], personId }, employmentId };
}

/** Calendar-counted type so one calendar day == one leave day (the arithmetic under test is the balance
 *  identity, not the day engine). */
async function leaveType(opts: { allowNegativeBalance?: boolean } = {}): Promise<string> {
  const [row] = await owner.db
    .insert(schema.leaveType)
    .values({
      tenantId: b.tenantId,
      code: `AVL_${randomUUID().slice(0, 8).toUpperCase().replace(/-/g, '')}`,
      name: `Avail ${randomUUID().slice(0, 6)}`,
      paid: true,
      counting: 'calendar_days',
      visibleToEmployee: true,
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

// A 5-calendar-day span, D1..D5 inclusive — the reporter's 5.0 gap, submitted and awaiting a decision.
const D1 = '2026-06-01';
const D5 = '2026-06-05';

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

describe('082fa566 · the reporter\'s 13.5 vs 8.5', () => {
  it('reproduces the gap as the pending reservation, and closes it', async () => {
    const { ctx, employmentId } = await hireEmployeeCtx();
    const typeId = await leaveType();
    await grant(employmentId, typeId, 13.5);
    await requestLeave(ctx, { employmentId, leaveTypeId: typeId, startDate: D1, endDate: D5 });

    // The three figures, as the three surfaces compute them.
    const gross = await withTenant(ctx, (tx) => leaveBalance(tx, employmentId, typeId));
    const guard = await withTenant(ctx, (tx) => availableLeaveBalance(tx, employmentId, typeId));
    const card = (await leaveBalances(ctx, employmentId)).find((r) => r.leaveTypeId === typeId)!;
    const popup = await leaveTypeApplySummary(ctx, { employmentId, leaveTypeId: typeId });

    // The gap the reporter saw: the ledger is 13.5, the card says 8.5, and 5.0 is the pending request.
    expect(gross).toBe(13.5);
    expect(card.pending).toBe(5);
    expect(card.available).toBe(8.5);
    expect(popup.pending).toBe(5);

    // What the popup renders under "Available" must be the card's Available, not the raw ledger.
    expect(popup.available).toBe(8.5);
    // …and it must be the SAME number the submit-time guard measures against, or an employee can be refused
    // for exceeding a balance the popup just told them they had (the r72 cdf9ca48 invariant).
    expect(popup.available).toBe(guard);
    // The gross ledger figure stays available as Balance, so the subtraction is checkable on screen.
    expect(popup.balance).toBe(13.5);
    expect(popup.balance - popup.pending).toBe(popup.available);
  });

  it('holds for a type with no ledger and no pending rows (0 / 0 / 0, not nothing)', async () => {
    const { ctx, employmentId } = await hireEmployeeCtx();
    const typeId = await leaveType();
    const popup = await leaveTypeApplySummary(ctx, { employmentId, leaveTypeId: typeId });
    expect(popup).toMatchObject({ pending: 0, taken: 0, balance: 0, available: 0 });
  });

  it('goes negative with the guard rather than clamping — an overdrawn type reads the same on both', async () => {
    const { ctx, employmentId } = await hireEmployeeCtx();
    const typeId = await leaveType({ allowNegativeBalance: true });
    await grant(employmentId, typeId, 2);
    await requestLeave(ctx, { employmentId, leaveTypeId: typeId, startDate: D1, endDate: D5 });
    const guard = await withTenant(ctx, (tx) => availableLeaveBalance(tx, employmentId, typeId));
    const popup = await leaveTypeApplySummary(ctx, { employmentId, leaveTypeId: typeId });
    expect(popup.available).toBe(-3);
    expect(popup.available).toBe(guard);
  });
});
