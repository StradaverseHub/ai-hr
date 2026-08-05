/**
 * Employee Dashboard Customization — Add / Remove / Shortcut (feedback 578a2fcf).
 *
 * Covers the expected_function point-by-point off the layer that is testable without a DOM:
 *  1. Add   — a card the employee selects (not default) persists in `selected`.
 *  2. Remove — an OPTIONAL card dropped from `selected` STAYS dropped (the old normalizer force-re-added
 *              it; this is the direct blocker-fix — a removed card can now persist).
 *  3. Mandatory — a mandatory card is ALWAYS in `selected`, even when the saved set omits it (the UI shows
 *              a shake + message; the data layer simply refuses to drop it).
 *  4. Only employee-selectable cards are offered in the Add menu (the addable filter).
 *  5. Shortcut / action cards carry their configured cardType + href through the read layer so the island
 *     can render them as clickable links.
 *  6. Unknown / disabled cards in a saved layout are dropped; the HR default (mandatory + default-display)
 *     is used when nothing is saved; a legacy order-only array still loads.
 *  7. End-to-end persistence against a REAL tenant card config, incl. mandatory force-inclusion.
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { SessionContext } from '../db/client';
import * as schema from '../db/schema';
import {
  BUILTIN_DASHBOARD_CARDS,
  normalizeDashboardLayout,
  type DashboardCardChoice,
} from '../lib/dashboard-layout';
import { getDashboardLayout, setDashboardLayout } from '../core/dashboard-prefs';
import { listDashboardCards, listEmployeeDashboardCards } from '../core/dashboard-card-config';
import { closeAll, migrateTestDb, owner, resetDb, seedBase, type Base } from './harness';

const choice = (cardKey: string, over: Partial<DashboardCardChoice> = {}): DashboardCardChoice => ({
  cardKey,
  employeeSelectable: true,
  defaultDisplay: false,
  mandatory: false,
  displayOrder: 0,
  ...over,
});

describe('normalizeDashboardLayout (pure add / remove / mandatory / drop)', () => {
  const cards: DashboardCardChoice[] = [
    choice('leaveBalance', { defaultDisplay: true, displayOrder: 1 }),
    choice('nextHoliday', { defaultDisplay: true, displayOrder: 2 }),
    choice('pendingTasks', { defaultDisplay: false, displayOrder: 3 }), // optional, hidden by default
    choice('announcements', { mandatory: true, defaultDisplay: true, displayOrder: 4 }), // mandatory
    choice('applyLeave', { employeeSelectable: true, defaultDisplay: false, displayOrder: 5 }), // add-only
  ];

  it('HR default (no saved value) = mandatory + default-display cards, in display order', () => {
    const { selected, order } = normalizeDashboardLayout(null, cards);
    expect(selected).toEqual(['leaveBalance', 'nextHoliday', 'announcements']);
    expect(order).toEqual(['leaveBalance', 'nextHoliday', 'pendingTasks', 'announcements', 'applyLeave']);
  });

  it('ADD: a selected non-default card persists in `selected`', () => {
    const { selected } = normalizeDashboardLayout(
      { selected: ['leaveBalance', 'applyLeave'], order: ['leaveBalance', 'applyLeave'] },
      cards,
    );
    expect(selected).toContain('applyLeave');
  });

  it('REMOVE: an optional card dropped from the saved set STAYS dropped (no force re-add)', () => {
    // leaveBalance is default-display, but the employee removed it → it must NOT come back.
    const { selected } = normalizeDashboardLayout(
      { selected: ['nextHoliday'], order: ['nextHoliday'] },
      cards,
    );
    expect(selected).not.toContain('leaveBalance');
    expect(selected).toContain('nextHoliday');
  });

  it('MANDATORY: always included even when the saved set omits it', () => {
    const { selected } = normalizeDashboardLayout(
      { selected: ['nextHoliday'], order: ['nextHoliday'] },
      cards,
    );
    expect(selected).toContain('announcements');
  });

  it('drops unknown / disabled cardKeys from a saved layout', () => {
    const { selected, order } = normalizeDashboardLayout(
      { selected: ['leaveBalance', 'ghostCard'], order: ['leaveBalance', 'ghostCard'] },
      cards,
    );
    expect(selected).not.toContain('ghostCard');
    expect(order).not.toContain('ghostCard');
  });

  it('order always covers every available card exactly once', () => {
    const { order } = normalizeDashboardLayout({ selected: ['applyLeave'], order: ['applyLeave'] }, cards);
    expect(new Set(order)).toEqual(new Set(cards.map((c) => c.cardKey)));
    expect(order.length).toBe(cards.length);
  });

  it('legacy order-only array → everything shown, "cards" block flattened in place', () => {
    // a00c4f64 — 'plannedAbsences' is deliberately still in the fixture: it is exactly what a legacy
    // saved array contains, and it must now be DROPPED (the Leave Calendar left the catalogue for its own
    // screen) without disturbing the position of anything around it.
    const { selected, order } = normalizeDashboardLayout(
      ['recentActivity', 'cards', 'plannedAbsences', 'upcomingEvents'],
      BUILTIN_DASHBOARD_CARDS,
    );
    expect(new Set(selected)).toEqual(new Set(BUILTIN_DASHBOARD_CARDS.map((c) => c.cardKey)));
    expect(order.slice(0, 5)).toEqual([
      'recentActivity',
      'leaveBalance',
      'nextHoliday',
      'pendingTasks',
      'upcomingEvents',
    ]);
    expect(order).not.toContain('plannedAbsences');
  });

  it('empty card config falls back to the built-in catalog (never blank)', () => {
    const { selected } = normalizeDashboardLayout(null, []);
    expect(new Set(selected)).toEqual(new Set(BUILTIN_DASHBOARD_CARDS.map((c) => c.cardKey)));
  });
});

describe('Add-menu offering (only employee-selectable, not-shown cards)', () => {
  it('offers employee-selectable cards not currently visible', () => {
    const cards: DashboardCardChoice[] = [
      choice('a', { employeeSelectable: true }),
      choice('b', { employeeSelectable: true }),
      choice('c', { employeeSelectable: false }), // HR excluded from employee selection
    ];
    const visible = ['a'];
    const addable = cards.filter((c) => c.employeeSelectable && !visible.includes(c.cardKey)).map((c) => c.cardKey);
    expect(addable).toEqual(['b']); // 'c' excluded (not selectable), 'a' excluded (already shown)
  });
});

// ─────────────────────── End-to-end against a real tenant card config ───────────────────────

let b: Base;

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

async function seedCards(rows: Array<Record<string, unknown>>): Promise<void> {
  await owner.db.insert(schema.dashboardCardConfig).values(
    rows.map((r) => ({ tenantId: b.tenantId, status: 'active', ...r })) as never,
  );
}

describe('dashboard cards — end-to-end read + persistence', () => {
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

  it('listEmployeeDashboardCards returns active cards with type + href (shortcut plumbing)', async () => {
    await seedCards([
      { cardKey: 'leaveBalance', name: 'Leave Balance', cardType: 'information', defaultDisplay: true, displayOrder: 1 },
      { cardKey: 'applyLeave', name: 'Apply Leave', cardType: 'shortcut', href: '/leave', employeeSelectable: true, defaultDisplay: false, displayOrder: 8 },
      { cardKey: 'oldCard', name: 'Retired', cardType: 'information', status: 'inactive', displayOrder: 9 },
    ]);
    const ctx = await newEmployeeCtx();
    const cards = await listEmployeeDashboardCards(ctx);
    const keys = cards.map((c) => c.cardKey);
    expect(keys).toContain('applyLeave');
    expect(keys).not.toContain('oldCard'); // inactive filtered out
    const shortcut = cards.find((c) => c.cardKey === 'applyLeave');
    expect(shortcut?.cardType).toBe('shortcut');
    expect(shortcut?.href).toBe('/leave');
  });

  it('a MANDATORY card cannot be removed — it persists in selected after a save that omits it', async () => {
    await seedCards([
      { cardKey: 'leaveBalance', name: 'Leave Balance', cardType: 'information', defaultDisplay: true, mandatory: true, displayOrder: 1 },
      { cardKey: 'nextHoliday', name: 'Upcoming Holidays', cardType: 'information', defaultDisplay: true, displayOrder: 2 },
    ]);
    const ctx = await newEmployeeCtx();
    const cards = await listEmployeeDashboardCards(ctx);
    // The client tries to save with the mandatory card removed; the data layer forces it back in.
    await setDashboardLayout(ctx, { selected: ['nextHoliday'], order: ['nextHoliday'] }, cards);
    const layout = await getDashboardLayout(ctx, cards);
    expect(layout.selected).toContain('leaveBalance');
  });

  it('an OPTIONAL card removed by the employee persists as removed', async () => {
    await seedCards([
      { cardKey: 'leaveBalance', name: 'Leave Balance', cardType: 'information', defaultDisplay: true, displayOrder: 1 },
      { cardKey: 'nextHoliday', name: 'Upcoming Holidays', cardType: 'information', defaultDisplay: true, displayOrder: 2 },
    ]);
    const ctx = await newEmployeeCtx();
    const cards = await listEmployeeDashboardCards(ctx);
    await setDashboardLayout(ctx, { selected: ['leaveBalance'], order: ['leaveBalance'] }, cards);
    const layout = await getDashboardLayout(ctx, cards);
    expect(layout.selected).toEqual(['leaveBalance']);
    expect(layout.selected).not.toContain('nextHoliday');
  });

  it('the role dimension (9606c59f) fences each catalog: a role only sees its audience', async () => {
    await seedCards([
      { cardKey: 'leaveBalance', name: 'Leave Balance', cardType: 'information', defaultDisplay: true, displayOrder: 1 }, // audience defaults to {employee}
      { cardKey: 'teamAwayToday', name: 'Team Away Today', cardType: 'information', defaultDisplay: true, displayOrder: 2, audience: ['manager'] },
      // a00c4f64 renamed this fixture off 'plannedAbsences' (the Leave Calendar left the catalogue for its
      // own screen). What the spec needs is A card shared by all three audiences AND mandatory; the key is
      // arbitrary, and naming a card that no longer exists would read as a claim that it does.
      { cardKey: 'sharedSection', name: 'Shared Section', cardType: 'information', defaultDisplay: true, mandatory: true, displayOrder: 3, audience: ['employee', 'manager', 'hr_admin'] },
      { cardKey: 'headcountByCompany', name: 'Headcount by Company', cardType: 'information', defaultDisplay: true, displayOrder: 4, audience: ['hr_admin'] },
    ]);
    const ctx = await newEmployeeCtx();
    expect((await listDashboardCards(ctx, 'employee')).map((c) => c.cardKey)).toEqual([
      'leaveBalance',
      'sharedSection',
    ]);
    expect((await listDashboardCards(ctx, 'manager')).map((c) => c.cardKey)).toEqual([
      'teamAwayToday',
      'sharedSection',
    ]);
    expect((await listDashboardCards(ctx, 'hr_admin')).map((c) => c.cardKey)).toEqual([
      'sharedSection',
      'headcountByCompany',
    ]);
    // A save can never smuggle an out-of-role card in: normalisation against the role catalog drops it.
    const mgrCards = await listDashboardCards(ctx, 'manager');
    await setDashboardLayout(
      ctx,
      { selected: ['teamAwayToday', 'headcountByCompany'], order: ['teamAwayToday', 'headcountByCompany'] },
      mgrCards,
      'manager',
    );
    const layout = await getDashboardLayout(ctx, mgrCards, 'manager');
    expect(layout.selected).toEqual(['teamAwayToday', 'sharedSection']); // hr_admin-only card dropped; mandatory card kept
  });
});
