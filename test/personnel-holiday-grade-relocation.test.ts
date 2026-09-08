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
 *  (3) r78c REPLACED the original guard here. It pinned setEmploymentGradeAction — the Leave tab's direct
 *      Job Grade save — persisting the grade and firing employment.grade.changed. That action is DELETED:
 *      it wrote a MOVEMENT_EVENT_TYPE with no movement tag, so a grade edit opened its own "Grade Change"
 *      row on the Employment History beside the movement that had already recorded it. The guard now pins
 *      the replacement: the grade moves through Movement, the event carries a movement tag, and the change
 *      projects ONE history row. The Leave tab shows the grade read-only.
 *  (4) REGRESSION — the wipe this relocation had to avoid: a Personal Details save (setPersonAction) with
 *      NO holidayCalendar / gradeId fields (the selects are gone from that form) PRESERVES both an existing
 *      holiday calendar and an existing grade. Before the split, setPersonAction unconditionally re-wrote
 *      both columns from the now-absent fields and would have nulled them.
 *  (5) THE READING ORDER, added in r255 because it had just been reversed with nothing to catch it. This
 *      item's other half is a LAYOUT decision — "Holiday Calendar pinned first on the Attendance tab" —
 *      and 420ebab5's consolidated Save moved it to third while grouping the tab's field-edit cards into
 *      one contiguous run. Guards (1)-(4) all passed, because they test writers and events and no test
 *      anywhere pinned the order the reporter actually asked for. A decision that only lives in prose is
 *      a decision the next round can undo by accident, so it lives here now.
 */
import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import * as schema from '../db/schema';
import { hireEmployee, setEmploymentHolidayCalendar, setEmploymentGrade } from '../core/org';
import { createMovementEvent, movementHistory } from '../core/movement';
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
  setPersonAction,
} from '../app/admin/personnel/[employmentId]/actions';
import * as personnelActions from '../app/admin/personnel/[employmentId]/actions';

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

  it('(3) r78c — the Leave tab has NO grade writer left; the grade moves through Movement, tagged', async () => {
    // The endpoint itself must be gone, not merely unwired: every exported `use server` function is a live
    // RPC endpoint, so an unreferenced one is still a working untagged writer for anything holding its id.
    expect(Object.keys(personnelActions)).not.toContain('setEmploymentGradeAction');

    const hire = await hireOne('Grade Save');
    const grade = await createJobGrade(adminCtx(base), {
      code: `G${randomUUID().slice(0, 8).toUpperCase()}`,
      name: `Grade ${randomUUID().slice(0, 5)}`,
      rank: 1,
    });
    await createMovementEvent(adminCtx(base), {
      employmentId: hire.employmentId,
      kind: 'promotion',
      effectiveDate: '2026-03-01',
      gradeId: grade.id,
    });

    const row = await empRow(hire.employmentId);
    expect(row.gradeId, 'the grade still changes — only the screen that changes it moved').toBe(grade.id);

    // The event is still emitted (the audit trail is unchanged) but now carries the movement tag, so the
    // projection labels it Promotion instead of opening a loose Grade Change row.
    const [ev] = await owner.db
      .select({ payload: schema.domainEvent.payload })
      .from(schema.domainEvent)
      .where(eq(schema.domainEvent.eventType, 'employment.grade.changed'));
    expect((ev.payload as { movement?: { type?: string; groupId?: string } }).movement?.type).toBe('promotion');
    expect((ev.payload as { movement?: { groupId?: string } }).movement?.groupId).toBeTruthy();

    const rows = await movementHistory(adminCtx(base), hire.employmentId);
    expect(rows.filter((r) => r.kind !== 'hired').map((r) => r.kind)).toEqual(['promotion']);
    expect(rows.map((r) => r.kind), 'no stray Grade Change row').not.toContain('gradeChange');
  });

  it('(4) REGRESSION: a Personal Details save (no holidayCalendar/gradeId fields) preserves holiday + grade', async () => {
    const hire = await hireOne('Personal Save');
    // Pre-set both employment-level fields via their (now relocated) services.
    const grade = await createJobGrade(adminCtx(base), {
      code: `G${randomUUID().slice(0, 8).toUpperCase()}`,
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

  it('(5) the Attendance tab still OPENS with the Holiday Calendar card, and Leave with the Grade card', () => {
    // AGENTS 27 — a source-scanning guard must not be answerable by a comment. Strip line comments first:
    // one of the page's `//` notes contains the characters that open a block comment, and stripping blocks
    // first makes that note swallow real JSX. (Same stripper as test/personnel-tab-save-tabs.test.ts.)
    const src = readFileSync(
      new URL('../app/admin/personnel/[employmentId]/page.tsx', import.meta.url),
      'utf8',
    );
    const page = src
      .split('\n')
      .filter((line) => {
        const t = line.trim();
        return !(t.startsWith('//') || t.startsWith('* ') || t === '*');
      })
      .join('\n')
      .replace(/\{?\/\*[\s\S]*?\*\/\}?/g, '');

    /** One panel of the `panels` map, sliced from its own key up to the key that follows it. */
    const panel = (key: string, next: string) => {
      const from = page.indexOf(`${key}: (`);
      const to = page.indexOf(next, from);
      expect(from, `the ${key} panel exists`).toBeGreaterThan(-1);
      expect(to, `${next} follows the ${key} panel`).toBeGreaterThan(from);
      return page.slice(from, to);
    };
    const card = (panelSrc: string, name: string) => {
      const at = panelSrc.indexOf(`{${name}}`);
      expect(at, `${name} renders on this tab`).toBeGreaterThan(-1);
      return at;
    };

    // Attendance: Holiday Calendar first, ahead of Work Location, Shift Arrangement and Clocking. r255's
    // consolidated Save has to enclose a contiguous run of the tab's field-edit cards, and the first
    // attempt bought that by rendering the two dated-record cards ABOVE the run — which pushed this card
    // to third. Whatever a later round does about grouping, THIS card opens the tab.
    const attendance = panel('attendance', 'bankStatutory: (');
    const holiday = card(attendance, 'holidayCalendarCard');
    expect(holiday, 'Holiday Calendar before Work Location').toBeLessThan(card(attendance, 'locationCard'));
    expect(holiday, 'Holiday Calendar before Shift Arrangement').toBeLessThan(card(attendance, 'defaultShiftCard'));
    expect(holiday, 'Holiday Calendar before Clocking & Geofencing').toBeLessThan(card(attendance, 'clockingCard'));

    // Leave: the same decision's other half — Grade pinned above the balance card.
    const leave = panel('leave', 'documents: ');
    expect(card(leave, 'gradeCard')).toBeLessThan(card(leave, 'leaveBalanceCard'));
  });
});
