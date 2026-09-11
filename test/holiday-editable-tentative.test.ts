/**
 * Follow-on #15b (ADR-0063) — editable + tentative state holidays.
 *
 * Covers the missing CRUD op `updateHoliday` (edit date + name, event-logged, collision → DuplicateError,
 * missing id → throw) and the new `tentative` flag (create with it; flipping it persists; a tentative
 * holiday STILL counts as a holiday in working-day leave counting — it must NOT be excluded).
 *
 * Working-day window (reused from state-holidays.test.ts): Mon 2026-07-20 → Fri 2026-07-24 = 5 working days.
 */
import { eq } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import * as schema from '../db/schema';
import { hireEmployee } from '../core/org';
import { requestLeave } from '../core/leave';
import { createHoliday, createHolidayGroup, updateHoliday, listHolidays, DuplicateError } from '../core/admin';
import {
  adminCtx,
  closeAll,
  eventTypesFor,
  latestEventPayload,
  migrateTestDb,
  owner,
  resetDb,
  seedBase,
  type Base,
} from './harness';

let b: Base;
let wdTypeId: string;

const hire = async (workState: string | null) => {
  const e = await hireEmployee(adminCtx(b), {
    person: { fullName: 'HE', primaryEmail: `he_${randomUUID().slice(0, 8)}@t.local` },
    companyId: b.companyId,
    departmentId: b.deptA,
    employmentType: 'full_time',
    hiredOn: '2024-01-01',
  });
  if (workState) await owner.db.update(schema.employment).set({ workState }).where(eq(schema.employment.id, e.employmentId));
  return e;
};
const daysFor = async (employmentId: string) =>
  (await requestLeave(adminCtx(b), { employmentId, leaveTypeId: wdTypeId, startDate: '2026-07-20', endDate: '2026-07-24' })).days;

beforeAll(async () => {
  await migrateTestDb();
});
beforeEach(async () => {
  await resetDb();
  b = await seedBase();
  const [lt] = await owner.db
    .insert(schema.leaveType)
    .values({ allowNegativeBalance: true, tenantId: b.tenantId, code: 'WD', name: 'Working-day leave', paid: true, counting: 'working_days' })
    .returning({ id: schema.leaveType.id });
  wdTypeId = lt.id;
});
afterAll(async () => {
  await closeAll();
});

describe('updateHoliday — edit date + name (the missing CRUD op)', () => {
  it('updates a holiday date and name and appends holiday.updated with before/after', async () => {
    const { id } = await createHoliday(adminCtx(b), {
      country: 'MY',
      holidayDate: '2026-07-21',
      name: 'Provisional Ruler Birthday',
      state: 'Selangor',
    });
    await updateHoliday(adminCtx(b), { id, holidayDate: '2026-07-23', name: 'Ruler Birthday (gazetted)' });

    const [row] = await owner.db
      .select({ d: schema.holiday.holidayDate, n: schema.holiday.name, s: schema.holiday.state })
      .from(schema.holiday)
      .where(eq(schema.holiday.id, id));
    expect(row.d).toBe('2026-07-23');
    expect(row.n).toBe('Ruler Birthday (gazetted)');
    expect(row.s).toBe('Selangor'); // state not supplied ⇒ unchanged (def44f29: supplied ⇒ it moves, below)

    expect(await eventTypesFor(b.tenantId, id)).toContain('holiday.updated');
    const payload = await latestEventPayload(b.tenantId, id, 'holiday.updated');
    expect((payload?.before as Record<string, unknown>)?.holidayDate).toBe('2026-07-21');
    expect((payload?.before as Record<string, unknown>)?.name).toBe('Provisional Ruler Birthday');
    expect((payload?.after as Record<string, unknown>)?.holidayDate).toBe('2026-07-23');
    expect((payload?.after as Record<string, unknown>)?.name).toBe('Ruler Birthday (gazetted)');
    // scope-in-audit (mirrors create): state carried on both sides
    expect((payload?.after as Record<string, unknown>)?.state).toBe('Selangor');
  });

  it('moving a date onto an existing holiday throws DuplicateError', async () => {
    await createHoliday(adminCtx(b), { country: 'MY', holidayDate: '2026-07-21', name: 'National A' });
    const { id } = await createHoliday(adminCtx(b), { country: 'MY', holidayDate: '2026-07-22', name: 'National B' });
    await expect(updateHoliday(adminCtx(b), { id, holidayDate: '2026-07-21' })).rejects.toBeInstanceOf(DuplicateError);
  });

  it('updating a missing id throws', async () => {
    await expect(
      updateHoliday(adminCtx(b), { id: randomUUID(), name: 'Nope' }),
    ).rejects.toThrow();
  });

  it('rejects a malformed date (same YYYY-MM-DD guard as create)', async () => {
    const { id } = await createHoliday(adminCtx(b), { country: 'MY', holidayDate: '2026-07-21', name: 'National' });
    await expect(updateHoliday(adminCtx(b), { id, holidayDate: '21-07-2026' })).rejects.toThrow();
  });
});

describe('tentative flag', () => {
  it('createHoliday with tentative:true stores it; listHolidays returns it', async () => {
    const { id } = await createHoliday(adminCtx(b), {
      country: 'MY',
      holidayDate: '2026-07-22',
      name: 'Unconfirmed State Holiday',
      state: 'Sarawak',
      tentative: true,
    });
    const [row] = await owner.db
      .select({ t: schema.holiday.tentative })
      .from(schema.holiday)
      .where(eq(schema.holiday.id, id));
    expect(row.t).toBe(true);

    const listed = await listHolidays(adminCtx(b), {});
    const found = listed.find((h) => h.id === id);
    expect(found?.tentative).toBe(true);
  });

  it('flipping tentative true→false (confirm) persists and is event-logged', async () => {
    const { id } = await createHoliday(adminCtx(b), {
      country: 'MY',
      holidayDate: '2026-07-22',
      name: 'State Holiday',
      state: 'Sarawak',
      tentative: true,
    });
    await updateHoliday(adminCtx(b), { id, tentative: false });
    const [row] = await owner.db
      .select({ t: schema.holiday.tentative })
      .from(schema.holiday)
      .where(eq(schema.holiday.id, id));
    expect(row.t).toBe(false);

    const payload = await latestEventPayload(b.tenantId, id, 'holiday.updated');
    expect((payload?.before as Record<string, unknown>)?.tentative).toBe(true);
    expect((payload?.after as Record<string, unknown>)?.tentative).toBe(false);
  });

  it('a tentative holiday STILL counts as a holiday in working-day leave counting (not excluded)', async () => {
    // National Tue 21st (confirmed) + Sarawak Wed 22nd (TENTATIVE). A Sarawak employee taking Mon–Fri must
    // get 3 working days (5 − both) — the tentative Sarawak day MUST be excluded from working days too.
    await createHoliday(adminCtx(b), { country: 'MY', holidayDate: '2026-07-21', name: 'National Holiday' });
    await createHoliday(adminCtx(b), {
      country: 'MY',
      holidayDate: '2026-07-22',
      name: 'Tentative Sarawak Day',
      state: 'Sarawak',
      tentative: true,
    });
    const sarawak = await hire('Sarawak');
    expect(await daysFor(sarawak.employmentId)).toBe(3); // 5 − national − tentative Sarawak
  });
});

/**
 * def44f29 — NATIONAL / STATE IS EDITABLE. ADR-0063 documented scope as immutable on update ("delete +
 * recreate"); the reporter's complaint was exactly that delete-and-recreate. The change is narrowed to
 * the one axis the Holidays screen edits: `state` moves between national (null) and a state of the row's
 * country. What is pinned here, and why each line exists:
 *   · the move is real (the row changes) AND readable from the ledger (after.state used to copy
 *     before.state, which would have hidden every move from the audit trail);
 *   · it reaches leave at once — the resolver reads the same row, so a Selangor employee stops losing the
 *     day the moment it becomes a Sabah holiday;
 *   · a business-group / holiday-group row is REFUSED a state (single-axis, holiday_scope_excl) — the
 *     row's scope stays exactly as it was, with the service's message, not the constraint's;
 *   · a move that collides with an existing row is a DuplicateError naming the TARGET scope;
 *   · a label the country pack does not have is refused, and `undefined` still means "leave it alone".
 */
describe('def44f29 — National / State is editable on update', () => {
  const scopeOf = async (id: string) => {
    const [row] = await owner.db
      .select({ s: schema.holiday.state, c: schema.holiday.companyId, g: schema.holiday.holidayGroupId })
      .from(schema.holiday)
      .where(eq(schema.holiday.id, id));
    return row;
  };

  it('moves a national holiday to a state, records the move in the audit payload, and leave sees it at once', async () => {
    const { id } = await createHoliday(adminCtx(b), { country: 'MY', holidayDate: '2026-07-21', name: 'Moved Day' });
    await updateHoliday(adminCtx(b), { id, state: 'Sabah' });

    expect((await scopeOf(id)).s).toBe('Sabah');
    const payload = await latestEventPayload(b.tenantId, id, 'holiday.updated');
    expect((payload?.before as Record<string, unknown>)?.state).toBeNull();
    expect((payload?.after as Record<string, unknown>)?.state).toBe('Sabah');

    // Tue 21st is now Sabah-only: a Sabah employee taking Mon–Fri loses it (4 days), Selangor does not (5).
    const sabah = await hire('Sabah');
    const selangor = await hire('Selangor');
    expect(await daysFor(sabah.employmentId)).toBe(4);
    expect(await daysFor(selangor.employmentId)).toBe(5);
  });

  it('moves a state holiday back to national — null and the empty string both mean national', async () => {
    const a = await createHoliday(adminCtx(b), { country: 'MY', holidayDate: '2026-07-21', name: 'A', state: 'Sarawak' });
    const c = await createHoliday(adminCtx(b), { country: 'MY', holidayDate: '2026-07-22', name: 'C', state: 'Sabah' });
    await updateHoliday(adminCtx(b), { id: a.id, state: null });
    await updateHoliday(adminCtx(b), { id: c.id, state: '' });
    expect((await scopeOf(a.id)).s).toBeNull();
    expect((await scopeOf(c.id)).s).toBeNull();
    const payload = await latestEventPayload(b.tenantId, a.id, 'holiday.updated');
    expect((payload?.before as Record<string, unknown>)?.state).toBe('Sarawak');
    expect((payload?.after as Record<string, unknown>)?.state).toBeNull();
  });

  it('leaves the state alone when it is not supplied', async () => {
    const { id } = await createHoliday(adminCtx(b), { country: 'MY', holidayDate: '2026-07-21', name: 'Keep', state: 'Sabah' });
    await updateHoliday(adminCtx(b), { id, name: 'Keep (renamed)' });
    expect((await scopeOf(id)).s).toBe('Sabah');
  });

  it('refuses a National / State change on a business-group row, leaving the row exactly as it was', async () => {
    const { id } = await createHoliday(adminCtx(b), {
      country: 'MY',
      holidayDate: '2026-07-21',
      name: 'Company Day',
      companyId: b.companyId,
    });
    // THE NON-VACUITY ASSERTION for this build: remove the refusal in updateHoliday and this is the line
    // that fails (the DB CHECK would refuse the write too, but with a constraint name, not a sentence).
    await expect(updateHoliday(adminCtx(b), { id, state: 'Sabah' })).rejects.toThrow(
      /business group or holiday group/,
    );
    const row = await scopeOf(id);
    expect(row.c).toBe(b.companyId);
    expect(row.s).toBeNull();
  });

  it('refuses it on a holiday-group row too', async () => {
    const group = await createHolidayGroup(adminCtx(b), { name: 'KL Office', states: ['Kuala Lumpur'] });
    const { id } = await createHoliday(adminCtx(b), {
      country: 'MY',
      holidayDate: '2026-07-21',
      name: 'Office Day',
      holidayGroupId: group.id,
    });
    await expect(updateHoliday(adminCtx(b), { id, state: 'Sabah' })).rejects.toThrow(
      /business group or holiday group/,
    );
    const row = await scopeOf(id);
    expect(row.g).toBe(group.id);
    expect(row.s).toBeNull();
  });

  it('a move that collides with an existing row is a DuplicateError naming the TARGET scope', async () => {
    const national = await createHoliday(adminCtx(b), { country: 'MY', holidayDate: '2026-07-21', name: 'National' });
    const sabah = await createHoliday(adminCtx(b), { country: 'MY', holidayDate: '2026-07-21', name: 'Sabah', state: 'Sabah' });
    // Sabah → national collides with the national row; the message says national (no state), not Sabah.
    await expect(updateHoliday(adminCtx(b), { id: sabah.id, state: null })).rejects.toThrow(DuplicateError);
    await expect(updateHoliday(adminCtx(b), { id: sabah.id, state: null })).rejects.toThrow(
      /^A MY holiday on 2026-07-21 already exists\.$/,
    );
    // national → Sabah collides with the Sabah row; the message names Sabah.
    await expect(updateHoliday(adminCtx(b), { id: national.id, state: 'Sabah' })).rejects.toThrow(
      /^A MY Sabah holiday on 2026-07-21 already exists\.$/,
    );
    expect((await scopeOf(sabah.id)).s).toBe('Sabah');
    expect((await scopeOf(national.id)).s).toBeNull();
  });

  it('refuses a state the country pack does not have', async () => {
    const { id } = await createHoliday(adminCtx(b), { country: 'MY', holidayDate: '2026-07-21', name: 'X' });
    await expect(updateHoliday(adminCtx(b), { id, state: 'Atlantis' })).rejects.toThrow(/Unknown state/);
    expect((await scopeOf(id)).s).toBeNull();
  });
});
