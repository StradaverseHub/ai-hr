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
  DEFAULT_ORDER,
  isDefaultOrder,
  normalizeDashboardOrder,
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
});

/** Write a raw value straight through the SECURITY DEFINER seam (bypassing normalisation) to simulate a
 *  legacy stored layout. Uses the app-role db under the caller's session GUCs. */
async function withRawSeam(ctx: SessionContext, raw: unknown): Promise<void> {
  const { withTenant } = await import('../db/client');
  await withTenant(ctx, async (tx) => {
    await tx.execute(sql`select app.dashboard_layout_set(${JSON.stringify(raw)}::jsonb)`);
  });
}
