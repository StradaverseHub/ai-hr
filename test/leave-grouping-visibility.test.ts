/**
 * Leave grouping visibility (feedback b653ac1b).
 *
 * HR-configurable placement of each leave type on the employee self-service Leave tab — Primary card /
 * Secondary group / Hidden. Covers the reporter's expected_function point by point:
 *   - migration 0191: ess_placement column exists + round-trips, DB CHECK rejects a non-primary/secondary
 *     value (hidden is never stored — it maps onto the shared visibility switch).
 *   - lib/leave-groups.resolvePlacement precedence: visible_to_employee=false ⇒ hidden; explicit column
 *     overrides; null ⇒ code-keyed default (primary / secondary / hidden set).
 *   - updateLeaveType maps the 3-way choice: 'hidden' ⇒ visible_to_employee=false + column cleared (ONE
 *     hidden mechanism, no second column); 'primary'/'secondary' ⇒ column set + flag true (un-hidden);
 *     null ⇒ both cleared. Emits a leave-type.updated event (substrate).
 *   - leaveBalances threads the resolved placement onto every row; a hidden-via-flag type is dropped from
 *     the ESS list (7b11f1c1 gate), a default-hidden-by-code type still surfaces but carries placement
 *     'hidden' for the renderer.
 *   - back-compat: an unconfigured (null) type keeps today's exact visibility and resolves to its default.
 */
import { and, eq } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import * as schema from '../db/schema';
import { hireEmployee } from '../core/org';
import { updateLeaveType } from '../core/admin';
import { leaveBalances, listLeaveTypes } from '../core/read';
import {
  defaultPlacementForCode,
  defaultPlacementForRole,
  resolvePlacement,
  isDefaultHiddenCode,
  PRIMARY_ROLES,
} from '../lib/leave-groups';
import { LEAVE_TYPE_ROLES } from '../core/leave';
import { adminCtx, closeAll, latestEventPayload, migrateTestDb, owner, resetDb, seedBase, type Base } from './harness';

let b: Base;

function uniqCode(prefix = 'PLC'): string {
  return `${prefix}_${randomUUID().slice(0, 8).toUpperCase().replace(/-/g, '')}`;
}

/** Upsert an active, everyone-eligible, calendar-counted leave type by code (seedBase pre-seeds some
 *  statutory codes like ANNUAL/SICK, so insert-only would collide on the tenant+code uniqueness index). */
async function leaveType(
  code: string,
  opts: {
    essPlacement?: string | null;
    visibleToEmployee?: boolean | null;
    /** 5ff7daff: `leave_type.role` — what the type IS, independent of the tenant's own code. */
    role?: schema.LeaveTypeRoleValue | null;
  } = {},
): Promise<string> {
  const existing = await owner.db
    .select({ id: schema.leaveType.id })
    .from(schema.leaveType)
    .where(and(eq(schema.leaveType.tenantId, b.tenantId), eq(schema.leaveType.code, code)));
  if (existing[0]) {
    await owner.db
      .update(schema.leaveType)
      .set({
        essPlacement: opts.essPlacement ?? null,
        visibleToEmployee: opts.visibleToEmployee ?? null,
        role: opts.role ?? null,
      })
      .where(eq(schema.leaveType.id, existing[0].id));
    return existing[0].id;
  }
  const [row] = await owner.db
    .insert(schema.leaveType)
    .values({
      allowNegativeBalance: true, // 0ef0defd: test type opts out of the submit-time balance gate (test not about balance)
      tenantId: b.tenantId,
      code,
      name: code,
      paid: true,
      counting: 'calendar_days',
      essPlacement: opts.essPlacement ?? null,
      visibleToEmployee: opts.visibleToEmployee ?? null,
      role: opts.role ?? null,
    })
    .returning({ id: schema.leaveType.id });
  return row.id;
}

async function hire() {
  return hireEmployee(adminCtx(b), {
    person: { fullName: 'Plc', primaryEmail: `plc_${randomUUID().slice(0, 8)}@t.local` },
    companyId: b.companyId,
    departmentId: b.deptA,
    employmentType: 'full_time',
    hiredOn: '2020-01-01',
  });
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

// ── lib/leave-groups: pure resolution (no DB) ──────────────────────────────────────────────────────
describe('resolvePlacement precedence + code-keyed defaults', () => {
  it('code-keyed defaults: primary codes, hidden set, else secondary', () => {
    expect(defaultPlacementForCode('ANNUAL')).toBe('primary');
    expect(defaultPlacementForCode('SICK')).toBe('primary');
    expect(defaultPlacementForCode('HOSPITALIZATION')).toBe('primary');
    expect(defaultPlacementForCode('EMERGENCY')).toBe('primary');
    expect(defaultPlacementForCode('REPLACEMENT')).toBe('primary');
    expect(defaultPlacementForCode('MARRIAGE')).toBe('secondary');
    expect(defaultPlacementForCode('SOME_CUSTOM')).toBe('secondary');
    // default-hidden set (exact + prefix families)
    expect(defaultPlacementForCode('UNRECORDED')).toBe('hidden');
    expect(defaultPlacementForCode('UNPAID_MEDICAL')).toBe('hidden');
    expect(defaultPlacementForCode('PROLONGED_ILLNESS_TIER1')).toBe('hidden');
    expect(defaultPlacementForCode('SUSPENSION_PENDING')).toBe('hidden');
    expect(isDefaultHiddenCode('SUSPENSION_X')).toBe(true);
    expect(isDefaultHiddenCode('ANNUAL')).toBe(false);
  });

  it('visible_to_employee=false always wins ⇒ hidden (single hidden mechanism)', () => {
    expect(resolvePlacement('ANNUAL', 'primary', false)).toBe('hidden');
    expect(resolvePlacement('MARRIAGE', null, false)).toBe('hidden');
  });

  it('explicit column overrides the default; null falls back to default', () => {
    expect(resolvePlacement('MARRIAGE', 'primary', null)).toBe('primary'); // group code lifted to a card
    expect(resolvePlacement('ANNUAL', 'secondary', null)).toBe('secondary'); // card code tucked into a group
    expect(resolvePlacement('ANNUAL', null, null)).toBe('primary'); // null ⇒ default
    expect(resolvePlacement('UNRECORDED', null, null)).toBe('hidden'); // null ⇒ default-hidden
  });
});

// ── 5ff7daff: the DEFAULT is role-aware, because PRIMARY_CODES holds the codes the SEED writes ──────
//
// This tenant's catalogue was not seeded: its replacement type is coded `RL` and its emergency type `EL`,
// neither of which is in PRIMARY_CODES. A tenant that had classified those rows (leave_type.role) but never
// opened the placement control therefore had them resolve 'secondary' — off the Primary cards and into an
// "Other" group. Role now answers first; it is still only a DEFAULT.
describe('resolvePlacement — role-keyed defaults (5ff7daff)', () => {
  it('a role-marked type defaults to Primary whatever the tenant coded it', () => {
    expect(defaultPlacementForRole('replacement')).toBe('primary');
    expect(defaultPlacementForRole('emergency')).toBe('primary');
    expect(resolvePlacement('RL', null, null, 'replacement')).toBe('primary');
    expect(resolvePlacement('EL', null, null, 'emergency')).toBe('primary');
    // …and case/whitespace in the stored marker does not change the answer.
    expect(resolvePlacement('RL', null, null, ' Replacement ')).toBe('primary');
  });

  it('an unclassified or non-primary role falls THROUGH to the code map (unchanged behaviour)', () => {
    // null/blank role ⇒ exactly the pre-5ff7daff answer for every existing tenant.
    expect(defaultPlacementForRole(null)).toBeNull();
    expect(defaultPlacementForRole('')).toBeNull();
    expect(resolvePlacement('RL', null, null, null)).toBe('secondary'); // RL is not in PRIMARY_CODES
    expect(resolvePlacement('RL', null, null)).toBe('secondary'); // 3-arg call site: identical
    expect(resolvePlacement('ANNUAL', null, null, null)).toBe('primary'); // code map still decides
    // a role deliberately NOT promoted: the code map answers, so nothing moves on tenants that never asked.
    expect(defaultPlacementForRole('annual')).toBeNull();
    expect(resolvePlacement('AL', null, null, 'annual')).toBe('secondary');
  });

  it('role is only a DEFAULT — HR’s explicit choice and the hidden switch still win', () => {
    // HR tucked the replacement card into a group: their choice stands.
    expect(resolvePlacement('RL', 'secondary', null, 'replacement')).toBe('secondary');
    // HR hid the type via the single visibility switch: it stays hidden (this is how EL sits today).
    expect(resolvePlacement('EL', null, false, 'emergency')).toBe('hidden');
    expect(resolvePlacement('RL', 'primary', false, 'replacement')).toBe('hidden');
  });

  it('PRIMARY_ROLES cannot drift from the closed role set (mirror pin)', () => {
    // lib/leave-groups.ts spells the role strings as literals because it is imported by a client component
    // and core/leave.ts drags in postgres. Same remedy as db/schema.ts's LeaveTypeRoleValue: pin the mirror.
    for (const r of PRIMARY_ROLES) expect(LEAVE_TYPE_ROLES as readonly string[]).toContain(r);
  });
});

// ── migration 0191: column + DB CHECK ──────────────────────────────────────────────────────────────
describe('migration 0191 — ess_placement column', () => {
  it('round-trips primary/secondary on a fresh test DB', async () => {
    const id = await leaveType(uniqCode(), { essPlacement: 'primary' });
    const [row] = await owner.db
      .select({ p: schema.leaveType.essPlacement })
      .from(schema.leaveType)
      .where(eq(schema.leaveType.id, id));
    expect(row?.p).toBe('primary');
  });

  it('DB CHECK rejects a stored "hidden" value (hidden is the flag, never the column)', async () => {
    await expect(leaveType(uniqCode(), { essPlacement: 'hidden' })).rejects.toThrow();
  });
});

// ── updateLeaveType: the 3-way HR choice maps onto column + shared flag ──────────────────────────────
describe('updateLeaveType — placement choice', () => {
  async function readRow(id: string) {
    const [row] = await owner.db
      .select({ p: schema.leaveType.essPlacement, v: schema.leaveType.visibleToEmployee })
      .from(schema.leaveType)
      .where(eq(schema.leaveType.id, id));
    return row;
  }

  it("'hidden' sets visible_to_employee=false and leaves the column clear", async () => {
    const id = await leaveType(uniqCode(), { essPlacement: 'primary', visibleToEmployee: true });
    await updateLeaveType(adminCtx(b), { id, name: 'X', essPlacement: 'hidden' });
    const row = await readRow(id);
    expect(row?.v).toBe(false);
    expect(row?.p).toBeNull();
  });

  it("'primary'/'secondary' store the column AND un-hide (flag true)", async () => {
    const id = await leaveType(uniqCode(), { visibleToEmployee: false });
    await updateLeaveType(adminCtx(b), { id, name: 'X', essPlacement: 'secondary' });
    const row = await readRow(id);
    expect(row?.p).toBe('secondary');
    expect(row?.v).toBe(true);
  });

  it('null clears the override (column null + flag null ⇒ code default)', async () => {
    const id = await leaveType(uniqCode(), { essPlacement: 'primary', visibleToEmployee: false });
    await updateLeaveType(adminCtx(b), { id, name: 'X', essPlacement: null });
    const row = await readRow(id);
    expect(row?.p).toBeNull();
    expect(row?.v).toBeNull();
  });

  it('emits a leave-type.updated domain event on a placement change (substrate)', async () => {
    const id = await leaveType(uniqCode());
    await updateLeaveType(adminCtx(b), { id, name: 'X', essPlacement: 'primary' });
    const payload = await latestEventPayload(b.tenantId, id, 'leave-type.updated');
    expect(payload).toBeTruthy();
    expect((payload as { after?: { essPlacement?: string } }).after?.essPlacement).toBe('primary');
  });

  it('an unrelated save (no placement marker) never touches ess_placement or the flag (tri-state)', async () => {
    const id = await leaveType(uniqCode(), { essPlacement: 'secondary' });
    await updateLeaveType(adminCtx(b), { id, name: 'Renamed' });
    const row = await readRow(id);
    expect(row?.p).toBe('secondary');
    expect(row?.v).toBeNull();
  });
});

// ── leaveBalances: resolved placement threaded onto rows ──────────────────────────────────────────────
describe('leaveBalances — resolved placement', () => {
  it('partitions primary / secondary / default-hidden and drops a hidden-via-flag type', async () => {
    const { employmentId } = await hire();
    const primaryId = await leaveType('ANNUAL'); // default primary
    const secondaryId = await leaveType('MARRIAGE'); // default secondary
    const overrideId = await leaveType(uniqCode(), { essPlacement: 'primary' }); // custom code, explicit primary
    const defaultHiddenId = await leaveType('UNRECORDED'); // default hidden (flag null ⇒ still listed)
    const flagHiddenId = await leaveType(uniqCode(), { visibleToEmployee: false }); // hidden via shared switch

    const rows = await leaveBalances(adminCtx(b), employmentId);
    const byId = new Map(rows.map((r) => [r.leaveTypeId, r]));

    expect(byId.get(primaryId)?.placement).toBe('primary');
    expect(byId.get(secondaryId)?.placement).toBe('secondary');
    expect(byId.get(overrideId)?.placement).toBe('primary');
    // default-hidden-by-code: still surfaced by leaveBalances (flag is null) but tagged 'hidden' so the
    // cards-and-groups renderer drops it.
    expect(byId.get(defaultHiddenId)?.placement).toBe('hidden');
    // hidden via the shared visibility switch: dropped entirely from the ESS list (7b11f1c1 gate).
    expect(byId.has(flagHiddenId)).toBe(false);
  });

  it('back-compat: an unconfigured type keeps its default placement and stays visible', async () => {
    const { employmentId } = await hire();
    const id = await leaveType('SICK'); // null placement, null flag
    const rows = await leaveBalances(adminCtx(b), employmentId);
    const row = rows.find((r) => r.leaveTypeId === id);
    expect(row).toBeTruthy();
    expect(row?.placement).toBe('primary'); // SICK is a primary code
  });

  // 5ff7daff — THE CONTRACT, not just the pure function. The reported symptom ("where is my replacement
  // leave") is produced by leaveBalances, and app/leave/page.tsx picks the Replacement card with
  // `b.placement === 'primary' && isReplacementLeaveType(b)`. A unit test of resolvePlacement alone would
  // have stayed green while leaveBalances went on passing only the code — so the assertion is made HERE,
  // on the row the screen actually reads.
  it('a role-marked replacement type coded RL is returned as placement=primary', async () => {
    const { employmentId } = await hire();
    const id = await leaveType('RL', { role: 'replacement' }); // unseeded code, no explicit placement
    const rows = await leaveBalances(adminCtx(b), employmentId);
    const row = rows.find((r) => r.leaveTypeId === id);
    expect(row).toBeTruthy();
    expect(row?.role).toBe('replacement');
    expect(row?.placement).toBe('primary');
  });

  it('a role-marked emergency type coded EL is returned as placement=primary', async () => {
    const { employmentId } = await hire();
    const id = await leaveType('EL', { role: 'emergency' });
    const rows = await leaveBalances(adminCtx(b), employmentId);
    expect(rows.find((r) => r.leaveTypeId === id)?.placement).toBe('primary');
  });

  it('an UNCLASSIFIED type coded RL still resolves to its code default (no behaviour change)', async () => {
    const { employmentId } = await hire();
    const id = await leaveType('RL', { role: null });
    const rows = await leaveBalances(adminCtx(b), employmentId);
    expect(rows.find((r) => r.leaveTypeId === id)?.placement).toBe('secondary');
  });

  it("HR's explicit Secondary still beats the role default", async () => {
    const { employmentId } = await hire();
    const id = await leaveType('RL', { role: 'replacement', essPlacement: 'secondary' });
    const rows = await leaveBalances(adminCtx(b), employmentId);
    expect(rows.find((r) => r.leaveTypeId === id)?.placement).toBe('secondary');
  });
});

// ── listLeaveTypes (admin) surfaces the stored column for the panel ──────────────────────────────────
describe('listLeaveTypes — admin projection', () => {
  it('projects ess_placement so the admin control round-trips', async () => {
    const id = await leaveType(uniqCode(), { essPlacement: 'secondary' });
    const types = await listLeaveTypes(adminCtx(b), { includeArchived: false });
    const t = types.find((x) => x.id === id);
    expect(t?.essPlacement).toBe('secondary');
  });
});
