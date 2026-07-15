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
  setStatus,
  updateCard,
} from '../core/dashboard-card-config';
import { adminCtx, closeAll, eventTypesFor, migrateTestDb, owner, resetDb, seedBase, type Base } from './harness';

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
});
