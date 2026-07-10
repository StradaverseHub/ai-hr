/**
 * Edit Paid/Unpaid on rename (feedback 75953777) — the paid/unpaid flag must be editable when renaming a
 * leave type (previously it was wired into CREATE only, so it was immutable after creation).
 *
 * Exercises the service-layer delta this build adds on top of the existing updateLeaveType tri-state fields:
 *   - updateLeaveType gains a `paid` OWN tri-state. A save that sends it flips leave_type.paid and audits the
 *     before/after in the leave-type.updated event payload.
 *   - A save that OMITS `paid` (e.g. a payroll-only / backdating-only sub-form save) leaves the column
 *     untouched (regression guard — no silent reset).
 *   - Change applies to the master row only; historical requests / ledger are untouched (paid is read at
 *     request/payroll time, not copied by this write).
 *
 * Mirrors the harness helpers used by test/leave-type-master.test.ts.
 */
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import * as schema from '../db/schema';
import { createLeaveType, updateLeaveType } from '../core/admin';
import { listLeaveTypes } from '../core/read';
import {
  adminCtx,
  closeAll,
  latestEventPayload,
  migrateTestDb,
  owner,
  resetDb,
  seedBase,
  type Base,
} from './harness';

let b: Base;

/** A unique leave-type code matching the leave_type_code_shape check (^[A-Z][A-Z0-9_]{1,31}$). */
function uniqCode(): string {
  return `PU_${randomUUID().slice(0, 8).toUpperCase().replace(/-/g, '')}`;
}

async function paidOf(id: string): Promise<boolean> {
  const [row] = await owner.db
    .select({ paid: schema.leaveType.paid })
    .from(schema.leaveType)
    .where(eq(schema.leaveType.id, id));
  return row.paid;
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
});

describe('Edit Paid/Unpaid on rename (75953777)', () => {
  it('rename save that sends `paid: false` flips the column and audits before/after', async () => {
    const { id } = await createLeaveType(adminCtx(b), {
      code: uniqCode(),
      name: 'Prolonged Illness No Pay',
      paid: true, // created (wrongly) as paid
    });
    expect(await paidOf(id)).toBe(true);

    // The identity/rename sub-form now forwards a concrete paid boolean (unchecked ⇒ false).
    await updateLeaveType(adminCtx(b), { id, name: 'Prolonged Illness No Pay', paid: false });
    expect(await paidOf(id)).toBe(false);

    // Projected on reload for the admin master panel.
    const found = (await listLeaveTypes(adminCtx(b), { includeArchived: true })).find((t) => t.id === id);
    expect(found?.paid).toBe(false);

    // Audited: before.paid=true → after.paid=false.
    const payload = await latestEventPayload(b.tenantId, id, 'leave-type.updated');
    const before = payload?.before as Record<string, unknown>;
    const after = payload?.after as Record<string, unknown>;
    expect(before.paid).toBe(true);
    expect(after.paid).toBe(false);
  });

  it('can flip the other direction too (unpaid → paid)', async () => {
    const { id } = await createLeaveType(adminCtx(b), { code: uniqCode(), name: 'Fix Me', paid: false });
    expect(await paidOf(id)).toBe(false);
    await updateLeaveType(adminCtx(b), { id, name: 'Fix Me', paid: true });
    expect(await paidOf(id)).toBe(true);
  });

  it('tri-state regression: a save that omits `paid` leaves the column untouched', async () => {
    const { id } = await createLeaveType(adminCtx(b), { code: uniqCode(), name: 'Keep Paid', paid: false });
    // Simulate a payroll-only sub-form save (no identity marker ⇒ paid undefined).
    await updateLeaveType(adminCtx(b), { id, name: 'Keep Paid', sendToPayroll: true });
    expect(await paidOf(id)).toBe(false); // unchanged

    // And a save that omits paid must NOT put paid into the audit diff.
    const payload = await latestEventPayload(b.tenantId, id, 'leave-type.updated');
    const before = payload?.before as Record<string, unknown>;
    const after = payload?.after as Record<string, unknown>;
    expect('paid' in before).toBe(false);
    expect('paid' in after).toBe(false);
  });
});
