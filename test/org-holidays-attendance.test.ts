/**
 * ADR-0055 — attendance OT day-type classification through the unified holiday resolver (the deferred PH
 * org-hierarchy slice, item 2.7). scheduleFor and the two read paths now resolve holidays via
 * holidayDatesFor — business-group → state → national, single-winner replacement — the SAME calendar leave
 * uses, so attendance and leave can never disagree on a holiday.
 *
 * This pins the money-facing effect (EA-1955: workday 1.5x / rest day 2x / holiday 3x): an employee under a
 * BUSINESS-GROUP holiday who works that day is classified dayType 'holiday' (premium class) — not 'workday'
 * — and the same punches on a non-override day stay an ordinary workday. The regression block then proves
 * single-country / no-org-row data is byte-identical to today (national + ADR-0054 state behaviour).
 *
 * Worked day = 09:00 → 20:00 = 660 span − 60 break = 600 worked. The net scheduled day is 480 (09–18, 60
 * break), so a WORKDAY yields 120 OT min while a HOLIDAY / REST_DAY banks the full 600 as premium-class OT.
 */
import { eq } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import * as schema from '../db/schema';
import { hireEmployee } from '../core/org';
import { attendanceForDate, attendanceMonthSummary, checkIn, checkOut } from '../core/attendance';
import { adminCtx, closeAll, migrateTestDb, owner, resetDb, seedBase, type Base } from './harness';

let b: Base;

const GROUP_DAY = '2026-07-23'; // Thursday — a working day under the default Mon–Fri policy
const WORK_IN = '09:00:00';
const WORK_OUT = '20:00:00'; // 660 span − 60 break = 600 worked

/** Create a company (optionally under a parent) plus a department in it, so hireEmployee's cross-company
 *  guard is satisfied. Mirrors test/org-holidays.test.ts so the org shapes match the leave-side proof. */
const makeCompany = async (legalName: string, parentCompanyId: string | null = null) => {
  const [c] = await owner.db
    .insert(schema.company)
    .values({ tenantId: b.tenantId, legalName, parentCompanyId })
    .returning({ id: schema.company.id });
  const [d] = await owner.db
    .insert(schema.department)
    .values({ tenantId: b.tenantId, companyId: c.id, name: `${legalName} Ops` })
    .returning({ id: schema.department.id });
  return { companyId: c.id, deptId: d.id };
};

const hireInto = async (companyId: string, departmentId: string, workState: string | null = null) => {
  const e = await hireEmployee(adminCtx(b), {
    person: { fullName: 'OT', primaryEmail: `ot_${randomUUID().slice(0, 8)}@t.local` },
    companyId,
    departmentId,
    employmentType: 'full_time',
    hiredOn: '2024-01-01',
  });
  if (workState) await owner.db.update(schema.employment).set({ workState }).where(eq(schema.employment.id, e.employmentId));
  return e;
};

/** Work GROUP_DAY 09:00 → 20:00 and return the frozen attendance classification (status/dayType/OT). */
const workAndClassify = async (employmentId: string) => {
  await checkIn(adminCtx(b), { employmentId, date: GROUP_DAY, time: WORK_IN });
  return checkOut(adminCtx(b), { employmentId, date: GROUP_DAY, time: WORK_OUT });
};

const groupHoliday = (companyId: string, holidayDate: string, name: string) => ({
  tenantId: b.tenantId,
  country: 'MY',
  state: null,
  companyId,
  holidayDate,
  name,
});

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

describe('ADR-0055 — attendance OT day-type via the unified resolver', () => {
  it('AFTER: a business-group holiday classifies a worked day as holiday (full span is premium OT)', async () => {
    // Group holiday on GROUP_DAY set on the seedBase company itself; the employee works it. Single-winner
    // replacement makes the day a holiday even though no national/state row exists for the date.
    await owner.db.insert(schema.holiday).values(groupHoliday(b.companyId, GROUP_DAY, 'Group Founders Day'));
    const r = await workAndClassify((await hireInto(b.companyId, b.deptA, 'Selangor')).employmentId);
    expect(r.dayType).toBe('holiday');
    expect(r.workedMinutes).toBe(600);
    expect(r.otMinutes).toBe(600); // holiday: the whole worked span is premium-class OT
  });

  it('BEFORE/control: the SAME punches with no org row stay an ordinary workday (120 OT only)', async () => {
    // No company-scoped holiday and GROUP_DAY is not national/state → ordinary workday. This is the
    // pre-ADR-0055 classification for identical punches; the group override above is what flips the class.
    const r = await workAndClassify((await hireInto(b.companyId, b.deptA, 'Selangor')).employmentId);
    expect(r.dayType).toBe('workday');
    expect(r.workedMinutes).toBe(600);
    expect(r.otMinutes).toBe(120); // workday: 600 worked − 480 scheduled
  });

  it('a parent-group calendar cascades to a child-company employee (upward ancestor walk)', async () => {
    const child = await makeCompany('Acme Factory Sdn Bhd', b.companyId); // parent = seedBase company
    await owner.db.insert(schema.holiday).values(groupHoliday(b.companyId, GROUP_DAY, 'Group Founders Day'));
    const r = await workAndClassify((await hireInto(child.companyId, child.deptId)).employmentId);
    expect(r.dayType).toBe('holiday'); // is_company_descendant(child, parent) → override cascades down
    expect(r.otMinutes).toBe(600);
  });

  // ── byte-identical fallback (single-country / no-org-row): unchanged national + ADR-0054 state behaviour ──
  it('regression: a national holiday still classifies as holiday when no company rows exist', async () => {
    await owner.db
      .insert(schema.holiday)
      .values({ tenantId: b.tenantId, country: 'MY', state: null, holidayDate: GROUP_DAY, name: 'National' });
    const r = await workAndClassify((await hireInto(b.companyId, b.deptA, 'Selangor')).employmentId);
    expect(r.dayType).toBe('holiday');
    expect(r.otMinutes).toBe(600);
  });

  it('regression: a state holiday classifies only for the matching-state employee', async () => {
    await owner.db
      .insert(schema.holiday)
      .values({ tenantId: b.tenantId, country: 'MY', state: 'Sarawak', holidayDate: GROUP_DAY, name: 'Sarawak Day' });
    const sarawak = await hireInto(b.companyId, b.deptA, 'Sarawak');
    const selangor = await hireInto(b.companyId, b.deptA, 'Selangor');
    expect((await workAndClassify(sarawak.employmentId)).dayType).toBe('holiday'); // resolved state matches
    expect((await workAndClassify(selangor.employmentId)).dayType).toBe('workday'); // different state
  });

  it('regression: an unrelated subtree override does not leak — falls back to ordinary workday', async () => {
    const other = await makeCompany('Unrelated Holdings'); // no shared ancestor with the seedBase company
    await owner.db.insert(schema.holiday).values(groupHoliday(other.companyId, GROUP_DAY, 'Other Group Day'));
    const r = await workAndClassify((await hireInto(b.companyId, b.deptA, 'Selangor')).employmentId);
    expect(r.dayType).toBe('workday'); // the override on a foreign subtree must not classify this day
    expect(r.otMinutes).toBe(120);
  });
});

describe('ADR-0055 — read paths honour the business-group calendar', () => {
  it('month summary: a worked group holiday banks OT in the holiday premium bucket, not workday', async () => {
    await owner.db.insert(schema.holiday).values(groupHoliday(b.companyId, GROUP_DAY, 'Group Founders Day'));
    const emp = await hireInto(b.companyId, b.deptA, 'Selangor');
    await workAndClassify(emp.employmentId);
    const [row] = await attendanceMonthSummary(adminCtx(b), { month: '2026-07', companyIds: [b.companyId], today: '2026-07-31' });
    expect(row.otHoliday).toBe(600); // premium-class OT lands in the holiday bucket
    expect(row.otWorkday).toBe(0);
    expect(row.otRestDay).toBe(0);
  });

  it('month summary: an un-worked group holiday is not miscounted as absence', async () => {
    // Narrow the absence window to GROUP_DAY alone (hire on the day, count up to the day) so the assertion
    // is exact: the group holiday is skipped → 0 absent. Without the resolver it would be a workday → 1.
    await owner.db.insert(schema.holiday).values(groupHoliday(b.companyId, GROUP_DAY, 'Group Founders Day'));
    const emp = await hireInto(b.companyId, b.deptA, 'Selangor');
    await owner.db.update(schema.employment).set({ hiredOn: GROUP_DAY }).where(eq(schema.employment.id, emp.employmentId));
    const [row] = await attendanceMonthSummary(adminCtx(b), { month: '2026-07', companyIds: [b.companyId], today: GROUP_DAY });
    expect(row.absent).toBe(0);
  });

  it('attendanceForDate: a no-row employee on a group holiday gets context "holiday"', async () => {
    await owner.db.insert(schema.holiday).values(groupHoliday(b.companyId, GROUP_DAY, 'Group Founders Day'));
    const emp = await hireInto(b.companyId, b.deptA, 'Selangor');
    const rows = await attendanceForDate(adminCtx(b), GROUP_DAY, [b.companyId]);
    const row = rows.find((x) => x.employmentId === emp.employmentId)!;
    expect(row.attendanceId).toBeNull(); // no punch recorded
    expect(row.context).toBe('holiday'); // the group holiday explains the missing row
  });
});
