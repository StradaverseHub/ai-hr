/**
 * r432 (e721a355) — Daily Attendance is "Individual Attendance, for everyone, on one day".
 *
 * Two halves. A: source guards that the two lists share one set of cells and the same ten columns. B: the
 * paged read (`attendanceForDatePage`) against a real database — search by name and by employee ID, the page
 * holds only its own people with a correct total, the page is derived from the SAME body as
 * `attendanceForDate`, and a MANAGER sees only their reporting line (the UNKNOWN the plan asked to verify:
 * attendanceForDate is fenced by app.can_see_employment through row-level security, not only by withTenant).
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { SessionContext } from '../db/client';
import { adminCtx, closeAll, createAppUser, migrateTestDb, resetDb, seedBase, type Base } from './harness';
import { hireEmployee, setReportingLine } from '../core/org';
import { attendanceForDate, attendanceForDatePage, attendancePunchesForDays, ATTENDANCE_DAILY_Q_MAX } from '../core/attendance';
import { todayInKualaLumpur } from '../lib/hr-date';

const root = fileURLToPath(new URL('..', import.meta.url));
const read = (rel: string) => readFileSync(root + rel, 'utf8');
const codeOnly = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

const DAILY = 'app/attendance/daily/page.tsx';
const INDIVIDUAL = 'app/attendance/individual/page.tsx';
const SHARED = 'components/attendance-day-cells.tsx';

/** The `t('colX')` header keys of a page's <thead>, in order. The slice must be found AND long. */
function headerKeys(rel: string): string[] {
  const src = read(rel);
  const a = src.indexOf('<thead');
  const b = src.indexOf('</thead>');
  expect(a, `${rel}: <thead found`).toBeGreaterThanOrEqual(0);
  expect(b, `${rel}: </thead> found`).toBeGreaterThan(a);
  const slice = src.slice(a, b);
  expect(slice.length, `${rel}: header slice is substantial`).toBeGreaterThan(300);
  return [...slice.matchAll(/t\('(col\w+)'\)/g)].map((m) => m[1]);
}

describe('r432 · Daily and Individual are the same ten columns, drawn by one component', () => {
  it('Daily headers equal Individual headers apart from the two leading identity cells', () => {
    const daily = headerKeys(DAILY);
    const indiv = headerKeys(INDIVIDUAL);
    expect(daily.length).toBe(10);
    expect(indiv.length).toBe(10);
    expect(indiv.slice(0, 2)).toEqual(['colDate', 'colDay']);
    expect(daily.slice(0, 2)).toEqual(['colEmployeeCode', 'colEmployeeName']);
    expect(daily.slice(2)).toEqual(indiv.slice(2));
  });

  it('neither page keeps its own status/flag maps, cells or trail row: both use the shared component', () => {
    for (const rel of [DAILY, INDIVIDUAL]) {
      const src = codeOnly(read(rel));
      expect(src, `${rel} imports the shared cells`).toContain("from '@/components/attendance-day-cells'");
      expect(src, `${rel} draws the shared cells`).toContain('<AttendanceDayCells');
      expect(src, `${rel} draws the shared trail`).toContain('<AttendanceTrailRow');
      expect(src, `${rel} has no private status map`).not.toMatch(/const statusText/);
      expect(src, `${rel} has no private flag map`).not.toMatch(/const flagText/);
    }
    const shared = codeOnly(read(SHARED));
    expect(shared.length).toBeGreaterThan(1500);
    // The shared component is a pack-boundary neighbour: it must not import the pack's internals.
    expect(shared).not.toMatch(/from '(@\/|\.\.\/)?(core\/attendance|packs\/attendance)/);
  });

  it('every full-width Daily row spans the ten columns, and the Action opens the day screen for that person', () => {
    const src = read(DAILY);
    const spans = [...src.matchAll(/colSpan=\{(\d+)\}/g)].map((m) => Number(m[1]));
    expect(spans.length).toBeGreaterThanOrEqual(2);
    for (const n of spans) expect(n).toBe(10);
    expect(src).toContain('/attendance/individual/${date}?emp=${encodeURIComponent(r.employmentId)}');
    expect(src).toContain("t('dayViewEdit')");
  });

  it('the calculation columns and the inline clock forms are gone from Daily', () => {
    const src = codeOnly(read(DAILY));
    for (const k of ['colLateness', 'colEarlyOut', 'colOtFlat', 'colOt00', 'colOt10', 'colOt15', 'colOt20', 'colOt30'])
      expect(src.includes(`t('${k}')`), k).toBe(false);
    expect(src).not.toContain('checkInAction');
    expect(src).not.toContain('checkOutAction');
    expect(src).not.toContain('AttendanceFigureCells');
  });

  it('the page reads through the SQL-paged loader, not the derive-everyone one', () => {
    const src = codeOnly(read(DAILY));
    expect(src).toContain('attendanceForDatePage(');
    expect(src).not.toContain('attendanceForDate(');
    expect(src).not.toContain('paginateRows');
  });
});

let b: Base;
let mgr: SessionContext;
const day = todayInKualaLumpur();
const ids: Record<string, string> = {};
const uniq = () => Math.random().toString(36).slice(2, 8);

async function hire(fullName: string, deptId?: string) {
  const e = await hireEmployee(adminCtx(b), {
    person: { fullName, primaryEmail: `r432_${uniq()}@t.local` },
    companyId: b.companyId,
    departmentId: deptId ?? b.deptA,
    employmentType: 'full_time',
    hiredOn: '2024-01-01',
  });
  return e;
}

describe('r432 · attendanceForDatePage (database)', () => {
  beforeAll(async () => {
    await migrateTestDb();
    await resetDb();
    b = await seedBase();
    // Aisha (deptA) and Daniel (deptB) report to Mara (deptA). Everyone else is in deptB and outside Mara's
    // line. NB a manager who manages anyone also counts as HEAD of her department (migration 0109's HOD
    // branch), so a deptA peer would be visible to her: the hidden people live in deptB on purpose.
    const placed: [string, string][] = [
      ['Aisha Rahman', b.deptA],
      ['Daniel Lee', b.deptB],
      ['Priya Nair', b.deptB],
      ['Wei Jie Tan', b.deptB],
      ['Zainab 100%_Ali', b.deptB],
    ];
    for (const [n, d] of placed) ids[n] = (await hire(n, d)).employmentId;
    const m = await hire('Mara Manager');
    ids.mgr = m.employmentId;
    ids.long = (await hire('Longname' + 'n'.repeat(300), b.deptB)).employmentId;
    const outsider = await hire('Olive Outsider', b.deptB);
    ids.outsider = outsider.employmentId;
    const uM = await createAppUser(b.tenantId, m.personId, 'manager');
    await setReportingLine(adminCtx(b), {
      subordinateEmploymentId: ids['Aisha Rahman'],
      managerEmploymentId: m.employmentId,
      lineType: 'administrative',
      validFrom: '2024-01-01',
    });
    await setReportingLine(adminCtx(b), {
      subordinateEmploymentId: ids['Daniel Lee'],
      managerEmploymentId: m.employmentId,
      lineType: 'administrative',
      validFrom: '2024-01-01',
    });
    mgr = { tenantId: b.tenantId, userId: uM, roles: ['manager'], personId: m.personId, entitlements: adminCtx(b).entitlements };
  }, 120_000);
  afterAll(closeAll);

  const page = (ctx: SessionContext, o: { q?: string; limit?: number; offset?: number; departmentId?: string } = {}) =>
    attendanceForDatePage(ctx, day, [b.companyId], { limit: 25, offset: 0, ...o });

  it('returns one row per person with the total, ordered by employee code', async () => {
    const r = await page(adminCtx(b));
    expect(r.total).toBe(r.rows.length);
    expect(r.total).toBeGreaterThanOrEqual(7);
    const codes = r.rows.map((x) => x.employeeCode ?? '￿');
    expect(codes).toEqual([...codes].sort());
  });

  it('paging returns only the page and a total that ignores the page', async () => {
    const all = await page(adminCtx(b));
    const p1 = await page(adminCtx(b), { limit: 3, offset: 0 });
    const p2 = await page(adminCtx(b), { limit: 3, offset: 3 });
    expect(p1.rows.length).toBe(3);
    expect(p1.total).toBe(all.total);
    expect(p2.total).toBe(all.total);
    expect(p2.rows.map((x) => x.employmentId)).toEqual(all.rows.slice(3, 6).map((x) => x.employmentId));
    const overlap = p1.rows.filter((x) => p2.rows.some((y) => y.employmentId === x.employmentId));
    expect(overlap).toEqual([]);
    const past = await page(adminCtx(b), { limit: 3, offset: 1000 });
    expect(past.rows).toEqual([]);
    expect(past.total).toBe(all.total);
  });

  it('the page is derived exactly as attendanceForDate derives it', async () => {
    const all = await attendanceForDate(adminCtx(b), day, [b.companyId]);
    const p = await page(adminCtx(b), { limit: 4, offset: 0 });
    for (const row of p.rows) {
      const same = all.find((x) => x.employmentId === row.employmentId)!;
      expect(row).toEqual(same);
    }
  });

  it('search by name, case-insensitively, and by employee ID', async () => {
    const byName = await page(adminCtx(b), { q: 'priya' });
    expect(byName.rows.map((x) => x.name)).toEqual(['Priya Nair']);
    expect(byName.total).toBe(1);
    const code = byName.rows[0].employeeCode!;
    expect(code).toBeTruthy();
    const byCode = await page(adminCtx(b), { q: code });
    expect(byCode.rows.some((x) => x.employmentId === ids['Priya Nair'])).toBe(true);
    const none = await page(adminCtx(b), { q: 'no-such-person-' + uniq() });
    expect(none).toEqual({ rows: [], total: 0 });
  });

  it('LIKE wildcards in the search match themselves, not everyone', async () => {
    const pct = await page(adminCtx(b), { q: '%' });
    expect(pct.rows.map((x) => x.name)).toEqual(['Zainab 100%_Ali']);
    const us = await page(adminCtx(b), { q: '_' });
    expect(us.rows.map((x) => x.name)).toEqual(['Zainab 100%_Ali']);
  });

  it('q is capped, so a huge query is trimmed rather than run', async () => {
    const huge = 'a'.repeat(ATTENDANCE_DAILY_Q_MAX + 500);
    const r = await page(adminCtx(b), { q: huge });
    expect(r.total).toBe(0);
    // The first ATTENDANCE_DAILY_Q_MAX characters are what is searched: a name followed by padding still matches.
    // 192 n's after 'Longname' is exactly the cap; the three Z's beyond it are what the cap throws away. Without
    // the cap the Z's would be searched for and nothing would match.
    const overlong = 'Longname' + 'n'.repeat(ATTENDANCE_DAILY_Q_MAX - 8) + 'ZZZ';
    expect(overlong.length).toBe(ATTENDANCE_DAILY_Q_MAX + 3);
    const capped = await page(adminCtx(b), { q: overlong });
    expect(capped.rows.map((x) => x.employmentId)).toEqual([ids.long]);
  });

  it('the department filter still narrows the page and the total', async () => {
    const r = await page(adminCtx(b), { departmentId: b.deptA });
    expect(r.rows.map((x) => x.name).sort()).toEqual(['Aisha Rahman', 'Mara Manager']);
    expect(r.total).toBe(2);
  });

  it('a MANAGER sees only their reporting line (and themselves), in the rows and in the total', async () => {
    const r = await page(mgr);
    const names = r.rows.map((x) => x.name).sort();
    expect(names).toEqual(['Aisha Rahman', 'Daniel Lee', 'Mara Manager']);
    expect(r.total).toBe(3);
    // search cannot reach beyond the fence either
    const peek = await page(mgr, { q: 'Priya' });
    expect(peek).toEqual({ rows: [], total: 0 });
    const peekOut = await page(mgr, { q: 'Olive' });
    expect(peekOut).toEqual({ rows: [], total: 0 });
    // and the original loader is fenced the same way
    const old = await attendanceForDate(mgr, day, [b.companyId]);
    expect(old.map((x) => x.name).sort()).toEqual(names);
  });

  it('the punch trail loader returns nothing for no days and is fenced for a manager', async () => {
    expect((await attendancePunchesForDays(adminCtx(b), [])).size).toBe(0);
    expect((await attendancePunchesForDays(mgr, ['00000000-0000-0000-0000-000000000000'])).size).toBe(0);
  });
});
