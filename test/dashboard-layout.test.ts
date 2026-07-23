/**
 * Customizable employee dashboard layout (feedback 7d9d145d).
 *
 * Covers the expected_function points that are testable off the UI:
 *  - default order renders when no layout is saved (null → DEFAULT_ORDER)
 *  - saving an order persists and reloads on the next read
 *  - Reset to Default clears the saved layout back to null
 *  - one employee's layout is independent of another's (own-row-only SECURITY DEFINER write seam)
 *  - the pure normaliser repairs partial / unknown / duplicate stored orders (forward-compatible)
 *  - the layout write appends NO domain event (deliberate substrate carve-out — cosmetic UI pref)
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import type { SessionContext } from '../db/client';
import * as schema from '../db/schema';
import {
  getDashboardLayout,
  resetDashboardLayout,
  setDashboardLayout,
} from '../core/dashboard-prefs';
import {
  BUILTIN_DASHBOARD_CARDS,
  BUILTIN_ROLE_DASHBOARD_CARDS,
  DEFAULT_ORDER,
  extractRoleLayout,
  isDefaultOrder,
  mergeRoleLayout,
  normalizeDashboardOrder,
  removeRoleLayout,
} from '../lib/dashboard-layout';

/** The tenant has no dashboard_card_config rows in this suite (created after the 0212 seed), so drive the
 *  persistence tests off the built-in default catalog — the same fallback the live page uses. */
const CARDS = BUILTIN_DASHBOARD_CARDS;
const ALL_KEYS = CARDS.map((c) => c.cardKey);
import { closeAll, migrateTestDb, owner, resetDb, seedBase, type Base } from './harness';

let b: Base;

/** A fresh employee login identity (app_user + employee role), no person needed. */
async function newEmployeeCtx(): Promise<SessionContext> {
  const [u] = await owner.db
    .insert(schema.appUser)
    .values({ tenantId: b.tenantId, workosUserId: `user_${randomUUID()}`, personId: null })
    .returning({ id: schema.appUser.id });
  await owner.db
    .insert(schema.roleAssignment)
    .values({ tenantId: b.tenantId, appUserId: u.id, companyId: null, role: 'employee' });
  return { tenantId: b.tenantId, userId: u.id, roles: ['employee'] };
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

describe('dashboard-layout pure helpers', () => {
  it('DEFAULT_ORDER contains every block exactly once and is the default', () => {
    expect(new Set(DEFAULT_ORDER).size).toBe(DEFAULT_ORDER.length);
    expect(isDefaultOrder([...DEFAULT_ORDER])).toBe(true);
  });

  it('normalizes non-array / empty input to the default order', () => {
    expect(normalizeDashboardOrder(null)).toEqual([...DEFAULT_ORDER]);
    expect(normalizeDashboardOrder(undefined)).toEqual([...DEFAULT_ORDER]);
    expect(normalizeDashboardOrder('nope')).toEqual([...DEFAULT_ORDER]);
    expect(normalizeDashboardOrder([])).toEqual([...DEFAULT_ORDER]);
  });

  it('keeps a valid custom order and appends any missing blocks (forward-compatible)', () => {
    const partial = ['recentActivity', 'plannedAbsences'];
    const out = normalizeDashboardOrder(partial);
    expect(out.slice(0, 2)).toEqual(['recentActivity', 'plannedAbsences']);
    // every default block present exactly once
    expect(new Set(out)).toEqual(new Set(DEFAULT_ORDER));
    expect(out.length).toBe(DEFAULT_ORDER.length);
    expect(isDefaultOrder(out)).toBe(false);
  });

  it('drops unknown ids and de-duplicates', () => {
    const messy = ['cards', 'cards', 'bogus', 42, 'recentActivity'];
    const out = normalizeDashboardOrder(messy);
    expect(out.filter((x) => x === 'cards').length).toBe(1);
    expect(out).not.toContain('bogus');
    expect(new Set(out)).toEqual(new Set(DEFAULT_ORDER));
  });
});

describe('per-role layout envelope (pure, 9606c59f)', () => {
  const emp = { selected: ['leaveBalance'], order: ['leaveBalance'] };
  const mgr = { selected: ['teamAwayToday'], order: ['teamAwayToday'] };

  it('a LEGACY flat value is the employee slot; every other role reads "nothing saved"', () => {
    expect(extractRoleLayout(['recentActivity', 'cards'], 'employee')).toEqual(['recentActivity', 'cards']);
    expect(extractRoleLayout(['recentActivity', 'cards'], 'manager')).toBeNull();
    expect(extractRoleLayout(emp, 'employee')).toEqual(emp);
    expect(extractRoleLayout(emp, 'hr_admin')).toBeNull();
    expect(extractRoleLayout(null, 'employee')).toBeNull();
  });

  it('a role-keyed envelope yields each slot independently', () => {
    const raw = { employee: emp, manager: mgr };
    expect(extractRoleLayout(raw, 'employee')).toEqual(emp);
    expect(extractRoleLayout(raw, 'manager')).toEqual(mgr);
    expect(extractRoleLayout(raw, 'hr_admin')).toBeNull();
  });

  it('mergeRoleLayout replaces one slot and preserves the others; a legacy flat migrates to employee', () => {
    expect(mergeRoleLayout({ employee: emp }, 'manager', mgr)).toEqual({ employee: emp, manager: mgr });
    // legacy flat + a manager save → the flat value becomes the employee slot, nothing lost
    expect(mergeRoleLayout(emp, 'manager', mgr)).toEqual({ employee: emp, manager: mgr });
    // saving the same role overwrites its slot only
    const next = { selected: ['nextHoliday'], order: ['nextHoliday'] };
    expect(mergeRoleLayout({ employee: emp, manager: mgr }, 'employee', next)).toEqual({
      employee: next,
      manager: mgr,
    });
  });

  it('removeRoleLayout drops one slot, keeps the rest, and returns null when nothing remains', () => {
    expect(removeRoleLayout({ employee: emp, manager: mgr }, 'manager')).toEqual({ employee: emp });
    expect(removeRoleLayout({ employee: emp }, 'employee')).toBeNull();
    // legacy flat reset by the employee → everything gone (the pre-9606c59f behaviour)
    expect(removeRoleLayout(emp, 'employee')).toBeNull();
    // legacy flat reset by a manager → the employee's flat layout survives
    expect(removeRoleLayout(emp, 'manager')).toEqual({ employee: emp });
  });
});

describe('dashboard-layout persistence (own-row SECURITY DEFINER seam)', () => {
  it('returns the HR default when nothing is saved (default-display + mandatory cards)', async () => {
    const ctx = await newEmployeeCtx();
    const layout = await getDashboardLayout(ctx, CARDS);
    // Built-in catalog: all cards default-display → all shown, in display order.
    expect(new Set(layout.selected)).toEqual(new Set(ALL_KEYS));
    expect(layout.order).toEqual(ALL_KEYS);
  });

  it('saves a { selected, order } layout that persists and reloads on the next read', async () => {
    const ctx = await newEmployeeCtx();
    const selected = ['recentActivity', 'leaveBalance', 'upcomingEvents'];
    await setDashboardLayout(ctx, { selected, order: selected }, CARDS);
    const saved = await getDashboardLayout(ctx, CARDS);
    // selected preserved (order-preserving) + the mandatory Leave Calendar force-included (2806443b);
    // order covers every available card exactly once.
    expect(saved.selected).toEqual([...selected, 'plannedAbsences']);
    expect(new Set(saved.order)).toEqual(new Set(ALL_KEYS));
    expect(saved.order.slice(0, 3)).toEqual(selected);
  });

  it('reads a LEGACY order-only array as "everything shown, in that order" (backward compatible)', async () => {
    const ctx = await newEmployeeCtx();
    // Write a legacy order-only array straight through the seam (pre-578a2fcf shape, with the "cards" block).
    await withRawSeam(ctx, ['recentActivity', 'cards', 'plannedAbsences']);
    const saved = await getDashboardLayout(ctx, CARDS);
    expect(new Set(saved.selected)).toEqual(new Set(ALL_KEYS)); // legacy showed everything
    // The legacy "cards" block flattened into its three summary cardKeys, in place.
    expect(saved.order.slice(0, 5)).toEqual([
      'recentActivity',
      'leaveBalance',
      'nextHoliday',
      'pendingTasks',
      'plannedAbsences',
    ]);
  });

  it('Reset to Default clears the saved layout back to the HR default', async () => {
    const ctx = await newEmployeeCtx();
    await setDashboardLayout(ctx, { selected: ['recentActivity'], order: ['recentActivity'] }, CARDS);
    // The mandatory Leave Calendar (2806443b) is force-included alongside the chosen card.
    expect((await getDashboardLayout(ctx, CARDS)).selected).toEqual(['recentActivity', 'plannedAbsences']);
    await resetDashboardLayout(ctx);
    expect(new Set((await getDashboardLayout(ctx, CARDS)).selected)).toEqual(new Set(ALL_KEYS));
  });

  it("one employee's layout does not affect another's", async () => {
    const a = await newEmployeeCtx();
    const c = await newEmployeeCtx();
    const selA = ['recentActivity', 'leaveBalance'];
    await setDashboardLayout(a, { selected: selA, order: selA }, CARDS);
    // C has saved nothing → still HR default; and saving C must not disturb A. The mandatory Leave
    // Calendar (2806443b) rides along in every saved selection.
    expect(new Set((await getDashboardLayout(c, CARDS)).selected)).toEqual(new Set(ALL_KEYS));
    const selC = ['upcomingEvents', 'recentlyJoined'];
    await setDashboardLayout(c, { selected: selC, order: selC }, CARDS);
    expect((await getDashboardLayout(a, CARDS)).selected).toEqual([...selA, 'plannedAbsences']);
    expect((await getDashboardLayout(c, CARDS)).selected).toEqual([...selC, 'plannedAbsences']);
  });

  it('appends NO domain event (deliberate substrate carve-out for a cosmetic UI pref)', async () => {
    const ctx = await newEmployeeCtx();
    await setDashboardLayout(ctx, { selected: ['recentActivity'], order: ['recentActivity'] }, CARDS);
    await resetDashboardLayout(ctx);
    const rows = (await owner.db.execute(
      sql`select count(*)::int as n from domain_event
          where tenant_id = ${b.tenantId} and aggregate_type = 'dashboard-layout'`,
    )) as unknown as { n: number }[];
    expect(rows[0]?.n ?? 0).toBe(0);
  });

  // ─────────────────────── per-ROLE layouts (9606c59f) ───────────────────────

  const MGR_CARDS = BUILTIN_ROLE_DASHBOARD_CARDS.manager;

  it('one person saves independent employee AND manager layouts (promoted keeps both hats)', async () => {
    const ctx = await newEmployeeCtx();
    const selEmp = ['recentActivity', 'leaveBalance'];
    const selMgr = ['upcomingReminders', 'teamAwayToday'];
    await setDashboardLayout(ctx, { selected: selEmp, order: selEmp }, CARDS, 'employee');
    await setDashboardLayout(ctx, { selected: selMgr, order: selMgr }, MGR_CARDS, 'manager');
    // Each role slot round-trips against its own catalog; the mandatory calendar rides along in both.
    expect((await getDashboardLayout(ctx, CARDS, 'employee')).selected).toEqual([...selEmp, 'plannedAbsences']);
    expect((await getDashboardLayout(ctx, MGR_CARDS, 'manager')).selected).toEqual([...selMgr, 'plannedAbsences']);
    // The hr_admin slot was never saved → its HR default.
    const adminCards = BUILTIN_ROLE_DASHBOARD_CARDS.hr_admin;
    expect(new Set((await getDashboardLayout(ctx, adminCards, 'hr_admin')).selected)).toEqual(
      new Set(adminCards.map((c) => c.cardKey)),
    );
  });

  it('a LEGACY flat stored value reads as the EMPLOYEE layout; other roles get their default', async () => {
    const ctx = await newEmployeeCtx();
    await withRawSeam(ctx, { selected: ['recentActivity'], order: ['recentActivity'] }); // pre-9606c59f shape
    expect((await getDashboardLayout(ctx, CARDS, 'employee')).selected).toEqual(['recentActivity', 'plannedAbsences']);
    expect(new Set((await getDashboardLayout(ctx, MGR_CARDS, 'manager')).selected)).toEqual(
      new Set(MGR_CARDS.map((c) => c.cardKey)),
    );
  });

  it('a manager save MIGRATES a legacy flat value into the envelope without losing the employee layout', async () => {
    const ctx = await newEmployeeCtx();
    await withRawSeam(ctx, { selected: ['recentActivity'], order: ['recentActivity'] });
    const selMgr = ['approvalRequests'];
    await setDashboardLayout(ctx, { selected: selMgr, order: selMgr }, MGR_CARDS, 'manager');
    expect((await getDashboardLayout(ctx, CARDS, 'employee')).selected).toEqual(['recentActivity', 'plannedAbsences']);
    expect((await getDashboardLayout(ctx, MGR_CARDS, 'manager')).selected).toEqual(['approvalRequests', 'plannedAbsences']);
  });

  it('Reset is per-role: clearing the manager slot leaves the employee layout untouched (and vice versa)', async () => {
    const ctx = await newEmployeeCtx();
    const selEmp = ['recentActivity'];
    const selMgr = ['teamAwayToday'];
    await setDashboardLayout(ctx, { selected: selEmp, order: selEmp }, CARDS, 'employee');
    await setDashboardLayout(ctx, { selected: selMgr, order: selMgr }, MGR_CARDS, 'manager');
    await resetDashboardLayout(ctx, 'manager');
    expect(new Set((await getDashboardLayout(ctx, MGR_CARDS, 'manager')).selected)).toEqual(
      new Set(MGR_CARDS.map((c) => c.cardKey)), // back to the manager HR default
    );
    expect((await getDashboardLayout(ctx, CARDS, 'employee')).selected).toEqual(['recentActivity', 'plannedAbsences']);
    // Resetting the last remaining slot stores NULL again (the pre-9606c59f reset).
    await resetDashboardLayout(ctx, 'employee');
    expect(new Set((await getDashboardLayout(ctx, CARDS, 'employee')).selected)).toEqual(new Set(ALL_KEYS));
  });
});

/** Write a raw value straight through the SECURITY DEFINER seam (bypassing normalisation) to simulate a
 *  legacy stored layout. Uses the app-role db under the caller's session GUCs. */
async function withRawSeam(ctx: SessionContext, raw: unknown): Promise<void> {
  const { withTenant } = await import('../db/client');
  await withTenant(ctx, async (tx) => {
    await tx.execute(sql`select app.dashboard_layout_set(${JSON.stringify(raw)}::jsonb)`);
  });
}
