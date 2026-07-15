/**
 * Item 52a30630 — Holiday Calendar + Grade relocation (Personnel admin detail page).
 *
 * The unified Holiday Calendar selector moved from Profile > Personal Details onto the Attendance tab, and
 * the Grade selector onto the Leave tab. HTML forms can't span the client tab panels, so each select
 * physically moved into its own form + thin server action, and setPersonAction (the Personal Details save)
 * NO LONGER writes either employment column.
 *
 * Guards:
 *  (1) setEmploymentHolidayCalendarAction persists a STATE selection (work_state set, holiday_group_id
 *      nulled) and fires the EXISTING employment.holiday-calendar.changed event — no new event type.
 *  (2) setEmploymentHolidayCalendarAction persists a GROUP selection (holiday_group_id set, work_state
 *      nulled) — the XOR the service enforces.
 *  (3) setEmploymentGradeAction persists the grade (employment.grade_id) and fires
 *      employment.grade.changed.
 *  (4) REGRESSION — the wipe this relocation had to avoid: a Personal Details save (setPersonAction) with
 *      NO holidayCalendar / gradeId fields (the selects are gone from that form) PRESERVES both an existing
 *      holiday calendar and an existing grade. Before the split, setPersonAction unconditionally re-wrote
 *      both columns from the now-absent fields and would have nulled them.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import * as schema from '../db/schema';
import { hireEmployee, setEmploymentHolidayCalendar, setEmploymentGrade } from '../core/org';
import { createJobGrade, createHolidayGroup } from '../core/admin';
import {
  adminCtx,
  closeAll,
  eventTypesFor,
  migrateTestDb,
  owner,
  resetDb,
  seedBase,
  type Base,
} from './harness';

// The action layer calls requireAdmin() (session) which is unavailable in the harness — return the seeded
// admin ctx so the actions' DB writes run under RLS. Mirrors zakat-election-relocation.test.ts.
let ADMIN: ReturnType<typeof adminCtx>;
vi.mock('../lib/authz', () => ({ requireAdmin: async () => ADMIN }));
// Server actions call revalidatePath + redirect (throws outside a request). Record the redirect target.
let LAST_REDIRECT = '';
vi.mock('next/cache', () => ({ revalidatePath: () => {} }));
vi.mock('next/navigation', () => ({
  redirect: (url: string) => {
    LAST_REDIRECT = url;
    throw new Error('NEXT_REDIRECT');
  },
}));
vi.mock('next-intl/server', () => ({ getTranslations: async () => (k: string) => k }));

import {
  setEmploymentHolidayCalendarAction,
  setEmploymentGradeAction,
  setPersonAction,
} from '../app/admin/personnel/[employmentId]/actions';

let base: Base;

async function empRow(employmentId: string) {
  const [row] = await owner.db
    .select({
      workState: schema.employment.workState,
      holidayGroupId: schema.employment.holidayGroupId,
      gradeId: schema.employment.gradeId,
      personId: schema.employment.personId,
      employeeCode: schema.employment.employeeCode,
    })
    .from(schema.employment)
    .where(eq(schema.employment.id, employmentId))
    .limit(1);
  return row;
}

async function hireOne(name: string) {
  return hireEmployee(adminCtx(base), {
    person: { fullName: name, primaryEmail: `${name.toLowerCase().replace(/\s+/g, '.')}.${randomUUID().slice(0, 6)}@t.local` },
    companyId: base.companyId,
    departmentId: base.deptA,
    employmentType: 'full_time',
    hiredOn: '2026-01-01',
  });
}

describe('Item 52a30630 — Holiday Calendar → Attendance, Grade → Leave', () => {
  beforeAll(async () => {
    await migrateTestDb();
  });
  beforeEach(async () => {
    await resetDb();
    base = await seedBase();
    ADMIN = adminCtx(base);
    LAST_REDIRECT = '';
  });
  afterAll(async () => {
    await closeAll();
  });

  it('(1) setEmploymentHolidayCalendarAction saves a STATE selection + fires the existing event', async () => {
    const hire = await hireOne('Holiday State');
    const fd = new FormData();
    fd.set('employmentId', hire.employmentId);
    fd.set('holidayCalendar', 'state:Selangor');
    await expect(setEmploymentHolidayCalendarAction(fd)).rejects.toThrow('NEXT_REDIRECT');
    expect(LAST_REDIRECT).toContain('toast=Saved');

    const row = await empRow(hire.employmentId);
    expect(row.workState).toBe('Selangor');
    expect(row.holidayGroupId).toBeNull();
    expect(await eventTypesFor(base.tenantId, hire.employmentId)).toContain('employment.holiday-calendar.changed');
  });

  it('(2) setEmploymentHolidayCalendarAction saves a GROUP selection (XOR: group set, state nulled)', async () => {
    const hire = await hireOne('Holiday Group');
    const group = await createHolidayGroup(adminCtx(base), {
      name: `Grp ${randomUUID().slice(0, 6)}`,
      states: ['Selangor', 'Johor'],
    });
    const fd = new FormData();
    fd.set('employmentId', hire.employmentId);
    fd.set('holidayCalendar', `group:${group.id}`);
    await expect(setEmploymentHolidayCalendarAction(fd)).rejects.toThrow('NEXT_REDIRECT');
    expect(LAST_REDIRECT).toContain('toast=Saved');

    const row = await empRow(hire.employmentId);
    expect(row.holidayGroupId).toBe(group.id);
    expect(row.workState).toBeNull();
  });

  it('(3) setEmploymentGradeAction saves the grade + fires employment.grade.changed', async () => {
    const hire = await hireOne('Grade Save');
    const grade = await createJobGrade(adminCtx(base), {
      code: `G${randomUUID().slice(0, 4).toUpperCase()}`,
      name: `Grade ${randomUUID().slice(0, 5)}`,
      rank: 1,
    });
    const fd = new FormData();
    fd.set('employmentId', hire.employmentId);
    fd.set('gradeId', grade.id);
    await expect(setEmploymentGradeAction(fd)).rejects.toThrow('NEXT_REDIRECT');
    expect(LAST_REDIRECT).toContain('toast=Saved');

    const row = await empRow(hire.employmentId);
    expect(row.gradeId).toBe(grade.id);
    expect(await eventTypesFor(base.tenantId, hire.employmentId)).toContain('employment.grade.changed');
  });

  it('(4) REGRESSION: a Personal Details save (no holidayCalendar/gradeId fields) preserves holiday + grade', async () => {
    const hire = await hireOne('Personal Save');
    // Pre-set both employment-level fields via their (now relocated) services.
    const grade = await createJobGrade(adminCtx(base), {
      code: `G${randomUUID().slice(0, 4).toUpperCase()}`,
      name: `Grade ${randomUUID().slice(0, 5)}`,
      rank: 2,
    });
    await setEmploymentHolidayCalendar(adminCtx(base), { employmentId: hire.employmentId, selection: { kind: 'state', state: 'Johor' } });
    await setEmploymentGrade(adminCtx(base), { employmentId: hire.employmentId, gradeId: grade.id });

    const before = await empRow(hire.employmentId);
    expect(before.workState).toBe('Johor');
    expect(before.gradeId).toBe(grade.id);

    // Personal Details save EXACTLY as the relocated form now submits it: identity fields + employeeCode,
    // but NO holidayCalendar and NO gradeId (their selects moved to the Attendance / Leave tabs).
    const fd = new FormData();
    fd.set('employmentId', hire.employmentId);
    fd.set('personId', before.personId);
    fd.set('fullName', 'Personal Save Renamed');
    fd.set('primaryEmail', `renamed.${randomUUID().slice(0, 6)}@t.local`);
    fd.set('employeeCode', before.employeeCode ?? `EMP${randomUUID().slice(0, 5).toUpperCase()}`);
    await expect(setPersonAction(fd)).rejects.toThrow('NEXT_REDIRECT');
    expect(LAST_REDIRECT).toContain('toast=Saved');

    // The wipe regression: both columns MUST survive the Personal Details save.
    const after = await empRow(hire.employmentId);
    expect(after.workState).toBe('Johor');
    expect(after.holidayGroupId).toBeNull();
    expect(after.gradeId).toBe(grade.id);
  });
});
