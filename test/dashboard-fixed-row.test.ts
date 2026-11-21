/**
 * Feedback 2806443b — "Reorganize Employee Dashboard Cards Layout and Update Card Pinning Behavior",
 * as amended by a00c4f64 — "Team Leave Tracker: move the Leave Calendar off the Dashboard".
 *
 * 2806443b made the dashboard three areas (a top row, a pinned full-width row holding only the Leave Calendar,
 * and an area below). a00c4f64 moved that calendar to its own screen (/leave/tracker), retiring the one card that
 * was ever pinned and the one that was ever mandatory. The old dashboard and its row partition were then retired
 * altogether (owner decision, 12 Nov 2026); what remains is the card catalogue and the normaliser every saved
 * Home layout still passes through (core/dashboard-prefs.ts).
 *
 * Pure specs: the builtin default order is unchanged by the move (leaveBalance · nextHoliday · pendingTasks ·
 * upcomingEvents first); no builtin card is mandatory any more; and a saved layout that still names
 * plannedAbsences drops it on read WITH THE OTHER CARDS' ORDER INTACT — the reason a00c4f64 needs no
 * app_user.dashboard_layout migration.
 *
 * DB specs (harness trap: migrateTestDb runs against a template stamped BEFORE seedBase creates tenants,
 * so the 0212 CROSS JOIN seed leaves dashboard_card_config empty here — every spec first executes the
 * 0212 seed INSERT manually, then the later migrations' statements): the 0296 order swap still applies;
 * 0404 deletes the plannedAbsences row for every tenant and repoints teamAwayToday's href; both 0404
 * statements are idempotent; and a layout saved naming the deleted card normalises without it.
 */
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { SessionContext } from '../db/client';
import * as schema from '../db/schema';
import {
  BUILTIN_DASHBOARD_CARDS,
  normalizeDashboardLayout,
  type DashboardCardChoice,
} from '../lib/dashboard-layout';
import { listCards, listEmployeeDashboardCards, type DashboardCardAudience } from '../core/dashboard-card-config';
import { closeAll, migrateTestDb, owner, resetDb, seedBase, type Base } from './harness';

describe('normalizeDashboardLayout against the builtin catalog (a00c4f64 flags)', () => {
  it('the Leave Calendar is out of the catalog and NOTHING is mandatory any more', () => {
    expect(BUILTIN_DASHBOARD_CARDS.find((c) => c.cardKey === 'plannedAbsences')).toBeUndefined();
    // It was the only mandatory card; with it gone every builtin card is removable. (The manager and HR-admin
    // builtin catalogs were retired with the old dashboard on 12 Nov 2026.)
    expect(BUILTIN_DASHBOARD_CARDS.filter((c) => c.mandatory).map((c) => c.cardKey)).toEqual([]);
    // Display-order swap (0296) is untouched by the move: upcomingEvents 5, recentlyJoined 6.
    expect(BUILTIN_DASHBOARD_CARDS.find((c) => c.cardKey === 'upcomingEvents')!.displayOrder).toBe(5);
    expect(BUILTIN_DASHBOARD_CARDS.find((c) => c.cardKey === 'recentlyJoined')!.displayOrder).toBe(6);
  });

  it('an omitted card now STAYS omitted — there is no force-re-add left to override it', () => {
    const { selected } = normalizeDashboardLayout(
      { selected: ['leaveBalance', 'nextHoliday'], order: ['leaveBalance', 'nextHoliday'] },
      BUILTIN_DASHBOARD_CARDS,
    );
    expect(selected).toEqual(['leaveBalance', 'nextHoliday']);
    expect(selected).not.toContain('pendingTasks');
  });

  it('A SAVED LAYOUT NAMING THE CALENDAR DROPS IT AND KEEPS EVERY OTHER CARD IN ORDER', () => {
    // This is the assertion that stands in for the app_user.dashboard_layout migration a00c4f64 does NOT
    // ship: `selected` and `order` are both filtered through the live catalogue, so a key that is no
    // longer a card is dropped on read — and, being no longer mandatory, is never force-re-added.
    const saved = {
      selected: ['leaveBalance', 'plannedAbsences', 'nextHoliday', 'recentActivity'],
      order: ['leaveBalance', 'plannedAbsences', 'nextHoliday', 'recentActivity', 'upcomingEvents'],
    };
    const { selected, order } = normalizeDashboardLayout(saved, BUILTIN_DASHBOARD_CARDS);
    expect(selected).toEqual(['leaveBalance', 'nextHoliday', 'recentActivity']);
    expect(selected).not.toContain('plannedAbsences');
    expect(order).not.toContain('plannedAbsences');
    // The surviving cards keep their saved relative order; unsaved cards append in HR display order.
    expect(order.slice(0, 4)).toEqual(['leaveBalance', 'nextHoliday', 'recentActivity', 'upcomingEvents']);
    expect(new Set(order)).toEqual(new Set(BUILTIN_DASHBOARD_CARDS.map((c) => c.cardKey)));
  });

  it('LEGACY saved layout (old regime forced pinned cards to the tail): pendingTasks surfaces as the LAST card', () => {
    // Under the old two-row regime the save flow rebuilt `visible` as [non-pinned..., pinned...], with
    // pendingTasks + plannedAbsences pinned — so an existing personal layout has them at the tail. The
    // calendar now falls out of that array entirely; pendingTasks keeps the position it had.
    const oldSaved = [
      'leaveBalance',
      'nextHoliday',
      'recentlyJoined',
      'upcomingEvents',
      'recentActivity',
      'pendingTasks',
      'plannedAbsences',
    ];
    const layout = normalizeDashboardLayout({ selected: oldSaved, order: oldSaved }, BUILTIN_DASHBOARD_CARDS);
    // pendingTasks is the last card of the flat order (its old fixed spot forced it there) — the
    // disclosed existing-user behavior.
    const flat = layout.selected;
    expect(flat).not.toContain('plannedAbsences');
    expect(flat[flat.length - 1]).toBe('pendingTasks');
    // noticeBoard is not in the saved SELECTION (it shipped later), so it lands in `order` only — an
    // explicit save is a closed set, unlike the legacy array form.
    expect(flat).not.toContain('noticeBoard');
    expect(flat).toEqual(['leaveBalance', 'nextHoliday', 'recentlyJoined', 'upcomingEvents', 'recentActivity', 'pendingTasks']);
  });
});

// ─────────────────────── DB specs: 0212 seed + 0296 / 0299 / 0391 / 0404 ───────────────────────

let b: Base;

const migrationsDir = path.join(__dirname, '..', 'db', 'migrations');
/** The 0212 CROSS JOIN seed INSERT (the file's last statement). */
const seed0212 = readFileSync(path.join(migrationsDir, '0212_dashboard_card_config.sql'), 'utf8')
  .split('--> statement-breakpoint')
  .pop()!;
/** The 0296 data-migration statements, in file order. */
const stmts0296 = readFileSync(path.join(migrationsDir, '0296_employee_dashboard_fixed_row.sql'), 'utf8')
  .split('--> statement-breakpoint');
/** The 0299 role-dimension statements (audience widen + manager/admin seed), in file order. */
const stmts0299 = readFileSync(path.join(migrationsDir, '0299_dashboard_card_audience.sql'), 'utf8')
  .split('--> statement-breakpoint');
/** 6e122302 — the Notice Board card seed. Replayed for the same reason as the three above: migrateTestDb
 *  stamps the template BEFORE seedBase creates a tenant, so every CROSS JOIN tenant seed lands on an empty
 *  table and has to be re-run here against the tenant this file makes. */
const stmts0391 = readFileSync(path.join(migrationsDir, '0391_notice_dashboard_card.sql'), 'utf8')
  .split('--> statement-breakpoint');
/** a00c4f64 — the calendar's rows deleted + the Team Away Today href repointed. */
const stmts0404 = readFileSync(path.join(migrationsDir, '0404_leave_calendar_off_dashboard.sql'), 'utf8')
  .split('--> statement-breakpoint');

async function runSeedAndMigration(): Promise<void> {
  await owner.db.execute(sql.raw(seed0212));
  for (const stmt of stmts0296) await owner.db.execute(sql.raw(stmt));
  for (const stmt of stmts0404) await owner.db.execute(sql.raw(stmt));
}

/** The full seed chain incl. the 9606c59f role dimension, the 6e122302 notice card and the a00c4f64
 *  removal (0212 seed → 0296 → 0299 → 0391 → 0404). The chain must stay COMPLETE: the "no drift" spec below
 *  compares what it produces against lib/dashboard-layout's builtin fallback, so a seed migration missing
 *  from here would report drift that does not exist — or, worse, hide drift that does. */
async function runFullSeedChain(): Promise<void> {
  await owner.db.execute(sql.raw(seed0212));
  for (const stmt of stmts0296) await owner.db.execute(sql.raw(stmt));
  for (const stmt of stmts0299) await owner.db.execute(sql.raw(stmt));
  for (const stmt of stmts0391) await owner.db.execute(sql.raw(stmt));
  for (const stmt of stmts0404) await owner.db.execute(sql.raw(stmt));
}

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

describe('0404 data migration — the Leave Calendar leaves the dashboard catalogue', () => {
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

  it('after the seed chain: no plannedAbsences row survives, and the 0296 order swap still applies', async () => {
    await runSeedAndMigration();
    const ctx = await newEmployeeCtx();
    const cards = await listEmployeeDashboardCards(ctx);
    expect(cards.length).toBe(6); // the 0212 seven, minus the calendar — real config rows, no fallback
    const byKey = new Map(cards.map((c) => [c.cardKey, c]));
    expect(byKey.has('plannedAbsences')).toBe(false);
    expect(byKey.get('pendingTasks')).toMatchObject({ mandatory: false });
    expect(byKey.get('upcomingEvents')!.displayOrder).toBe(5);
    expect(byKey.get('recentlyJoined')!.displayOrder).toBe(6);
    // The tenant default therefore normalises to the new arrangement.
    expect(normalizeDashboardLayout(null, cards).selected).toEqual(['leaveBalance', 'nextHoliday', 'pendingTasks', 'upcomingEvents', 'recentlyJoined', 'recentActivity']);
  });

  it('repoints the Team Away Today href off the dead in-page anchor', async () => {
    await runFullSeedChain();
    const rows = (await owner.db.execute(
      sql`SELECT href FROM dashboard_card_config
          WHERE tenant_id = ${b.tenantId} AND card_key = 'teamAwayToday'`,
    )) as unknown as { href: string }[];
    expect(rows[0].href).toBe('/leave/tracker');
  });

  it('leaves an HR-customised Team Away Today href alone (the guard is on the seeded value)', async () => {
    await owner.db.execute(sql.raw(seed0212));
    for (const stmt of stmts0299) await owner.db.execute(sql.raw(stmt));
    await owner.db.execute(
      sql`UPDATE dashboard_card_config SET href = '/approvals'
          WHERE tenant_id = ${b.tenantId} AND card_key = 'teamAwayToday'`,
    );
    for (const stmt of stmts0404) await owner.db.execute(sql.raw(stmt));
    const rows = (await owner.db.execute(
      sql`SELECT href FROM dashboard_card_config
          WHERE tenant_id = ${b.tenantId} AND card_key = 'teamAwayToday'`,
    )) as unknown as { href: string }[];
    expect(rows[0].href).toBe('/approvals');
  });

  it('the migration statements are idempotent (running them twice changes nothing more)', async () => {
    await runFullSeedChain();
    for (const stmt of stmts0404) await owner.db.execute(sql.raw(stmt)); // second run
    const ctx = await newEmployeeCtx();
    const cards = await listEmployeeDashboardCards(ctx);
    expect(cards.map((c) => c.cardKey)).not.toContain('plannedAbsences');
    // The guarded swap must NOT swap back on a re-run.
    const byKey = new Map(cards.map((c) => [c.cardKey, c]));
    expect(byKey.get('upcomingEvents')!.displayOrder).toBe(5);
    expect(byKey.get('recentlyJoined')!.displayOrder).toBe(6);
  });

  it('a layout saved before the calendar left normalises without it, and keeps the rest', async () => {
    // The DB half of the "no dashboard_layout migration needed" claim: the JSON is written before the
    // card is deleted, and read back after.
    await owner.db.execute(sql.raw(seed0212));
    for (const stmt of stmts0296) await owner.db.execute(sql.raw(stmt));
    const ctx = await newEmployeeCtx();
    const before = await listEmployeeDashboardCards(ctx);
    const keys = before.map((c) => c.cardKey);
    expect(keys).toContain('plannedAbsences');
    const saved = normalizeDashboardLayout({ selected: keys, order: keys }, before);
    // …now the card goes away.
    for (const stmt of stmts0404) await owner.db.execute(sql.raw(stmt));
    const after = await listEmployeeDashboardCards(ctx);
    const layout = normalizeDashboardLayout(saved, after);
    expect(layout.selected).not.toContain('plannedAbsences');
    expect(layout.order).not.toContain('plannedAbsences');
    expect(layout.selected).toEqual(keys.filter((k) => k !== 'plannedAbsences'));
  });

  it('an employee CAN remove Pending Tasks: the write rule keeps the removal', async () => {
    await runSeedAndMigration();
    const ctx = await newEmployeeCtx();
    const cards = await listEmployeeDashboardCards(ctx);
    const withoutTasks = cards.map((c) => c.cardKey).filter((k) => k !== 'pendingTasks');
    const layout = normalizeDashboardLayout({ selected: withoutTasks, order: withoutTasks }, cards);
    expect(layout.selected).not.toContain('pendingTasks');
  });

  // ─────────────────────── manager / hr_admin role parity (9606c59f) ───────────────────────

  // The Card Library's active cards for one audience, as listCards (the screen's own read) returns them. The old
  // dashboard's per-role reader was retired with it (12 Nov 2026); the seeded rows stay in the library.
  const audienceCards = async (ctx: SessionContext, role: DashboardCardAudience): Promise<DashboardCardChoice[]> =>
    (await listCards(ctx)).filter((c) => c.status === 'active' && c.audience.includes(role));
  const defaultOrder = (cards: readonly DashboardCardChoice[]) => normalizeDashboardLayout(null, cards).selected;
  // Drift guard: the manager DEFAULT order mirrors the old hardcoded manager dashboard — the three summary cards,
  // then upcomingEvents and the sections; 6e122302 appended noticeBoard at display_order 11.
  const MANAGER_DEFAULT = ['teamAwayToday', 'approvalRequests', 'upcomingReminders', 'upcomingEvents', 'recentlyJoined', 'recentActivity', 'attendanceOverview', 'noticeBoard'];
  // Drift guard: the hr_admin DEFAULT keeps the old top stat row, then the section cards, then noticeBoard.
  const ADMIN_DEFAULT = ['headcount', 'pendingLeave', 'companies', 'latestPayroll', 'upcomingEvents', 'recentlyJoined', 'recentActivity',
    'attendanceOverview', 'headcountByCompany', 'latestPayrollRun', 'noticeBoard'];

  it('manager/admin DEFAULT parity off the seeded catalog (drift guard vs the old hardcoded order)', async () => {
    await runFullSeedChain();
    const ctx = await newEmployeeCtx();
    expect(defaultOrder(await audienceCards(ctx, 'manager'))).toEqual(MANAGER_DEFAULT);
    expect(defaultOrder(await audienceCards(ctx, 'hr_admin'))).toEqual(ADMIN_DEFAULT);
  });

  it('the employee builtin catalog keeps its 2806443b arrangement minus the calendar', () => {
    expect(defaultOrder(BUILTIN_DASHBOARD_CARDS)).toEqual(['leaveBalance', 'nextHoliday', 'pendingTasks', 'upcomingEvents', 'recentlyJoined', 'recentActivity', 'noticeBoard']);
  });

  it('the calendar is gone for manager and hr_admin too, not just the employee', async () => {
    await runFullSeedChain();
    const ctx = await newEmployeeCtx();
    for (const role of ['manager', 'hr_admin'] as const) {
      const cards = await audienceCards(ctx, role);
      expect(cards.map((c) => c.cardKey), role).not.toContain('plannedAbsences');
    }
  });

  it('an OPTIONAL manager card removal is kept by the write rule (remove works for every role catalog)', async () => {
    await runFullSeedChain();
    const ctx = await newEmployeeCtx();
    const cards = await audienceCards(ctx, 'manager');
    const withoutAway = cards.map((c) => c.cardKey).filter((k) => k !== 'teamAwayToday');
    const layout = normalizeDashboardLayout({ selected: withoutAway, order: withoutAway }, cards);
    expect(layout.selected).not.toContain('teamAwayToday');
  });

  it('the role catalogs stay separate: manager/admin cards never surface on the employee list', async () => {
    await runFullSeedChain();
    const ctx = await newEmployeeCtx();
    const empKeys = (await listEmployeeDashboardCards(ctx)).map((c) => c.cardKey);
    // 7 from the 0212/0296 seed + noticeBoard from 0391 (6e122302, audienced to ALL THREE roles because a
    // notice targets an employment), minus the calendar 0404 deleted. This spec's point is unchanged: no
    // MANAGER-ONLY or ADMIN-ONLY card leaks onto the employee list, which the loop below asserts by name.
    expect(empKeys).toHaveLength(7);
    for (const k of ['teamAwayToday', 'approvalRequests', 'upcomingReminders', 'headcount', 'pendingLeave', 'companies', 'latestPayroll', 'attendanceOverview', 'headcountByCompany', 'latestPayrollRun']) {
      expect(empKeys).not.toContain(k);
    }
  });
});
