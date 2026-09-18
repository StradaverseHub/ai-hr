/**
 * 44bc1c33 — Card / Clocking ID: the third key a terminal file can find an employee by.
 *
 * WHAT WAS ACTUALLY BROKEN. `importAttendancePunches` matched a device's identifier against
 * `employment.employee_code` and the IC on `employee_statutory_my`, and reported anything else as
 * unmatched rather than guessing. A company whose terminal records its own card numbers matched NOTHING
 * and had no way to fix it short of renumbering the device.
 *
 * These are BEHAVIOURAL tests against the real importer, not shape assertions, because every claim here is
 * about which human a punch is attributed to — and attendance feeds overtime, which is pay.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import * as schema from '../db/schema';
import { adminCtx, closeAll, migrateTestDb, owner, resetDb, seedBase, type Base } from './harness';
import { importAttendancePunches } from '../core/attendance';
import { CardIdInUseError, resolveCardMatch, setEmploymentCardId } from '../core/attendance-card';

let b: Base;

async function makeEmp(code: string, ic: string | null, cardId?: string | null) {
  const [p] = await owner.db
    .insert(schema.person)
    .values({ tenantId: b.tenantId, fullName: `W ${code}`, primaryEmail: `w_${randomUUID()}@t.local` })
    .returning({ id: schema.person.id });
  const [e] = await owner.db
    .insert(schema.employment)
    .values({
      tenantId: b.tenantId,
      personId: p.id,
      companyId: b.companyId,
      hiredOn: '2020-01-01',
      employeeCode: code,
      cardId: cardId ?? null,
    })
    .returning({ id: schema.employment.id });
  if (ic) await owner.db.insert(schema.employeeStatutoryMy).values({ tenantId: b.tenantId, personId: p.id, icNumber: ic });
  return e.id;
}

const attendanceRow = async (employmentId: string, date: string) => {
  const [row] = await owner.db
    .select()
    .from(schema.attendance)
    .where(and(eq(schema.attendance.employmentId, employmentId), eq(schema.attendance.attendanceDate, date)));
  return row;
};

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

describe('44bc1c33 · a device file finds the employee by Card ID', () => {
  it('THE WHOLE POINT: a punch whose ref is neither the code nor the IC now matches on the card', async () => {
    const ctx = adminCtx(b);
    const emp = await makeEmp('E001', '900101015555', 'CARD-77');

    const csv = 'staff,time\nCARD-77,2026-07-01 08:00\nCARD-77,2026-07-01 17:00';
    const r = await importAttendancePunches(ctx, { csvText: csv, dryRun: false });

    expect(r.unmatchedRefs, 'the card must not be reported as unmatched').toHaveLength(0);
    expect(r.imported).toBe(1);
    const row = await attendanceRow(emp, '2026-07-01');
    expect(row.checkInAt).toBe('08:00:00');
  });

  it('NON-VACUITY: the same file matches nothing when that employee has no card', async () => {
    const ctx = adminCtx(b);
    await makeEmp('E001', '900101015555', null);
    const r = await importAttendancePunches(ctx, { csvText: 'staff,time\nCARD-77,2026-07-01 08:00', dryRun: false });
    expect(r.imported).toBe(0);
    expect(r.unmatchedRefs).toEqual(['CARD-77']);
  });

  it('the existing two keys are untouched — a file of employee codes still imports exactly as before', async () => {
    const ctx = adminCtx(b);
    const emp = await makeEmp('E001', '900101015555', 'CARD-77');
    const r = await importAttendancePunches(ctx, { csvText: 'staff,time\nE001,2026-07-01 09:00', dryRun: false });
    expect(r.imported).toBe(1);
    expect(await attendanceRow(emp, '2026-07-01')).toBeTruthy();
  });

  it('LEADING ZEROS SURVIVE: 007 and 7 are different cards, not one', async () => {
    const ctx = adminCtx(b);
    const seven = await makeEmp('E007', null, '007');
    const alsoSeven = await makeEmp('E700', null, '7');
    const r = await importAttendancePunches(ctx, { csvText: 'staff,time\n007,2026-07-01 08:00', dryRun: false });
    expect(r.imported).toBe(1);
    expect(await attendanceRow(seven, '2026-07-01'), 'card 007 owns the punch').toBeTruthy();
    expect(await attendanceRow(alsoSeven, '2026-07-01'), 'card 7 must not get it').toBeFalsy();
  });

  it('the card is matched case-insensitively, like the employee code beside it', async () => {
    const ctx = adminCtx(b);
    const emp = await makeEmp('E001', null, 'card-77');
    const r = await importAttendancePunches(ctx, { csvText: 'staff,time\nCARD-77,2026-07-01 08:00', dryRun: false });
    expect(r.imported).toBe(1);
    expect(await attendanceRow(emp, '2026-07-01')).toBeTruthy();
  });
});

describe('44bc1c33 · the collision no database constraint can express', () => {
  /**
   * THE DANGEROUS ONE. The importer builds employee_code, IC and card_id into ONE flat map, so a card equal
   * to ANOTHER employee's code would overwrite that entry and post one person's attendance onto another.
   * 0474's unique index cannot see this (different columns, different rows), so the service refuses it.
   */
  it('refuses a card that is another employee’s EMPLOYEE CODE, and names who holds it', async () => {
    const ctx = adminCtx(b);
    await makeEmp('E001', null, null);
    const other = await makeEmp('E002', null, null);

    await expect(setEmploymentCardId(ctx, { employmentId: other, cardId: 'E001' })).rejects.toBeInstanceOf(
      CardIdInUseError,
    );
    await expect(setEmploymentCardId(ctx, { employmentId: other, cardId: 'E001' })).rejects.toThrow(/W E001/);
  });

  it('refuses a card that is another employee’s IC, compared on digits as the importer compares it', async () => {
    const ctx = adminCtx(b);
    await makeEmp('E001', '900101-01-5555', null);
    const other = await makeEmp('E002', null, null);
    await expect(setEmploymentCardId(ctx, { employmentId: other, cardId: '900101015555' })).rejects.toBeInstanceOf(
      CardIdInUseError,
    );
  });

  it('refuses a card another employee already holds as a CARD', async () => {
    const ctx = adminCtx(b);
    await makeEmp('E001', null, 'CARD-77');
    const other = await makeEmp('E002', null, null);
    await expect(setEmploymentCardId(ctx, { employmentId: other, cardId: 'CARD-77' })).rejects.toBeInstanceOf(
      CardIdInUseError,
    );
  });

  it('lets an employee keep their OWN card — re-saving the same value is not a collision', async () => {
    const ctx = adminCtx(b);
    const emp = await makeEmp('E001', null, 'CARD-77');
    await expect(setEmploymentCardId(ctx, { employmentId: emp, cardId: 'CARD-77' })).resolves.toBeUndefined();
  });

  it('clearing a card returns the employee to matching on their Employee ID, not to nothing', async () => {
    const ctx = adminCtx(b);
    const emp = await makeEmp('E001', null, 'CARD-77');
    await setEmploymentCardId(ctx, { employmentId: emp, cardId: null });

    const r = await importAttendancePunches(ctx, { csvText: 'staff,time\nE001,2026-07-01 08:00', dryRun: false });
    expect(r.imported, 'the employee code still matches').toBe(1);
    const gone = await importAttendancePunches(ctx, { csvText: 'staff,time\nCARD-77,2026-07-02 08:00', dryRun: false });
    expect(gone.unmatchedRefs, 'the cleared card matches nobody').toEqual(['CARD-77']);
  });

  it('assigning and clearing both leave an audit event — this changes who a punch belongs to', async () => {
    const ctx = adminCtx(b);
    const emp = await makeEmp('E001', null, null);
    await setEmploymentCardId(ctx, { employmentId: emp, cardId: 'CARD-77' });
    await setEmploymentCardId(ctx, { employmentId: emp, cardId: null });

    const events = await owner.db
      .select({ type: schema.domainEvent.eventType })
      .from(schema.domainEvent)
      .where(eq(schema.domainEvent.aggregateId, emp));
    const types = events.map((e) => e.type);
    expect(types).toContain('attendance.card.assigned');
    expect(types).toContain('attendance.card.cleared');
  });
});

describe('44bc1c33 · "Card ID is the same as Employee ID" is answered by behaviour, not a setting', () => {
  /**
   * The ticket asked for a switch that copies the employee code into the card. It was NOT built, and the
   * reason is testable rather than a matter of taste: the importer already matches on the employee code, so
   * a device recording employee numbers has always imported with no card at all. A copy would duplicate one
   * fact and need a sync rule on every code rename.
   */
  it('an employee with NO card is matched by their employee code, and the screen says so', () => {
    expect(resolveCardMatch({ cardId: null, employeeCode: 'E001' })).toEqual({ by: 'employee_code', value: 'E001' });
    expect(resolveCardMatch({ cardId: 'CARD-77', employeeCode: 'E001' })).toEqual({ by: 'card', value: 'CARD-77' });
    expect(resolveCardMatch({ cardId: null, employeeCode: null })).toEqual({ by: 'none', value: null });
  });

  it('no card is ever stored as a copy of the employee code', async () => {
    const ctx = adminCtx(b);
    const emp = await makeEmp('E001', null, null);
    const r = await importAttendancePunches(ctx, { csvText: 'staff,time\nE001,2026-07-01 08:00', dryRun: false });
    expect(r.imported, 'matching by code needs no card row').toBe(1);
    const [row] = await owner.db
      .select({ cardId: schema.employment.cardId })
      .from(schema.employment)
      .where(eq(schema.employment.id, emp));
    expect(row.cardId, 'nothing was copied in').toBeNull();
    void ctx;
  });
});
