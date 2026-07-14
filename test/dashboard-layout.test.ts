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
  DEFAULT_ORDER,
  isDefaultOrder,
  normalizeDashboardOrder,
} from '../lib/dashboard-layout';
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
  it('returns null (→ default) when nothing is saved', async () => {
    const ctx = await newEmployeeCtx();
    expect(await getDashboardLayout(ctx)).toBeNull();
  });

  it('saves an order that persists and reloads on the next read', async () => {
    const ctx = await newEmployeeCtx();
    const order = ['recentActivity', 'cards', 'upcomingEvents', 'plannedAbsences', 'recentlyJoined'];
    await setDashboardLayout(ctx, order);
    expect(await getDashboardLayout(ctx)).toEqual(order);
  });

  it('normalizes a partial saved order on the way in', async () => {
    const ctx = await newEmployeeCtx();
    await setDashboardLayout(ctx, ['upcomingEvents']);
    const saved = await getDashboardLayout(ctx);
    expect(saved?.[0]).toBe('upcomingEvents');
    expect(new Set(saved)).toEqual(new Set(DEFAULT_ORDER));
  });

  it('Reset to Default clears the saved layout back to null', async () => {
    const ctx = await newEmployeeCtx();
    await setDashboardLayout(ctx, ['recentActivity', 'cards']);
    expect(await getDashboardLayout(ctx)).not.toBeNull();
    await resetDashboardLayout(ctx);
    expect(await getDashboardLayout(ctx)).toBeNull();
  });

  it("one employee's layout does not affect another's", async () => {
    const a = await newEmployeeCtx();
    const c = await newEmployeeCtx();
    const orderA = ['recentActivity', 'cards', 'plannedAbsences', 'recentlyJoined', 'upcomingEvents'];
    await setDashboardLayout(a, orderA);
    // B has saved nothing → still default; and saving B must not disturb A.
    expect(await getDashboardLayout(c)).toBeNull();
    const orderC = ['upcomingEvents', 'recentlyJoined', 'plannedAbsences', 'cards', 'recentActivity'];
    await setDashboardLayout(c, orderC);
    expect(await getDashboardLayout(a)).toEqual(orderA);
    expect(await getDashboardLayout(c)).toEqual(orderC);
  });

  it('appends NO domain event (deliberate substrate carve-out for a cosmetic UI pref)', async () => {
    const ctx = await newEmployeeCtx();
    await setDashboardLayout(ctx, ['recentActivity', 'cards']);
    await resetDashboardLayout(ctx);
    const rows = (await owner.db.execute(
      sql`select count(*)::int as n from domain_event
          where tenant_id = ${b.tenantId} and aggregate_type = 'dashboard-layout'`,
    )) as unknown as { n: number }[];
    expect(rows[0]?.n ?? 0).toBe(0);
  });
});
