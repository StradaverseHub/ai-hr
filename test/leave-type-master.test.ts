/**
 * Leave Type Setup Enhancement (feedback 097de541) — the Leave Types tab as the master-configuration page.
 *
 * Exercises the service-layer delta this build adds on top of the existing leave-type CRUD:
 *   - createLeaveType now accepts an optional `description` and a create-time `active` status (default true);
 *     inactive ⇒ inserted already archived. The created event payload carries description + active.
 *   - Name uniqueness (case-insensitive, ACTIVE types only) on both create and rename — enforced in the
 *     service, NOT a DB index (so legacy duplicates never block, and the user gets a friendly DuplicateError).
 *   - updateLeaveType gains a `description` OWN tri-state: a save that omits `description` (e.g. a
 *     backdating-only save) must leave the column untouched; a save that sends it updates + audits it.
 *
 * Mirrors the harness helpers used by test/leave-custom-messages.test.ts.
 */
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import * as schema from '../db/schema';
import { createLeaveType, updateLeaveType, archiveLeaveType, DuplicateError } from '../core/admin';
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
  return `MP_${randomUUID().slice(0, 8).toUpperCase().replace(/-/g, '')}`;
}

async function typeRow(id: string) {
  const [row] = await owner.db
    .select({
      description: schema.leaveType.description,
      archivedAt: schema.leaveType.archivedAt,
      name: schema.leaveType.name,
    })
    .from(schema.leaveType)
    .where(eq(schema.leaveType.id, id));
  return row;
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

describe('Leave Type master page (097de541)', () => {
  it('creates with a description + inactive status → stored, archived, and projected on reload', async () => {
    const code = uniqCode();
    const { id } = await createLeaveType(adminCtx(b), {
      code,
      name: 'Maternity Leave',
      paid: true,
      description: '  60 days paid, EA s.37  ',
      active: false,
    });
    const row = await typeRow(id);
    expect(row.description).toBe('60 days paid, EA s.37'); // trimmed
    expect(row.archivedAt).not.toBeNull(); // inactive ⇒ archived

    // includeArchived projection surfaces the description for the admin master table.
    const types = await listLeaveTypes(adminCtx(b), { includeArchived: true });
    const found = types.find((t) => t.id === id);
    expect(found?.description).toBe('60 days paid, EA s.37');

    // created event carries the new fields.
    const payload = await latestEventPayload(b.tenantId, id, 'leave-type.created');
    expect(payload).toMatchObject({ description: '60 days paid, EA s.37', active: false, paid: true });
  });

  it('empty description ⇒ null (never stored as "")', async () => {
    const { id } = await createLeaveType(adminCtx(b), { code: uniqCode(), name: 'Blank Desc', description: '   ' });
    expect((await typeRow(id)).description).toBeNull();
  });

  it('rejects a duplicate name (case-insensitive) among ACTIVE types', async () => {
    await createLeaveType(adminCtx(b), { code: uniqCode(), name: 'Study Leave' });
    await expect(
      createLeaveType(adminCtx(b), { code: uniqCode(), name: 'study leave' }),
    ).rejects.toBeInstanceOf(DuplicateError);
  });

  it('allows a name that only collides with an ARCHIVED type', async () => {
    const first = await createLeaveType(adminCtx(b), { code: uniqCode(), name: 'Sabbatical' });
    await archiveLeaveType(adminCtx(b), { id: first.id, archived: true });
    // Now an active type may reuse the name (mirrors the partial code index).
    await expect(
      createLeaveType(adminCtx(b), { code: uniqCode(), name: 'Sabbatical' }),
    ).resolves.toBeTruthy();
  });

  it('rename to an existing active name → DuplicateError; keeping own name → ok', async () => {
    await createLeaveType(adminCtx(b), { code: uniqCode(), name: 'Alpha Leave' });
    const beta = await createLeaveType(adminCtx(b), { code: uniqCode(), name: 'Beta Leave' });
    await expect(
      updateLeaveType(adminCtx(b), { id: beta.id, name: 'alpha leave' }),
    ).rejects.toBeInstanceOf(DuplicateError);
    // Re-saving with its own (unchanged) name is fine.
    await expect(updateLeaveType(adminCtx(b), { id: beta.id, name: 'Beta Leave' })).resolves.toBeUndefined();
  });

  it('description tri-state: a save that omits `description` leaves the column untouched', async () => {
    const { id } = await createLeaveType(adminCtx(b), { code: uniqCode(), name: 'Tri State', description: 'keep me' });
    // Simulate a backdating-only save (identity marker absent ⇒ description undefined).
    await updateLeaveType(adminCtx(b), { id, name: 'Tri State', backdatingLimitDays: 3 });
    expect((await typeRow(id)).description).toBe('keep me');
  });

  it('updates + audits the description when the identity save sends it', async () => {
    const { id } = await createLeaveType(adminCtx(b), { code: uniqCode(), name: 'Audit Desc', description: 'old' });
    await updateLeaveType(adminCtx(b), { id, name: 'Audit Desc', description: 'new text' });
    expect((await typeRow(id)).description).toBe('new text');
    const payload = await latestEventPayload(b.tenantId, id, 'leave-type.updated');
    const before = payload?.before as Record<string, unknown>;
    const after = payload?.after as Record<string, unknown>;
    expect(before.description).toBe('old');
    expect(after.description).toBe('new text');
  });

  it('clears the description when an explicit blank is sent through the identity save', async () => {
    const { id } = await createLeaveType(adminCtx(b), { code: uniqCode(), name: 'Clear Desc', description: 'temp' });
    await updateLeaveType(adminCtx(b), { id, name: 'Clear Desc', description: '' });
    expect((await typeRow(id)).description).toBeNull();
  });
});
