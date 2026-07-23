/**
 * Feedback 2806443b — "Reorganize Employee Dashboard Cards Layout and Update Card Pinning Behavior".
 *
 * The employee dashboard becomes three areas: a draggable top row of up to MAX_FIRST_ROW cards, a fixed
 * full-width second row holding ONLY the Leave Calendar (plannedAbsences), and a flexible third area below
 * it. Pending Tasks is unpinned (removable); the Leave Calendar becomes mandatory (non-removable).
 *
 * Pure specs: FIXED_ROW_KEYS membership; the three-way partitionDashboardRows split (pendingTasks in
 * row1, plannedAbsences alone in row2, 5th+ cards in row3); the new builtin default row 1
 * (leaveBalance · nextHoliday · pendingTasks · upcomingEvents); normalizeDashboardLayout force-re-adding
 * an omitted plannedAbsences while keeping an omitted pendingTasks removed; and the disclosed legacy
 * behavior — a layout saved under the old regime (pinned cards forced to the tail) surfaces pendingTasks
 * as the LAST non-pinned card.
 *
 * DB specs (harness trap: migrateTestDb runs against a template stamped BEFORE seedBase creates tenants,
 * so the 0212 CROSS JOIN seed leaves dashboard_card_config empty here — every spec first executes the
 * 0212 seed INSERT manually, then the 0296 migration's UPDATE statements): plannedAbsences becomes
 * mandatory (idempotently); a deactivated row stays inactive; dropping plannedAbsences from a saved
 * layout is force-reverted while dropping pendingTasks persists.
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
  BUILTIN_ROLE_DASHBOARD_CARDS,
  FIXED_ROW_KEYS,
  MAX_FIRST_ROW,
  isFixedRowKey,
  normalizeDashboardLayout,
  partitionDashboardRows,
  type DashboardCardChoice,
} from '../lib/dashboard-layout';
import { getDashboardLayout, setDashboardLayout } from '../core/dashboard-prefs';
import { listDashboardCards, listEmployeeDashboardCards } from '../core/dashboard-card-config';
import { closeAll, migrateTestDb, owner, resetDb, seedBase, type Base } from './harness';

/** Partition a layout with the production pin rule (FIXED_ROW_KEYS via isFixedRowKey). */
const partition = (selected: string[]) =>
  partitionDashboardRows({ selected, order: selected }, selected.filter(isFixedRowKey));

describe('FIXED_ROW_KEYS / isFixedRowKey (the single pin rule)', () => {
  it('pins ONLY the Leave Calendar', () => {
    expect([...FIXED_ROW_KEYS]).toEqual(['plannedAbsences']);
    expect(isFixedRowKey('plannedAbsences')).toBe(true);
    // Pending Tasks (cardType action) and shortcut-style cards are NOT pinned any more.
    expect(isFixedRowKey('pendingTasks')).toBe(false);
    expect(isFixedRowKey('leaveBalance')).toBe(false);
    expect(isFixedRowKey('applyLeave')).toBe(false);
    expect(isFixedRowKey('recentActivity')).toBe(false);
  });
});

describe('partitionDashboardRows — three-way split (2806443b)', () => {
  it('puts pendingTasks in row1, plannedAbsences alone in row2, and 5th+ cards in row3', () => {
    const selected = [
      'leaveBalance',
      'nextHoliday',
      'pendingTasks',
      'upcomingEvents',
      'plannedAbsences',
      'recentlyJoined',
      'recentActivity',
    ];
    const { row1, row2, row3 } = partition(selected);
    expect(row1).toEqual(['leaveBalance', 'nextHoliday', 'pendingTasks', 'upcomingEvents']);
    expect(row1.length).toBe(MAX_FIRST_ROW);
    expect(row2).toEqual(['plannedAbsences']); // the full-width fixed row is the calendar alone
    expect(row3).toEqual(['recentlyJoined', 'recentActivity']); // 5th+ non-pinned cards land BELOW the calendar
  });

  it('default builtin layout: row1 = leaveBalance · nextHoliday · pendingTasks · upcomingEvents', () => {
    const layout = normalizeDashboardLayout(null, BUILTIN_DASHBOARD_CARDS);
    const { row1, row2, row3 } = partitionDashboardRows(layout, layout.selected.filter(isFixedRowKey));
    expect(row1).toEqual(['leaveBalance', 'nextHoliday', 'pendingTasks', 'upcomingEvents']);
    expect(row2).toEqual(['plannedAbsences']);
    expect(row3).toEqual(['recentlyJoined', 'recentActivity']);
  });

  it('fewer than MAX_FIRST_ROW non-pinned cards → empty row3', () => {
    const { row1, row2, row3 } = partition(['leaveBalance', 'plannedAbsences', 'pendingTasks']);
    expect(row1).toEqual(['leaveBalance', 'pendingTasks']);
    expect(row2).toEqual(['plannedAbsences']);
    expect(row3).toEqual([]);
  });

  it('a removed calendar (config without it) partitions with an empty row2', () => {
    // Only reachable when HR deactivates the card entirely — employees can never remove it.
    const { row1, row2, row3 } = partition(['leaveBalance', 'nextHoliday']);
    expect(row1).toEqual(['leaveBalance', 'nextHoliday']);
    expect(row2).toEqual([]);
    expect(row3).toEqual([]);
  });
});

describe('normalizeDashboardLayout against the builtin catalog (2806443b flags)', () => {
  it('builtin plannedAbsences is mandatory; pendingTasks is optional', () => {
    const calendar = BUILTIN_DASHBOARD_CARDS.find((c) => c.cardKey === 'plannedAbsences')!;
    const tasks = BUILTIN_DASHBOARD_CARDS.find((c) => c.cardKey === 'pendingTasks')!;
    expect(calendar.mandatory).toBe(true);
    expect(tasks.mandatory).toBe(false);
    // Display-order swap: upcomingEvents 5, recentlyJoined 6.
    expect(BUILTIN_DASHBOARD_CARDS.find((c) => c.cardKey === 'upcomingEvents')!.displayOrder).toBe(5);
    expect(BUILTIN_DASHBOARD_CARDS.find((c) => c.cardKey === 'recentlyJoined')!.displayOrder).toBe(6);
  });

  it('force-re-adds an omitted plannedAbsences and keeps an omitted pendingTasks removed', () => {
    const { selected } = normalizeDashboardLayout(
      { selected: ['leaveBalance', 'nextHoliday'], order: ['leaveBalance', 'nextHoliday'] },
      BUILTIN_DASHBOARD_CARDS,
    );
    expect(selected).toContain('plannedAbsences'); // mandatory → cannot be dropped
    expect(selected).not.toContain('pendingTasks'); // optional → stays removed
  });

  it('LEGACY saved layout (old regime forced pinned cards to the tail): pendingTasks surfaces as the LAST non-pinned card', () => {
    // Under the old two-row regime the save flow rebuilt `visible` as [non-pinned..., pinned...], with
    // pendingTasks + plannedAbsences pinned — so an existing personal layout has them at the tail.
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
    const { row1, row2, row3 } = partitionDashboardRows(layout, layout.selected.filter(isFixedRowKey));
    expect(row2).toEqual(['plannedAbsences']);
    // pendingTasks is the last card of the flat non-pinned order (its old fixed spot forced it there) —
    // the disclosed existing-user behavior; the card now has a drag grip to move it up.
    const flat = [...row1, ...row3];
    expect(flat[flat.length - 1]).toBe('pendingTasks');
    expect(row1).toEqual(['leaveBalance', 'nextHoliday', 'recentlyJoined', 'upcomingEvents']);
    expect(row3).toEqual(['recentActivity', 'pendingTasks']);
  });
});

// ─────────────────────── DB specs: 0212 seed + 0296 data migration ───────────────────────

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

async function runSeedAndMigration(): Promise<void> {
  await owner.db.execute(sql.raw(seed0212));
  for (const stmt of stmts0296) await owner.db.execute(sql.raw(stmt));
}

/** The full seed chain incl. the 9606c59f role dimension (0212 seed → 0296 → 0299). */
async function runFullSeedChain(): Promise<void> {
  await runSeedAndMigration();
  for (const stmt of stmts0299) await owner.db.execute(sql.raw(stmt));
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

describe('0296 data migration — Leave Calendar mandatory + order swap', () => {
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

  it('after seed + migration: plannedAbsences is mandatory + default-shown; pendingTasks stays optional; order swap applied', async () => {
    await runSeedAndMigration();
    const ctx = await newEmployeeCtx();
    const cards = await listEmployeeDashboardCards(ctx);
    expect(cards.length).toBe(7); // real config rows — no builtin fallback involved
    const byKey = new Map(cards.map((c) => [c.cardKey, c]));
    expect(byKey.get('plannedAbsences')).toMatchObject({ mandatory: true, defaultDisplay: true });
    expect(byKey.get('pendingTasks')).toMatchObject({ mandatory: false });
    expect(byKey.get('upcomingEvents')!.displayOrder).toBe(5);
    expect(byKey.get('recentlyJoined')!.displayOrder).toBe(6);
    // The tenant default therefore partitions to the new arrangement.
    const layout = normalizeDashboardLayout(null, cards);
    const rows = partitionDashboardRows(layout, layout.selected.filter(isFixedRowKey));
    expect(rows.row1).toEqual(['leaveBalance', 'nextHoliday', 'pendingTasks', 'upcomingEvents']);
    expect(rows.row2).toEqual(['plannedAbsences']);
    expect(rows.row3).toEqual(['recentlyJoined', 'recentActivity']);
  });

  it('the migration statements are idempotent (running them twice changes nothing more)', async () => {
    await runSeedAndMigration();
    for (const stmt of stmts0296) await owner.db.execute(sql.raw(stmt)); // second run
    const ctx = await newEmployeeCtx();
    const cards = await listEmployeeDashboardCards(ctx);
    expect(cards.length).toBe(7);
    const byKey = new Map(cards.map((c) => [c.cardKey, c]));
    expect(byKey.get('plannedAbsences')).toMatchObject({ mandatory: true, defaultDisplay: true });
    // The guarded swap must NOT swap back on a re-run.
    expect(byKey.get('upcomingEvents')!.displayOrder).toBe(5);
    expect(byKey.get('recentlyJoined')!.displayOrder).toBe(6);
  });

  it('the guarded order swap leaves HR-customised display orders alone', async () => {
    await owner.db.execute(sql.raw(seed0212));
    // HR moved recentlyJoined to the front before the migration ran.
    await owner.db.execute(
      sql`UPDATE dashboard_card_config SET display_order = 1
          WHERE tenant_id = ${b.tenantId} AND card_key = 'recentlyJoined'`,
    );
    for (const stmt of stmts0296) await owner.db.execute(sql.raw(stmt));
    const ctx = await newEmployeeCtx();
    const byKey = new Map((await listEmployeeDashboardCards(ctx)).map((c) => [c.cardKey, c]));
    expect(byKey.get('recentlyJoined')!.displayOrder).toBe(1); // untouched
    expect(byKey.get('upcomingEvents')!.displayOrder).toBe(6); // untouched (guard requires BOTH seed values)
  });

  it('an employee cannot remove the Leave Calendar: a save dropping it is force-reverted', async () => {
    await runSeedAndMigration();
    const ctx = await newEmployeeCtx();
    const cards = await listEmployeeDashboardCards(ctx);
    const withoutCalendar = cards.map((c) => c.cardKey).filter((k) => k !== 'plannedAbsences');
    await setDashboardLayout(ctx, { selected: withoutCalendar, order: withoutCalendar }, cards);
    const layout = await getDashboardLayout(ctx, cards);
    expect(layout.selected).toContain('plannedAbsences');
  });

  it('an employee CAN remove Pending Tasks: the removal persists', async () => {
    await runSeedAndMigration();
    const ctx = await newEmployeeCtx();
    const cards = await listEmployeeDashboardCards(ctx);
    const withoutTasks = cards.map((c) => c.cardKey).filter((k) => k !== 'pendingTasks');
    await setDashboardLayout(ctx, { selected: withoutTasks, order: withoutTasks }, cards);
    const layout = await getDashboardLayout(ctx, cards);
    expect(layout.selected).not.toContain('pendingTasks');
    expect(layout.selected).toContain('plannedAbsences');
  });

  // ─────────────────────── manager / hr_admin role parity (9606c59f) ───────────────────────

  const expectManagerRows = (rows: { row1: string[]; row2: string[]; row3: string[] }) => {
    // Drift guard: the manager DEFAULT arrangement mirrors the old hardcoded manager dashboard — the three
    // summary cards up top (the 4th slot takes upcomingEvents, the employee-default convention), the
    // pinned calendar full width, and the sections below it.
    expect(rows.row1).toEqual(['teamAwayToday', 'approvalRequests', 'upcomingReminders', 'upcomingEvents']);
    expect(rows.row2).toEqual(['plannedAbsences']);
    expect(rows.row3).toEqual(['recentlyJoined', 'recentActivity', 'attendanceOverview']);
  };
  const expectAdminRows = (rows: { row1: string[]; row2: string[]; row3: string[] }) => {
    // Drift guard: the hr_admin DEFAULT keeps the old top stat row exactly, the pinned calendar, then the
    // section cards.
    expect(rows.row1).toEqual(['headcount', 'pendingLeave', 'companies', 'latestPayroll']);
    expect(rows.row2).toEqual(['plannedAbsences']);
    expect(rows.row3).toEqual([
      'upcomingEvents',
      'recentlyJoined',
      'recentActivity',
      'attendanceOverview',
      'headcountByCompany',
      'latestPayrollRun',
    ]);
  };
  const partitionDefault = (cards: readonly DashboardCardChoice[]) => {
    const layout = normalizeDashboardLayout(null, cards);
    return partitionDashboardRows(layout, layout.selected.filter(isFixedRowKey));
  };

  it('manager/admin DEFAULT parity off the seeded catalog (drift guard vs the old hardcoded order)', async () => {
    await runFullSeedChain();
    const ctx = await newEmployeeCtx();
    expectManagerRows(partitionDefault(await listDashboardCards(ctx, 'manager')));
    expectAdminRows(partitionDefault(await listDashboardCards(ctx, 'hr_admin')));
  });

  it('the builtin per-role fallback catalogs partition to the SAME defaults as the seeds (no drift)', () => {
    expectManagerRows(partitionDefault(BUILTIN_ROLE_DASHBOARD_CARDS.manager));
    expectAdminRows(partitionDefault(BUILTIN_ROLE_DASHBOARD_CARDS.hr_admin));
    // and the employee builtin is untouched by 9606c59f
    const rows = partitionDefault(BUILTIN_ROLE_DASHBOARD_CARDS.employee);
    expect(rows.row1).toEqual(['leaveBalance', 'nextHoliday', 'pendingTasks', 'upcomingEvents']);
    expect(rows.row2).toEqual(['plannedAbsences']);
    expect(rows.row3).toEqual(['recentlyJoined', 'recentActivity']);
  });

  it('the Leave Calendar stays MANDATORY + pinned for manager and hr_admin: a save dropping it is force-reverted', async () => {
    await runFullSeedChain();
    const ctx = await newEmployeeCtx();
    for (const role of ['manager', 'hr_admin'] as const) {
      const cards = await listDashboardCards(ctx, role);
      expect(cards.find((c) => c.cardKey === 'plannedAbsences')).toMatchObject({ mandatory: true });
      const withoutCalendar = cards.map((c) => c.cardKey).filter((k) => k !== 'plannedAbsences');
      await setDashboardLayout(ctx, { selected: withoutCalendar, order: withoutCalendar }, cards, role);
      const layout = await getDashboardLayout(ctx, cards, role);
      expect(layout.selected).toContain('plannedAbsences');
      // …and it still partitions into the fixed row (position is the shared FIXED_ROW_KEYS code rule).
      const rows = partitionDashboardRows(layout, layout.selected.filter(isFixedRowKey));
      expect(rows.row2).toEqual(['plannedAbsences']);
    }
  });

  it('an OPTIONAL manager card removal persists (remove works for the new roles too)', async () => {
    await runFullSeedChain();
    const ctx = await newEmployeeCtx();
    const cards = await listDashboardCards(ctx, 'manager');
    const withoutAway = cards.map((c) => c.cardKey).filter((k) => k !== 'teamAwayToday');
    await setDashboardLayout(ctx, { selected: withoutAway, order: withoutAway }, cards, 'manager');
    const layout = await getDashboardLayout(ctx, cards, 'manager');
    expect(layout.selected).not.toContain('teamAwayToday');
    expect(layout.selected).toContain('plannedAbsences');
  });

  it('the role catalogs stay separate: manager/admin cards never surface on the employee list', async () => {
    await runFullSeedChain();
    const ctx = await newEmployeeCtx();
    const empKeys = (await listEmployeeDashboardCards(ctx)).map((c) => c.cardKey);
    expect(empKeys).toHaveLength(7); // the employee dashboard is untouched by the role widening
    for (const k of ['teamAwayToday', 'approvalRequests', 'upcomingReminders', 'headcount', 'pendingLeave', 'companies', 'latestPayroll', 'attendanceOverview', 'headcountByCompany', 'latestPayrollRun']) {
      expect(empKeys).not.toContain(k);
    }
  });

  it('a plannedAbsences row HR deactivated stays inactive and off the employee list (status untouched)', async () => {
    await owner.db.execute(sql.raw(seed0212));
    await owner.db.execute(
      sql`UPDATE dashboard_card_config SET status = 'inactive'
          WHERE tenant_id = ${b.tenantId} AND card_key = 'plannedAbsences'`,
    );
    for (const stmt of stmts0296) await owner.db.execute(sql.raw(stmt));
    const rows = (await owner.db.execute(
      sql`SELECT status, mandatory FROM dashboard_card_config
          WHERE tenant_id = ${b.tenantId} AND card_key = 'plannedAbsences'`,
    )) as unknown as { status: string; mandatory: boolean }[];
    expect(rows[0]).toMatchObject({ status: 'inactive', mandatory: true }); // mandatory set, status untouched
    const ctx = await newEmployeeCtx();
    const cards = await listEmployeeDashboardCards(ctx);
    expect(cards.length).toBe(6); // 6 active rows — builtin fallback only kicks in at ZERO rows
    expect(cards.map((c) => c.cardKey)).not.toContain('plannedAbsences');
  });
});
