/**
 * Phase-B #15 — holiday-completeness guard + 2026 national gazette.
 *
 * PART A (the high-value safety net): when a leave request or payroll period spans a (state, year) with
 * fewer than the EA s.60D minimum of 11 gazetted public holidays loaded, the engine emits a NON-BLOCKING
 * WARNING (a `holiday.completeness.warned` domain event + a returned warning the screen surfaces). A fully
 * loaded state-year does NOT warn. The request/batch is still created either way.
 *
 * PART B: the 2026 NATIONAL gazette is loaded into MY_HOLIDAYS_2026 — fixed-date holidays plain, lunar /
 * Islamic ones carry verify:true. Per-state holidays are NOT loaded (operator data-entry task).
 */
import { eq } from 'drizzle-orm';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { withTenant } from '../db/client';
import * as schema from '../db/schema';
import { hireEmployee } from '../core/org';
import { requestLeave } from '../core/leave';
import { createBatch } from '../core/payroll';
import {
  EA_S60D_MINIMUM_HOLIDAYS,
  holidayCompletenessWarning,
  loadedHolidayCount,
  yearsSpanned,
} from '../core/holidays';
import { MY_HOLIDAYS_2026, MY_STATE_HOLIDAYS_2026 } from '../localization/my/holidays';
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
    person: { fullName: 'HC', primaryEmail: `hc_${randomUUID().slice(0, 8)}@t.local` },
    companyId: b.companyId,
    departmentId: b.deptA,
    employmentType: 'full_time',
    hiredOn: '2024-01-01',
  });
  if (workState) await owner.db.update(schema.employment).set({ workState }).where(eq(schema.employment.id, e.employmentId));
  return e;
};

/** Load N distinct national (state-null) MY holidays in `year` (deterministic dates so the count is exact). */
const loadNationalHolidays = async (year: number, n: number) => {
  const rows = [];
  for (let i = 0; i < n; i++) {
    const month = String((i % 12) + 1).padStart(2, '0');
    const day = String((i % 28) + 1).padStart(2, '0');
    rows.push({ tenantId: b.tenantId, country: 'MY', state: null, holidayDate: `${year}-${month}-${day}`, name: `Nat ${i}` });
  }
  if (rows.length) await owner.db.insert(schema.holiday).values(rows);
};

beforeAll(async () => {
  await migrateTestDb();
});
beforeEach(async () => {
  await resetDb();
  b = await seedBase();
  const [lt] = await owner.db
    .insert(schema.leaveType)
    .values({ tenantId: b.tenantId, code: 'WD', name: 'Working-day leave', paid: true, counting: 'working_days' })
    .returning({ id: schema.leaveType.id });
  wdTypeId = lt.id;
});
afterAll(async () => {
  await closeAll();
});

describe('Phase-B #15 Part A — pure threshold helpers', () => {
  it('threshold is the EA s.60D minimum of 11', () => {
    expect(EA_S60D_MINIMUM_HOLIDAYS).toBe(11);
  });

  it('holidayCompletenessWarning fires below the minimum and is null at/above it', () => {
    expect(holidayCompletenessWarning('MY', 'Selangor', 2026, 10)).toEqual({
      country: 'MY',
      state: 'Selangor',
      year: 2026,
      loaded: 10,
      required: 11,
    });
    expect(holidayCompletenessWarning('MY', 'Selangor', 2026, 11)).toBeNull();
    expect(holidayCompletenessWarning('MY', 'Selangor', 2026, 12)).toBeNull();
  });

  it('yearsSpanned covers a window crossing a year boundary', () => {
    expect(yearsSpanned('2026-12-30', '2026-12-31')).toEqual([2026]);
    expect(yearsSpanned('2026-12-30', '2027-01-02')).toEqual([2026, 2027]);
  });
});

describe('Phase-B #15 Part A — loadedHolidayCount counts national ∪ state for a year', () => {
  it('counts national + the given state, excludes other states + other years + company-scoped rows', async () => {
    await loadNationalHolidays(2026, 5); // 5 national
    await owner.db.insert(schema.holiday).values([
      { tenantId: b.tenantId, country: 'MY', state: 'Sarawak', holidayDate: '2026-07-22', name: 'Sarawak Day' },
      { tenantId: b.tenantId, country: 'MY', state: 'Selangor', holidayDate: '2026-07-23', name: 'Selangor Day' },
      // wrong year (excluded) + company-scoped (excluded — not the public gazette)
      { tenantId: b.tenantId, country: 'MY', state: null, holidayDate: '2025-01-01', name: 'Old NY' },
      { tenantId: b.tenantId, country: 'MY', state: null, companyId: b.companyId, holidayDate: '2026-09-01', name: 'Group Day' },
    ]);
    await withTenant(adminCtx(b), async (tx) => {
      expect(await loadedHolidayCount(tx, 'MY', 'Sarawak', 2026)).toBe(6); // 5 national + 1 Sarawak
      expect(await loadedHolidayCount(tx, 'MY', null, 2026)).toBe(5); // national-only set
      expect(await loadedHolidayCount(tx, 'MY', 'Selangor', 2025)).toBe(1); // only the old NY national row
    });
  });
});

describe('Phase-B #15 Part A — leave guard (warns when <11, silent when fully loaded)', () => {
  it('an under-loaded (state, year) WARNS — domain event + returned warning, request still created', async () => {
    await loadNationalHolidays(2026, 5); // only 5 < 11 for any state-year
    const emp = await hire('Selangor');
    const res = await requestLeave(adminCtx(b), {
      employmentId: emp.employmentId,
      leaveTypeId: wdTypeId,
      startDate: '2026-07-20',
      endDate: '2026-07-24',
    });
    // Non-blocking: the request was created.
    expect(res.leaveRequestId).toBeTruthy();
    // The warning surfaced on the result.
    expect(res.holidayWarnings).toBeTruthy();
    expect(res.holidayWarnings![0]).toMatchObject({ state: 'Selangor', year: 2026, loaded: 5, required: 11 });
    // The warning event was appended to the leave-request aggregate.
    expect(await eventTypesFor(b.tenantId, res.leaveRequestId)).toContain('holiday.completeness.warned');
    const payload = await latestEventPayload(b.tenantId, res.leaveRequestId, 'holiday.completeness.warned');
    expect(payload).toMatchObject({ module: 'leave', state: 'Selangor', year: 2026, loaded: 5, required: 11 });
  });

  it('a fully-loaded (state, year) does NOT warn', async () => {
    await loadNationalHolidays(2026, 11); // exactly the s.60D minimum, all national
    const emp = await hire('Selangor');
    const res = await requestLeave(adminCtx(b), {
      employmentId: emp.employmentId,
      leaveTypeId: wdTypeId,
      startDate: '2026-07-20',
      endDate: '2026-07-24',
    });
    expect(res.holidayWarnings).toBeUndefined();
    expect(await eventTypesFor(b.tenantId, res.leaveRequestId)).not.toContain('holiday.completeness.warned');
  });

  it('counts national ∪ state together — 10 national + 1 state clears the threshold', async () => {
    await loadNationalHolidays(2026, 10);
    await owner.db
      .insert(schema.holiday)
      .values({ tenantId: b.tenantId, country: 'MY', state: 'Sarawak', holidayDate: '2026-07-22', name: 'Sarawak Day' });
    const sarawak = await hire('Sarawak'); // 10 national + 1 Sarawak = 11 → no warning
    const selangor = await hire('Selangor'); // 10 national + 0 Selangor = 10 → warning
    const rS = await requestLeave(adminCtx(b), { employmentId: sarawak.employmentId, leaveTypeId: wdTypeId, startDate: '2026-07-20', endDate: '2026-07-24' });
    const rSe = await requestLeave(adminCtx(b), { employmentId: selangor.employmentId, leaveTypeId: wdTypeId, startDate: '2026-07-20', endDate: '2026-07-24' });
    expect(rS.holidayWarnings).toBeUndefined();
    expect(rSe.holidayWarnings![0]).toMatchObject({ state: 'Selangor', loaded: 10 });
  });
});

describe('Phase-B #15 Part A — payroll guard', () => {
  it('createBatch over an under-loaded (company-state, year) warns; loaded one does not', async () => {
    await owner.db.update(schema.company).set({ defaultWorkState: 'Selangor' }).where(eq(schema.company.id, b.companyId));
    await loadNationalHolidays(2026, 5); // < 11
    const warned = await createBatch(adminCtx(b), { companyId: b.companyId, payPeriod: '2026-05' });
    expect(warned.batchId).toBeTruthy();
    expect(await eventTypesFor(b.tenantId, warned.batchId)).toContain('holiday.completeness.warned');
    const payload = await latestEventPayload(b.tenantId, warned.batchId, 'holiday.completeness.warned');
    expect(payload).toMatchObject({ module: 'payroll', state: 'Selangor', year: 2026, loaded: 5 });

    // A second, fully-loaded year does not warn (different month/period in a loaded year).
    await loadNationalHolidays(2027, 11);
    const ok = await createBatch(adminCtx(b), { companyId: b.companyId, payPeriod: '2027-05' });
    expect(await eventTypesFor(b.tenantId, ok.batchId)).not.toContain('holiday.completeness.warned');
  });
});

describe('Phase-B #15 Part B — 2026 national gazette data', () => {
  it('loads the FIXED-date national holidays plain (no verify flag)', () => {
    const fixed = ['2026-01-01', '2026-05-01', '2026-06-01', '2026-08-31', '2026-09-16', '2026-12-25'];
    for (const d of fixed) {
      const row = MY_HOLIDAYS_2026.find((h) => h.date === d);
      expect(row, d).toBeTruthy();
      expect(row!.verify, `${d} must NOT be flagged for verification`).toBeFalsy();
    }
  });

  it('loads the LUNAR / Islamic holidays with verify:true', () => {
    const lunar = [
      '2026-02-17', '2026-02-18', // Chinese New Year + Day 2
      '2026-03-20', '2026-03-21', '2026-03-22', // Aidilfitri (additional + main + Day 2)
      '2026-05-27', // Aidiladha
      '2026-05-31', // Wesak
      '2026-06-17', // Awal Muharram
      '2026-08-25', // Maulidur Rasul
      '2026-11-08', // Deepavali
    ];
    for (const d of lunar) {
      const row = MY_HOLIDAYS_2026.find((h) => h.date === d);
      expect(row, d).toBeTruthy();
      expect(row!.verify, `${d} must carry verify:true`).toBe(true);
    }
  });

  it('does not invent dates beyond the plan and the full set clears the s.60D minimum', () => {
    // Every national row is one of the plan's dates (no invented ones).
    const allowed = new Set([
      '2026-01-01', '2026-05-01', '2026-06-01', '2026-08-31', '2026-09-16', '2026-12-25',
      '2026-02-17', '2026-02-18', '2026-03-20', '2026-03-21', '2026-03-22',
      '2026-05-27', '2026-05-31', '2026-06-17', '2026-08-25', '2026-11-08',
    ]);
    for (const h of MY_HOLIDAYS_2026) expect(allowed.has(h.date), `unexpected national date ${h.date}`).toBe(true);
    // The loaded national set itself meets the s.60D minimum (so a fully-national-loaded tenant is clean).
    expect(MY_HOLIDAYS_2026.length).toBeGreaterThanOrEqual(EA_S60D_MINIMUM_HOLIDAYS);
  });

  it('keeps the existing fixed-date STATE rows (operator loads the rest via the admin screen)', () => {
    // The state pack is intentionally NOT the full gazette — just the established fixed-date subset.
    expect(MY_STATE_HOLIDAYS_2026.some((h) => h.name === 'Federal Territory Day' && h.state === 'Kuala Lumpur')).toBe(true);
    expect(MY_STATE_HOLIDAYS_2026.some((h) => h.name === 'Sarawak Day' && h.state === 'Sarawak')).toBe(true);
    // No state row exceeds the established subset count → on its own a state is under the s.60D minimum,
    // which is exactly the gap the Part-A guard surfaces.
    const sarawakRows = MY_STATE_HOLIDAYS_2026.filter((h) => h.state === 'Sarawak').length;
    expect(sarawakRows).toBeLessThan(EA_S60D_MINIMUM_HOLIDAYS);
  });
});

describe('Phase-B #15 — i18n holidaysIncomplete present in all 6 locales', () => {
  const LOCALES = ['en', 'ms', 'ta', 'th', 'vi', 'zh'] as const;
  const read = (loc: string) =>
    JSON.parse(fs.readFileSync(path.resolve(__dirname, '..', 'messages', `${loc}.json`), 'utf8'));
  for (const loc of LOCALES) {
    it(`${loc}: leave.errors.holidaysIncomplete carries {loaded}/{state}/{year}`, () => {
      const msg = String(read(loc)?.leave?.errors?.holidaysIncomplete ?? '');
      expect(msg, `${loc} holidaysIncomplete`).toBeTruthy();
      expect(msg).toContain('{loaded}');
      expect(msg).toContain('{state}');
      expect(msg).toContain('{year}');
    });
  }
});
