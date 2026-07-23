/**
 * Employee Leave View Configuration (feedback 65dec703 / duplicate 1fedb473).
 *
 * Per-leave-type `ess_view_config` JSONB (migration 0178) controls which entitlement/breakdown components an
 * employee sees in self-service (My Profile → Leave). HR ticks components in the Leave Config → Entitlements
 * panel. Semantics: a key mapped false ⇒ hidden in ESS; missing/true, or a null column, ⇒ visible (the
 * backward-compatible default). Gating applies to /me ONLY — the admin/HR EntitlementBreakdown passes
 * applyEssConfig=false and sees everything (that flag is a UI contract, asserted here via the same predicate).
 *
 * Coverage: migration column round-trips; resolver default (null ⇒ all-visible); updateLeaveType tri-state
 * (an essView-only save leaves sibling columns untouched, and an unrelated save leaves ess_view_config
 * untouched) + audit before/after; unknown-key rejection; the read layer threads a resolved essView onto
 * BOTH leaveBalances rows and leaveEntitlementBreakdown (missing ⇒ visible, explicit false honoured); and the
 * /me-vs-admin gating contract (applyEssConfig=false ⇒ never gated).
 */
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import * as schema from '../db/schema';
import { hireEmployee } from '../core/org';
import { updateLeaveType } from '../core/admin';
import { listLeaveTypes, leaveBalances, leaveEntitlementBreakdown } from '../core/read';
import { resolveEssView, ESS_VIEW_COMPONENT_KEYS } from '../core/ess-view';
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
    person: { fullName: 'EssView', primaryEmail: `ev_${randomUUID().slice(0, 8)}@t.local` },
    companyId: b.companyId,
    departmentId: b.deptA,
    employmentType: 'full_time',
    hiredOn: '2020-01-01',
  });
  const userId = await createAppUser(b.tenantId, personId, 'employee');
  return { ctx: { tenantId: b.tenantId, userId, roles: ['employee'], personId }, employmentId };
}

function uniqCode(): string {
  return `EV_${randomUUID().slice(0, 8).toUpperCase().replace(/-/g, '')}`;
}

/** Insert a calendar-counted leave type with an optional ess_view_config. */
async function leaveType(code: string, essViewConfig?: Record<string, boolean> | null): Promise<string> {
  const [row] = await owner.db
    .insert(schema.leaveType)
    .values({
      allowNegativeBalance: true, // 0ef0defd: test type opts out of the submit-time balance gate (test not about balance)
      tenantId: b.tenantId,
      code,
      name: code,
      paid: true,
      counting: 'calendar_days',
      essViewConfig: essViewConfig ?? null,
    })
    .returning({ id: schema.leaveType.id });
  return row.id;
}

/** The /me-vs-admin gating contract, mirrored from components/leave/EntitlementBreakdown.tsx `show`. */
function show(applyEssConfig: boolean, essView: Record<string, boolean> | undefined, key: string): boolean {
  return !applyEssConfig || essView?.[key] !== false;
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

describe('resolveEssView — default & partial semantics', () => {
  it('null config ⇒ every component visible (backward compatible)', () => {
    const v = resolveEssView(null);
    for (const k of ESS_VIEW_COMPONENT_KEYS) expect(v[k]).toBe(true);
  });

  it('a partial map ⇒ missing keys visible, explicit false honoured', () => {
    const v = resolveEssView({ available: false, taken: true });
    expect(v.available).toBe(false);
    expect(v.taken).toBe(true);
    // A key absent from the stored map resolves to visible.
    expect(v.forfeited).toBe(true);
  });

  it('an unknown stored key is ignored (never throws on legacy data)', () => {
    const v = resolveEssView({ someLegacyKey: false } as Record<string, boolean>);
    // All known keys still resolve; the junk key simply does not appear.
    expect(Object.keys(v).sort()).toEqual([...ESS_VIEW_COMPONENT_KEYS].sort());
  });

  it('11876072: the removed upcomingApprovedLeave toggle is a dead key — normalized away on read', () => {
    // The §5 Upcoming Leave section left the employee panel, so its toggle left the closed allow-list.
    expect(ESS_VIEW_COMPONENT_KEYS).not.toContain('upcomingApprovedLeave');
    // A leave type that stored the toggle before the removal keeps working: the stored entry is simply
    // ignored on read (no migration/backfill needed), and every live key still resolves to its default.
    const v = resolveEssView({ upcomingApprovedLeave: false } as Record<string, boolean>);
    expect(Object.keys(v).sort()).toEqual([...ESS_VIEW_COMPONENT_KEYS].sort());
    for (const k of ESS_VIEW_COMPONENT_KEYS) expect(v[k]).toBe(true);
  });
});

describe('migration 0178 — ess_view_config column', () => {
  it('exists and round-trips a JSONB map on a fresh test DB', async () => {
    const ltId = await leaveType(uniqCode(), { available: false, forfeited: false });
    const [row] = await owner.db
      .select({ cfg: schema.leaveType.essViewConfig })
      .from(schema.leaveType)
      .where(eq(schema.leaveType.id, ltId));
    expect((row?.cfg as Record<string, boolean> | null)?.available).toBe(false);
    expect((row?.cfg as Record<string, boolean> | null)?.forfeited).toBe(false);
  });
});

describe('updateLeaveType — essViewConfig tri-state, validation & audit', () => {
  it('setting a config persists and reads back via the admin projection', async () => {
    const ltId = await leaveType(uniqCode(), null);
    await updateLeaveType(adminCtx(b), {
      id: ltId,
      name: uniqCode(),
      essViewConfig: { available: true, forfeited: false, adjustment: false },
    });
    const t = (await listLeaveTypes(adminCtx(b), { includeArchived: true })).find((x) => x.id === ltId);
    const cfg = t?.essViewConfig as Record<string, boolean> | null;
    expect(cfg?.forfeited).toBe(false);
    expect(cfg?.adjustment).toBe(false);
    expect(cfg?.available).toBe(true);
  });

  it('an essView-only save leaves a sibling column (backdatingLimitDays) untouched', async () => {
    const [row] = await owner.db
      .insert(schema.leaveType)
      .values({ allowNegativeBalance: true, tenantId: b.tenantId, code: uniqCode(), name: 'X', paid: true, counting: 'calendar_days', backdatingLimitDays: 7 })
      .returning({ id: schema.leaveType.id });
    await updateLeaveType(adminCtx(b), { id: row.id, name: 'X', essViewConfig: { taken: false } });
    const t = (await listLeaveTypes(adminCtx(b), { includeArchived: true })).find((x) => x.id === row.id);
    expect(t?.backdatingLimitDays).toBe(7); // sibling survived
    expect((t?.essViewConfig as Record<string, boolean> | null)?.taken).toBe(false);
  });

  it('an unrelated save (doc-only) leaves ess_view_config untouched', async () => {
    const ltId = await leaveType(uniqCode(), { available: false });
    await updateLeaveType(adminCtx(b), { id: ltId, name: uniqCode(), requiresDocument: true });
    const t = (await listLeaveTypes(adminCtx(b), { includeArchived: true })).find((x) => x.id === ltId);
    // The pre-existing config must survive a save that never carried the essView marker.
    expect((t?.essViewConfig as Record<string, boolean> | null)?.available).toBe(false);
  });

  it('rejects an unknown component key', async () => {
    const ltId = await leaveType(uniqCode(), null);
    await expect(
      updateLeaveType(adminCtx(b), {
        id: ltId,
        name: uniqCode(),
        essViewConfig: { notARealComponent: false } as Record<string, boolean>,
      }),
    ).rejects.toThrow(/Unknown leave-view component key/);
  });

  it('an all-visible / empty config collapses to null', async () => {
    const ltId = await leaveType(uniqCode(), { available: false });
    await updateLeaveType(adminCtx(b), { id: ltId, name: uniqCode(), essViewConfig: {} });
    const t = (await listLeaveTypes(adminCtx(b), { includeArchived: true })).find((x) => x.id === ltId);
    expect(t?.essViewConfig).toBeNull();
  });

  it('records the change in its own audit block against the correct prior value', async () => {
    const ltId = await leaveType(uniqCode(), { available: true });
    await updateLeaveType(adminCtx(b), { id: ltId, name: uniqCode(), essViewConfig: { available: false } });
    const payload = await latestEventPayload(b.tenantId, ltId, 'leave-type.updated');
    const before = payload?.before as Record<string, unknown>;
    const after = payload?.after as Record<string, unknown>;
    expect((before.essViewConfig as Record<string, boolean> | null)?.available).toBe(true);
    expect((after.essViewConfig as Record<string, boolean> | null)?.available).toBe(false);
  });

  it('a doc-only save does NOT claim an essViewConfig change in the audit event', async () => {
    const ltId = await leaveType(uniqCode(), { available: false });
    await updateLeaveType(adminCtx(b), { id: ltId, name: uniqCode(), requiresDocument: true });
    const payload = await latestEventPayload(b.tenantId, ltId, 'leave-type.updated');
    const before = payload?.before as Record<string, unknown> | undefined;
    const after = payload?.after as Record<string, unknown> | undefined;
    expect('essViewConfig' in (before ?? {})).toBe(false);
    expect('essViewConfig' in (after ?? {})).toBe(false);
  });
});

describe('read layer — resolved essView threaded onto balances & breakdown', () => {
  it('default (null config) ⇒ leaveBalances row is all-visible', async () => {
    const { ctx, employmentId } = await hireEmployeeCtx();
    await leaveType(uniqCode(), null);
    const rows = await leaveBalances(ctx, employmentId);
    expect(rows.length).toBeGreaterThan(0);
    for (const r of rows) {
      expect(r.essView.available).toBe(true);
      expect(r.essView.forfeited).toBe(true);
    }
  });

  it('a hidden key reaches the leaveBalances row for that type; other types stay visible', async () => {
    const { ctx, employmentId } = await hireEmployeeCtx();
    const hiddenId = await leaveType(uniqCode(), { available: false, taken: false });
    const openId = await leaveType(uniqCode(), null);
    const rows = await leaveBalances(ctx, employmentId);
    const hidden = rows.find((r) => r.leaveTypeId === hiddenId);
    const open = rows.find((r) => r.leaveTypeId === openId);
    expect(hidden?.essView.available).toBe(false);
    expect(hidden?.essView.taken).toBe(false);
    expect(hidden?.essView.pendingApproval).toBe(true); // untouched key ⇒ visible
    expect(open?.essView.available).toBe(true);
  });

  it('leaveEntitlementBreakdown carries the resolved essView (missing ⇒ visible, false honoured)', async () => {
    const { ctx, employmentId } = await hireEmployeeCtx();
    const ltId = await leaveType(uniqCode(), { transactionHistory: false });
    const bd = await leaveEntitlementBreakdown(ctx, employmentId, ltId, '2026-06-15');
    expect(bd).not.toBeNull();
    expect(bd!.essView.transactionHistory).toBe(false);
    expect(bd!.essView.available).toBe(true);
  });
});

describe('gating contract — /me gates, admin/HR does not', () => {
  it('applyEssConfig=false ⇒ every component shows even when the config hides it (admin/HR view)', () => {
    const essView = resolveEssView({ available: false, transactionHistory: false });
    // Admin passes applyEssConfig=false — nothing is ever hidden.
    expect(show(false, essView, 'available')).toBe(true);
    expect(show(false, essView, 'transactionHistory')).toBe(true);
  });

  it('applyEssConfig=true ⇒ a hidden component is gated out, a visible one stays (the /me view)', () => {
    const essView = resolveEssView({ available: false });
    expect(show(true, essView, 'available')).toBe(false);
    expect(show(true, essView, 'taken')).toBe(true); // missing key ⇒ visible
  });
});
