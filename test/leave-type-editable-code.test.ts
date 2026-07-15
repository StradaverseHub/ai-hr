/**
 * Enable Editing of Leave Type Code (feedback a7194511).
 *
 * The Code field, previously immutable, becomes editable for CUSTOM (non-statutory) leave types.
 * updateLeaveType accepts an optional `newCode`. When present and different from the current code it:
 *   (a) refuses if the CURRENT code is statutory (ANNUAL / SICK / HOSPITALIZATION / MATERNITY / PATERNITY)
 *       or EMERGENCY — those are LOCKED because the code is the semantic key EA-1955 matching, carry-forward
 *       and encashment resolve on;
 *   (b) normalizes (uppercase, spaces→underscores) + shape-validates ^[A-Z][A-Z0-9_]{1,31}$;
 *   (c) rejects a duplicate (case-insensitive, active, non-self) with the reporter's exact message;
 *   (d) refuses renaming a custom code INTO a statutory/EMERGENCY code;
 *   (e) persists the code and records before/after in the leave-type.updated DomainEvent.
 * All FK relations key on leave_type_id, so a code rename NEVER orphans ledger rows, requests or policies.
 *
 * These are service-level guards (the UI editable/read-only split + confirmation dialog are covered by the
 * static panel guards and i18n coverage). Statutory-code detection reuses the shared literals in core/leave.ts.
 */
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import * as schema from '../db/schema';
import { updateLeaveType, DuplicateError } from '../core/admin';
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

function uniq(prefix: string): string {
  return `${prefix}_${randomUUID().slice(0, 8).toUpperCase().replace(/-/g, '')}`;
}

/** Insert a leave type with an explicit code (owner db bypasses RLS). */
async function makeType(code: string, name?: string): Promise<string> {
  const [row] = await owner.db
    .insert(schema.leaveType)
    .values({ tenantId: b.tenantId, code, name: name ?? uniq('LT'), paid: true })
    .returning({ id: schema.leaveType.id });
  return row.id;
}

/** Reuse an already-seeded type with this code (seedBase seeds ANNUAL) or insert a fresh one. */
async function getOrMakeType(code: string): Promise<string> {
  const [existing] = await owner.db
    .select({ id: schema.leaveType.id })
    .from(schema.leaveType)
    .where(eq(schema.leaveType.code, code));
  return existing ? existing.id : makeType(code, code);
}

async function codeOf(id: string): Promise<string> {
  const [row] = await owner.db
    .select({ code: schema.leaveType.code })
    .from(schema.leaveType)
    .where(eq(schema.leaveType.id, id));
  return row.code;
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

describe('updateLeaveType — editable code for custom types', () => {
  it('renames a custom type code, persists it, and records before/after in the event', async () => {
    const oldCode = uniq('CUST');
    const id = await makeType(oldCode, 'Study Leave');
    const newCode = uniq('STUDY');
    await updateLeaveType(adminCtx(b), { id, name: 'Study Leave', newCode });
    expect(await codeOf(id)).toBe(newCode);
    const payload = await latestEventPayload(b.tenantId, id, 'leave-type.updated');
    expect((payload as any).before.code).toBe(oldCode);
    expect((payload as any).after.code).toBe(newCode);
  });

  it('normalizes lowercase + spaces to the canonical uppercase/underscore key', async () => {
    const id = await makeType(uniq('CUST'), 'Study Leave');
    await updateLeaveType(adminCtx(b), { id, name: 'Study Leave', newCode: 'study leave' });
    expect(await codeOf(id)).toBe('STUDY_LEAVE');
  });

  it('surfaces the renamed code on listLeaveTypes so the panel round-trips it', async () => {
    const id = await makeType(uniq('CUST'), 'Study Leave');
    const newCode = uniq('LEARN');
    await updateLeaveType(adminCtx(b), { id, name: 'Study Leave', newCode });
    const rows = await listLeaveTypes(adminCtx(b), {});
    expect(rows.find((r) => r.id === id)?.code).toBe(newCode);
  });

  it('no-ops (no error, no code event diff) when newCode equals the current code', async () => {
    const code = uniq('CUST');
    const id = await makeType(code, 'Study Leave');
    await updateLeaveType(adminCtx(b), { id, name: 'Study Leave', newCode: code });
    expect(await codeOf(id)).toBe(code);
    const payload = await latestEventPayload(b.tenantId, id, 'leave-type.updated');
    expect((payload as any).before.code).toBeUndefined();
    expect((payload as any).after.code).toBeUndefined();
  });

  it('leaves the code untouched when newCode is omitted (tri-state)', async () => {
    const code = uniq('CUST');
    const id = await makeType(code, 'Study Leave');
    await updateLeaveType(adminCtx(b), { id, name: 'Renamed Study Leave' });
    expect(await codeOf(id)).toBe(code);
  });
});

describe('updateLeaveType — validation', () => {
  it('rejects a duplicate code (case-insensitive, active, non-self) with the reporter message', async () => {
    await makeType('EXISTING', 'Existing');
    const id = await makeType(uniq('CUST'), 'Study Leave');
    await expect(
      updateLeaveType(adminCtx(b), { id, name: 'Study Leave', newCode: 'existing' }),
    ).rejects.toThrow('Leave Type Code already exists. Please enter a unique code.');
    await expect(
      updateLeaveType(adminCtx(b), { id, name: 'Study Leave', newCode: 'existing' }),
    ).rejects.toBeInstanceOf(DuplicateError);
  });

  it('allows reusing a code held only by an ARCHIVED type (partial-index semantics)', async () => {
    const archivedId = await makeType('FREED', 'Old');
    await owner.db
      .update(schema.leaveType)
      .set({ archivedAt: new Date() })
      .where(eq(schema.leaveType.id, archivedId));
    const id = await makeType(uniq('CUST'), 'Study Leave');
    await updateLeaveType(adminCtx(b), { id, name: 'Study Leave', newCode: 'FREED' });
    expect(await codeOf(id)).toBe('FREED');
  });

  it('rejects a malformed code (must start with a letter)', async () => {
    const id = await makeType(uniq('CUST'), 'Study Leave');
    await expect(
      updateLeaveType(adminCtx(b), { id, name: 'Study Leave', newCode: '1NVALID' }),
    ).rejects.toThrow(/letters, digits or underscores/);
  });
});

describe('updateLeaveType — statutory lock (both directions)', () => {
  for (const stat of ['ANNUAL', 'SICK', 'HOSPITALIZATION', 'MATERNITY', 'PATERNITY', 'EMERGENCY']) {
    it(`refuses to rename a statutory/EMERGENCY current code (${stat})`, async () => {
      const id = await getOrMakeType(stat);
      await expect(
        updateLeaveType(adminCtx(b), { id, name: stat, newCode: `${stat}_X` }),
      ).rejects.toThrow('statutory leave type code cannot be changed');
      expect(await codeOf(id)).toBe(stat);
    });
  }

  it('refuses renaming a custom code INTO a statutory code', async () => {
    const id = await makeType(uniq('CUST'), 'Study Leave');
    await expect(
      updateLeaveType(adminCtx(b), { id, name: 'Study Leave', newCode: 'ANNUAL' }),
    ).rejects.toThrow('statutory leave type code cannot be changed');
  });

  it('refuses renaming a custom code INTO EMERGENCY', async () => {
    const id = await makeType(uniq('CUST'), 'Study Leave');
    await expect(
      updateLeaveType(adminCtx(b), { id, name: 'Study Leave', newCode: 'EMERGENCY' }),
    ).rejects.toThrow('statutory leave type code cannot be changed');
  });
});

describe('updateLeaveType — code rename does not detach history', () => {
  it('keeps existing ledger rows attached to the same leave_type_id after a code rename', async () => {
    const id = await makeType(uniq('CUST'), 'Study Leave');
    const { employmentId } = await hire();
    await owner.db.insert(schema.leaveLedger).values({
      tenantId: b.tenantId,
      employmentId,
      leaveTypeId: id,
      entryType: 'accrual',
      days: '5.00',
      effectiveOn: '2020-01-01',
    });
    await updateLeaveType(adminCtx(b), { id, name: 'Study Leave', newCode: uniq('MOVED') });
    const led = await owner.db
      .select({ id: schema.leaveLedger.id })
      .from(schema.leaveLedger)
      .where(eq(schema.leaveLedger.leaveTypeId, id));
    expect(led.length).toBe(1);
  });
});

// Minimal hire so a ledger row has a valid employment FK.
async function hire(): Promise<{ employmentId: string }> {
  const { hireEmployee } = await import('../core/org');
  const { employmentId } = await hireEmployee(adminCtx(b), {
    person: { fullName: 'Hist', primaryEmail: `hist_${randomUUID().slice(0, 8)}@t.local` },
    companyId: b.companyId,
    departmentId: b.deptA,
    employmentType: 'full_time',
    hiredOn: '2020-01-01',
  });
  return { employmentId };
}
