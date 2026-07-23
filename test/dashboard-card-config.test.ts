/**
 * HR-Admin Dashboard Card Master (feedback 1586d2f5) — the tenant-scoped catalog of dashboard cards HR
 * maintains. Covers:
 *  - create + list + getCard round-trip; ordering by displayOrder then name
 *  - unique card_key per tenant (DuplicateCardKeyError, both service pre-check and DB net)
 *  - MANDATORY implies DEFAULT-DISPLAY (on create AND on update)
 *  - status toggle + full CRUD emit dashboard-card-config.* domain events
 *  - the migration seed statement populates the R39 block/card set (7 cardKeys) for a tenant
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  createCard,
  deleteCard,
  DuplicateCardKeyError,
  getCard,
  listCards,
  listDashboardCards,
  setStatus,
  updateCard,
} from '../core/dashboard-card-config';
import { adminCtx, closeAll, eventTypesFor, latestEventPayload, migrateTestDb, owner, resetDb, seedBase, type Base } from './harness';

let b: Base;

beforeAll(async () => {
  await migrateTestDb();
});
beforeEach(async () => {
  await resetDb();
  b = await seedBase();
});
afterAll(async () => {
  await closeAll();
});

describe('Dashboard Card Master — CRUD + reads', () => {
  it('creates a card and round-trips its fields', async () => {
    const a = adminCtx(b);
    const { id } = await createCard(a, {
      cardKey: 'leaveBalance',
      name: 'Leave Balance',
      description: 'Your leave balance.',
      cardType: 'information',
      employeeSelectable: true,
      defaultDisplay: true,
      displayOrder: 1,
      href: '/leave',
    });
    expect(await getCard(a, id)).toMatchObject({
      cardKey: 'leaveBalance',
      name: 'Leave Balance',
      cardType: 'information',
      status: 'active',
      employeeSelectable: true,
      defaultDisplay: true,
      mandatory: false,
      displayOrder: 1,
      href: '/leave',
    });
  });

  it('lists cards ordered by displayOrder then name', async () => {
    const a = adminCtx(b);
    await createCard(a, { cardKey: 'c3', name: 'Zeta', displayOrder: 3 });
    await createCard(a, { cardKey: 'c1', name: 'Alpha', displayOrder: 1 });
    await createCard(a, { cardKey: 'c2', name: 'Beta', displayOrder: 1 });
    const keys = (await listCards(a)).map((c) => c.cardKey);
    // order 1 rows first (Alpha before Beta by name), then order 3.
    expect(keys).toEqual(['c1', 'c2', 'c3']);
  });

  it('updates a card and can rename its key', async () => {
    const a = adminCtx(b);
    const { id } = await createCard(a, { cardKey: 'old', name: 'Old', cardType: 'information' });
    await updateCard(a, { id, cardKey: 'new', name: 'New', cardType: 'shortcut', displayOrder: 9 });
    expect(await getCard(a, id)).toMatchObject({ cardKey: 'new', name: 'New', cardType: 'shortcut', displayOrder: 9 });
  });

  it('setStatus toggles active/inactive', async () => {
    const a = adminCtx(b);
    const { id } = await createCard(a, { cardKey: 'k', name: 'K' });
    await setStatus(a, { id, status: 'inactive' });
    expect((await getCard(a, id))?.status).toBe('inactive');
    await setStatus(a, { id, status: 'active' });
    expect((await getCard(a, id))?.status).toBe('active');
  });

  it('deletes a card', async () => {
    const a = adminCtx(b);
    const { id } = await createCard(a, { cardKey: 'gone', name: 'Gone' });
    await deleteCard(a, { id });
    expect(await getCard(a, id)).toBeNull();
  });
});

describe('Dashboard Card Master — validation', () => {
  it('rejects a duplicate card_key in the same tenant', async () => {
    const a = adminCtx(b);
    await createCard(a, { cardKey: 'dup', name: 'One' });
    await expect(createCard(a, { cardKey: 'dup', name: 'Two' })).rejects.toBeInstanceOf(DuplicateCardKeyError);
  });

  it('rejects renaming a key onto an existing key', async () => {
    const a = adminCtx(b);
    await createCard(a, { cardKey: 'a', name: 'A' });
    const { id } = await createCard(a, { cardKey: 'b', name: 'B' });
    await expect(updateCard(a, { id, cardKey: 'a' })).rejects.toBeInstanceOf(DuplicateCardKeyError);
  });

  it('MANDATORY implies DEFAULT-DISPLAY on create (mandatory=true forces defaultDisplay=true)', async () => {
    const a = adminCtx(b);
    const { id } = await createCard(a, { cardKey: 'm', name: 'M', mandatory: true, defaultDisplay: false });
    expect(await getCard(a, id)).toMatchObject({ mandatory: true, defaultDisplay: true });
  });

  it('MANDATORY implies DEFAULT-DISPLAY on update', async () => {
    const a = adminCtx(b);
    const { id } = await createCard(a, { cardKey: 'm2', name: 'M2', mandatory: false, defaultDisplay: false });
    await updateCard(a, { id, mandatory: true, defaultDisplay: false });
    expect(await getCard(a, id)).toMatchObject({ mandatory: true, defaultDisplay: true });
  });

  it('rejects an invalid card_key shape', async () => {
    const a = adminCtx(b);
    await expect(createCard(a, { cardKey: 'bad key!', name: 'X' })).rejects.toThrow();
  });
});

describe('Dashboard Card Master — substrate', () => {
  it('CRUD emits dashboard-card-config.* domain events', async () => {
    const a = adminCtx(b);
    const { id } = await createCard(a, { cardKey: 'ev', name: 'Ev' });
    await updateCard(a, { id, name: 'Ev2' });
    await setStatus(a, { id, status: 'inactive' });
    await setStatus(a, { id, status: 'active' });
    await deleteCard(a, { id });
    expect(await eventTypesFor(b.tenantId, id)).toEqual(
      expect.arrayContaining([
        'dashboard-card-config.created',
        'dashboard-card-config.updated',
        'dashboard-card-config.deactivated',
        'dashboard-card-config.activated',
        'dashboard-card-config.deleted',
      ]),
    );
  });
});

describe('Dashboard Card Master — audience (role dimension, 9606c59f)', () => {
  it('defaults audience to employee and round-trips a custom audience', async () => {
    const a = adminCtx(b);
    const { id } = await createCard(a, { cardKey: 'noAud', name: 'No Audience' });
    expect((await getCard(a, id))?.audience).toEqual(['employee']);
    const { id: id2 } = await createCard(a, {
      cardKey: 'mgrOnly',
      name: 'Manager Only',
      audience: ['hr_admin', 'manager'],
    });
    // canonical order (employee, manager, hr_admin) regardless of the given order
    expect((await getCard(a, id2))?.audience).toEqual(['manager', 'hr_admin']);
  });

  it('normalizes audience: unknown roles dropped, empty/garbage falls back to employee', async () => {
    const a = adminCtx(b);
    const { id } = await createCard(a, { cardKey: 'weird', name: 'Weird', audience: ['ghost', 'manager'] });
    expect((await getCard(a, id))?.audience).toEqual(['manager']);
    const { id: id2 } = await createCard(a, { cardKey: 'emptyAud', name: 'Empty', audience: [] });
    expect((await getCard(a, id2))?.audience).toEqual(['employee']);
  });

  it('update retargets audience; an omitted audience leaves it unchanged', async () => {
    const a = adminCtx(b);
    const { id } = await createCard(a, { cardKey: 'ret', name: 'Ret', audience: ['employee'] });
    await updateCard(a, { id, name: 'Ret2' }); // no audience → untouched
    expect(await getCard(a, id)).toMatchObject({ name: 'Ret2', audience: ['employee'] });
    await updateCard(a, { id, audience: ['employee', 'manager', 'hr_admin'] });
    expect((await getCard(a, id))?.audience).toEqual(['employee', 'manager', 'hr_admin']);
    // all-unchecked submits an empty list → the employee fallback (a card must target ≥ 1 role)
    await updateCard(a, { id, audience: [] });
    expect((await getCard(a, id))?.audience).toEqual(['employee']);
  });

  it('listDashboardCards filters by role AND active status', async () => {
    const a = adminCtx(b);
    await createCard(a, { cardKey: 'empCard', name: 'Emp', audience: ['employee'], displayOrder: 1 });
    await createCard(a, { cardKey: 'mgrCard', name: 'Mgr', audience: ['manager'], displayOrder: 2 });
    await createCard(a, { cardKey: 'sharedCard', name: 'Shared', audience: ['employee', 'manager', 'hr_admin'], displayOrder: 3 });
    const { id: offId } = await createCard(a, { cardKey: 'mgrOff', name: 'Mgr Off', audience: ['manager'], displayOrder: 4 });
    await setStatus(a, { id: offId, status: 'inactive' });

    expect((await listDashboardCards(a, 'employee')).map((c) => c.cardKey)).toEqual(['empCard', 'sharedCard']);
    expect((await listDashboardCards(a, 'manager')).map((c) => c.cardKey)).toEqual(['mgrCard', 'sharedCard']);
    expect((await listDashboardCards(a, 'hr_admin')).map((c) => c.cardKey)).toEqual(['sharedCard']);
  });

  it('audience rides along in the dashboard-card-config.* event payloads', async () => {
    const a = adminCtx(b);
    const { id } = await createCard(a, { cardKey: 'evAud', name: 'EvAud', audience: ['manager'] });
    const created = await latestEventPayload(b.tenantId, id, 'dashboard-card-config.created');
    expect(created?.audience).toEqual(['manager']);
    await updateCard(a, { id, audience: ['hr_admin'] });
    const updated = await latestEventPayload(b.tenantId, id, 'dashboard-card-config.updated');
    expect((updated?.after as { audience?: string[] })?.audience).toEqual(['hr_admin']);
    expect((updated?.before as { audience?: string[] })?.audience).toEqual(['manager']);
  });
});

describe('Dashboard Card Master — migration seed', () => {
  it('the 0212 seed statement populates the R39 block/card set for a tenant', async () => {
    // Run the migration's own seed INSERT (the last statement in the file) against the freshly-seeded test
    // tenant, then assert the R39 set landed with the expected flags. Uses the real migration SQL so the
    // seed content cannot drift from this test.
    const file = path.join(__dirname, '..', 'db', 'migrations', '0212_dashboard_card_config.sql');
    const seedStmt = readFileSync(file, 'utf8').split('--> statement-breakpoint').pop()!;
    await owner.db.execute(sql.raw(seedStmt));

    const cards = await listCards(adminCtx(b));
    expect(cards.map((c) => c.cardKey)).toEqual([
      'leaveBalance',
      'nextHoliday',
      'pendingTasks',
      'plannedAbsences',
      'recentlyJoined',
      'upcomingEvents',
      'recentActivity',
    ]);
    // All seeded cards are active, selectable and default-shown; none mandatory (employees keep reorder freedom).
    for (const c of cards) {
      expect(c.status).toBe('active');
      expect(c.employeeSelectable).toBe(true);
      expect(c.defaultDisplay).toBe(true);
      expect(c.mandatory).toBe(false);
    }
    // Idempotent: re-running the seed does not duplicate rows (ON CONFLICT DO NOTHING).
    await owner.db.execute(sql.raw(seedStmt));
    expect((await listCards(adminCtx(b))).length).toBe(7);
  });

  it('the 0299 statements widen the shared cards to all roles and seed the manager/admin sets (idempotently)', async () => {
    // Replay the real migration SQL against the freshly-seeded tenant (the harness template predates
    // seedBase's tenants, so the CROSS JOIN seeds no-op at migrate time — 0212-test pattern).
    const seed0212 = readFileSync(path.join(__dirname, '..', 'db', 'migrations', '0212_dashboard_card_config.sql'), 'utf8')
      .split('--> statement-breakpoint')
      .pop()!;
    const stmts0296 = readFileSync(path.join(__dirname, '..', 'db', 'migrations', '0296_employee_dashboard_fixed_row.sql'), 'utf8')
      .split('--> statement-breakpoint');
    const stmts0299 = readFileSync(path.join(__dirname, '..', 'db', 'migrations', '0299_dashboard_card_audience.sql'), 'utf8')
      .split('--> statement-breakpoint');
    await owner.db.execute(sql.raw(seed0212));
    for (const stmt of stmts0296) await owner.db.execute(sql.raw(stmt));
    for (const stmt of stmts0299) await owner.db.execute(sql.raw(stmt));

    const a = adminCtx(b);
    // Role filtering off the seeded audiences (display order, then name):
    expect((await listDashboardCards(a, 'employee')).map((c) => c.cardKey)).toEqual([
      'leaveBalance',
      'nextHoliday',
      'pendingTasks',
      'plannedAbsences',
      'upcomingEvents',
      'recentlyJoined',
      'recentActivity',
    ]);
    expect((await listDashboardCards(a, 'manager')).map((c) => c.cardKey)).toEqual([
      'teamAwayToday',
      'approvalRequests',
      'upcomingReminders',
      'plannedAbsences',
      'upcomingEvents',
      'recentlyJoined',
      'recentActivity',
      'attendanceOverview',
    ]);
    expect((await listDashboardCards(a, 'hr_admin')).map((c) => c.cardKey)).toEqual([
      'headcount',
      'pendingLeave',
      'companies',
      'latestPayroll', // display_order 4 tie with the calendar — 'Latest Payroll' sorts first by name
      'plannedAbsences',
      'upcomingEvents',
      'recentlyJoined',
      'recentActivity',
      'attendanceOverview',
      'headcountByCompany',
      'latestPayrollRun',
    ]);
    // The shared sections carry all three roles; an employee summary card stays employee-only.
    const byKey = new Map((await listCards(a)).map((c) => [c.cardKey, c]));
    expect(byKey.get('plannedAbsences')!.audience).toEqual(['employee', 'manager', 'hr_admin']);
    expect(byKey.get('recentActivity')!.audience).toEqual(['employee', 'manager', 'hr_admin']);
    expect(byKey.get('leaveBalance')!.audience).toEqual(['employee']);
    expect(byKey.get('teamAwayToday')!.audience).toEqual(['manager']);
    expect(byKey.get('attendanceOverview')!.audience).toEqual(['manager', 'hr_admin']);
    expect(byKey.get('headcountByCompany')!.audience).toEqual(['hr_admin']);

    // Idempotent: a second run changes nothing (guarded UPDATE + ON CONFLICT DO NOTHING).
    for (const stmt of stmts0299) await owner.db.execute(sql.raw(stmt));
    expect((await listCards(a)).length).toBe(17);
    expect((await listCards(a)).find((c) => c.cardKey === 'plannedAbsences')!.audience).toEqual([
      'employee',
      'manager',
      'hr_admin',
    ]);
  });
});
