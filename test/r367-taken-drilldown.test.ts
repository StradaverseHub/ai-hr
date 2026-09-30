/**
 * r367 (073233bb) — THE TAKEN DRILL-DOWN, and the "same employee, code and year" invariant behind it.
 *
 * The reporter's own words: "Clicking the Taken figure in Employee Balances should open Employee Leave
 * Record filtered to that employee, leave code and year, so HR can see exactly which records make up the
 * number." That is the item's whole complaint stated as a feature — the two tabs must agree, and one click
 * must show why.
 *
 * ═══ THE FAILURE MODE THIS FILE EXISTS FOR ═══
 *
 * A link that filters on the CALENDAR year of the figure is wrong on an anniversary-cycle company, whose
 * leave year does not start on 1 January. It would list a different set of records from the ones the Taken
 * figure was computed over and quietly disagree with the number it was clicked from — which is exactly the
 * complaint, rebuilt one screen further along. So the row carries the entitlement CYCLE's two dates, the
 * link sends them as Employee Leave Record's leave-date window, and the runtime case below is on an
 * ANNIVERSARY company so the calendar-year version of the link would fail it.
 *
 * ═══ AND THE AGREEMENT ITSELF ═══
 *
 * The last case is the invariant, measured rather than asserted: the records the drill-down lists sum to
 * the Taken figure the link was on.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import * as schema from '../db/schema';
import { adminCtx, closeAll, migrateTestDb, owner, resetDb, seedBase, type Base } from './harness';
import { hireEmployee } from '../core/org';
import { leaveCycleEnd } from '../core/leave';
import { listLeaveRequestsPage } from '../core/read';
import { commitLeaveHistoryImport } from '../core/leave-history-import';
import { employeeBalanceRows } from '../app/leave/employee-balances/rows';
import { todayInKualaLumpur } from '../lib/hr-date';
import en from '../messages/en.json';
import ms from '../messages/ms.json';
import ta from '../messages/ta.json';
import th from '../messages/th.json';
import vi_ from '../messages/vi.json';
import zh from '../messages/zh.json';

const root = fileURLToPath(new URL('..', import.meta.url));
const read = (rel: string) => readFileSync(root + rel, 'utf8');
/** THE CODE, NOT THE COMMENTS: this file's own comments name the wrong link shape, and a ratchet a comment
 *  can trip is a ratchet nobody keeps (2a57a007's rule). */
const code = (rel: string) =>
  read(rel)
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');

const PAGE = 'app/leave/employee-balances/page.tsx';
const ROWS = 'app/leave/employee-balances/rows.ts';
const CATALOGUES = { en, ms, ta, th, vi: vi_, zh } as const;

const TODAY = todayInKualaLumpur();
const addDays = (iso: string, n: number) =>
  new Date(Date.parse(`${iso}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);

let b: Base;

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

describe('the link the Taken figure carries', () => {
  it('sends the employee, the type AND the cycle window — never a bare calendar year', () => {
    const src = code(PAGE);
    expect(src).toContain('takenRecordsHref');
    // The window, from the row's own cycle. `slice(0, 4)` anywhere in this link would be the calendar-year
    // version this file exists to refuse.
    expect(src).toMatch(/from=\$\{r\.cycleStart\}&to=\$\{r\.cycleEnd\}/);
    // The leave CODE cell keeps its own, unnarrowed link: "every record of this type", across years, is a
    // different and still-wanted answer.
    expect(src).toContain('recordsHref(r.leaveTypeId)');
    // The figure is a link, and the caption that says what clicking it does resolves in all six locales.
    expect(src).toContain("tInq('takenRecordsLink')");
    for (const [loc, cat] of Object.entries(CATALOGUES)) {
      const v = (cat as { leave: { inquiry: Record<string, unknown> } }).leave.inquiry.takenRecordsLink;
      expect(typeof v, `${loc} leave.inquiry.takenRecordsLink`).toBe('string');
    }
  });

  it('the row carries the cycle as two DATES, taken off the same breakdown every other figure comes from', () => {
    const src = code(ROWS);
    expect(src).toContain('cycleStart: bd ? bd.cycleStart : null');
    expect(src).toContain('cycleEnd: bd ? leaveCycleEnd(bd.cycleStart) : null');
    // One definition of where a cycle closes, imported rather than re-derived — see leaveCycleEnd's header
    // in core/leave.ts for the 147-row incident that exists because a cycle once had a start and no end.
    expect(src).toContain("from '@/core/leave'");
  });
});

describe('the figure and the records behind it agree, on an ANNIVERSARY cycle', () => {
  it('the drill-down window is the entitlement cycle, and its records sum to the Taken figure', async () => {
    // An anniversary company: the leave year is anchored to the hire MONTH, so a calendar-year link would
    // list a different set of records from the ones Taken was computed over.
    await owner.db
      .update(schema.company)
      .set({ leaveCycle: 'anniversary' })
      .where(eq(schema.company.id, b.companyId));

    // Hired in a month that is deliberately not January, so cycleStart !== `${year}-01-01`.
    const hiredOn = `${Number(TODAY.slice(0, 4)) - 3}-07-01`;
    const { employmentId } = await hireEmployee(adminCtx(b), {
      person: { fullName: 'Drilldown Subject', primaryEmail: `dd_${randomUUID().slice(0, 8)}@t.local` },
      companyId: b.companyId,
      departmentId: b.deptA,
      employmentType: 'full_time',
      hiredOn,
    });
    const [empRow] = await owner.db
      .select({ code: schema.employment.employeeCode })
      .from(schema.employment)
      .where(eq(schema.employment.id, employmentId));

    // A real opening balance, so the Taken figure below is measured against something.
    await owner.db.insert(schema.leaveLedger).values({
      tenantId: b.tenantId,
      employmentId,
      leaveTypeId: b.annualLeaveTypeId,
      entryType: 'accrual',
      days: '20.00',
      effectiveOn: addDays(TODAY, -30),
    });

    // Two imported records INSIDE the current cycle. r367's import charges them, so they are in Taken.
    const inCycle = addDays(TODAY, -10);
    const records = [
      { ref: `LV/DD/${randomUUID().slice(0, 6)}`, start: inCycle, days: '2' },
      { ref: `LV/DD/${randomUUID().slice(0, 6)}`, start: addDays(inCycle, -3), days: '1' },
    ];
    await commitLeaveHistoryImport(adminCtx(b), {
      records: records.map((r) => ({
        employee_no: empRow.code!,
        leave_reference: r.ref,
        leave_code: 'ANNUAL',
        entitlement_year: '',
        leave_start_date: r.start,
        leave_end_date: r.start,
        number_of_day: r.days,
        session: '',
        entry_date: '',
        submit_date: '',
        approved_date: '',
        remark: 'Data Migration',
      })),
    });

    const rows = await employeeBalanceRows(adminCtx(b), employmentId, TODAY, 'en');
    const annual = rows.find((r) => r.leaveTypeId === b.annualLeaveTypeId)!;

    // The cycle really is an anniversary one, so this case is not passing by coincidence with a calendar
    // year: assert the boundary in its own right first.
    expect(annual.cycleStart).not.toBeNull();
    expect(annual.cycleStart!.slice(5)).toBe('07-01');
    expect(annual.cycleStart!.slice(5)).not.toBe('01-01');
    expect(annual.cycleEnd).toBe(leaveCycleEnd(annual.cycleStart!));
    expect(annual.entitlementYear).toBe(annual.cycleStart!.slice(0, 4));
    expect(annual.taken).toBe(3);

    // THE AGREEMENT: the records the drill-down link lists are the records the figure is the sum of.
    const page = await listLeaveRequestsPage(adminCtx(b), {
      employmentIds: [employmentId],
      leaveTypeIds: [b.annualLeaveTypeId],
      from: annual.cycleStart!,
      to: annual.cycleEnd!,
      limit: 50,
      offset: 0,
    });
    expect(page.total).toBe(2);
    expect(page.rows.reduce((sum, r) => sum + Number(r.days), 0)).toBe(annual.taken);
    // …and the entitlement year written on each record is the cycle's year, not the calendar year — which
    // is what makes "the same employee, code and year" one answer across both tabs.
    const stored = await owner.db
      .select({ y: schema.leaveRequest.entitlementYear })
      .from(schema.leaveRequest)
      .where(eq(schema.leaveRequest.employmentId, employmentId));
    expect(stored.every((r) => r.y === Number(annual.cycleStart!.slice(0, 4)))).toBe(true);
  });
});
