/**
 * r404 (42e55e2b) — MY LEAVE › LEAVE DETAILS: the employee's own Employee Balances.
 *
 * FOUR CLAIMS, each pinned through the production path on a real database, under RLS-bearing sessions:
 *
 *  1. PARITY (load-bearing). For one employee and one As-at date, the rows this page prints are HR's rows —
 *     field for field, read under the EMPLOYEE's own session against HR's — narrowed only by the employee's
 *     visibility rule. Two dates, a pool borrower, an archived type holding days, a prorated mid-year hire,
 *     a brought-forward balance.
 *  2. SCOPE. No parameter — `emp`, `employmentId`, `personId`, `code`, in the page's address or the export's —
 *     makes the page or the file return anybody but the signed-in person, under an employee, a manager (whose
 *     direct report is the colleague tried) and an HR administrator. RLS does NOT confine the last two, which is
 *     why this is tested rather than assumed.
 *  3. VISIBILITY. Hidden, ineligible and all-zero types are absent; an archived type with days is present; the
 *     hidden borrower's days still show on the pool's Share; an ESS-hidden figure is null, never a number, and
 *     withholds the Explain panel.
 *  4. THE FILE IS THE SCREEN: the xlsx carries exactly the sixteen on-screen headings, in order, and its
 *     figures are the screen's digits.
 *
 * WHAT IS MOCKED, AND WHY THAT IS HONEST: the request-scoped session (`getSession`, `scopedSession`) and
 * next-intl's request-scoped catalogue, which resolves the SHIPPING messages/en.json through next-intl's own
 * `createTranslator` (a missing key surfaces as an error, as on a dev server). Everything else — myEmployment,
 * both reads, the row builder, SheetJS — is the code that ships.
 */
import fs from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const { sessionHolder } = vi.hoisted(() => ({ sessionHolder: { s: null as unknown } }));
vi.mock('@/lib/session', () => ({ getSession: vi.fn(async () => sessionHolder.s) }));
vi.mock('@/lib/scope', () => ({
  scopedSession: vi.fn(async () => ({ s: sessionHolder.s, scopeIds: [], allowedCount: 1 })),
}));
vi.mock('next-intl/server', async () => {
  const { createTranslator } = await import('next-intl');
  const nodeFs = await import('node:fs');
  const en = JSON.parse(nodeFs.readFileSync('messages/en.json', 'utf8'));
  return {
    getTranslations: async (ns?: string) =>
      createTranslator({
        locale: 'en',
        messages: en,
        namespace: ns as never,
        onError: (e: Error) => {
          throw e;
        },
      }),
    getLocale: async () => 'en',
  };
});

import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import * as XLSX from 'xlsx';
import * as schema from '../db/schema';
import type { SessionContext } from '../db/client';
import { adminCtx, closeAll, createAppUser, migrateTestDb, owner, resetDb, seedBase, type Base } from './harness';
import { hireEmployee, setReportingLine } from '../core/org';
import { requestLeave } from '../core/leave';
import { leaveBalances } from '../core/read';
import { createEligibilityRule, createEntitlementTemplate } from '../core/entitlement-template';
import { ESS_VIEW_COMPONENT_KEYS } from '../core/ess-view';
import { todayInKualaLumpur } from '../lib/hr-date';
import { formatDays } from '../lib/day-format';
import { SELF_VOICED_EXPLAIN_KEYS } from '../lib/leave-summary-explain';
import {
  employeeBalanceRows,
  hasAnyFigure,
  selfView,
  type EmployeeBalanceRow,
  type SelfBalanceRow,
} from '../app/leave/employee-balances/rows';
import {
  LEAVE_DETAILS_COLUMNS,
  LEAVE_DETAILS_FIGURES,
  leaveDetailsAsOf,
  leaveDetailsExportHref,
  leaveDetailsFilename,
  loadLeaveDetails,
} from '../app/leave/details/data';
import LeaveDetailsPage from '../app/leave/details/page';
import { GET as exportGET } from '../app/leave/details/export/route';

const ROOT = path.resolve(__dirname, '..');
const read = (rel: string) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const codeOnly = (src: string) =>
  src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\{\/\*[\s\S]*?\*\/\}/g, '').replace(/^\s*\/\/.*$/gm, '');
const LOCALES = ['en', 'ms', 'ta', 'th', 'vi', 'zh'] as const;
const cat = (l: string) => JSON.parse(read(`messages/${l}.json`));
const EN = cat('en');
const dig = (o: unknown, dotted: string): unknown =>
  dotted.split('.').reduce<unknown>((acc, k) => (acc && typeof acc === 'object' ? (acc as Record<string, unknown>)[k] : undefined), o);

// Dates off the clock, never hardcoded (CLAUDE.md §8). Every event sits inside the CURRENT calendar year.
const TODAY = todayInKualaLumpur();
const Y = Number(TODAY.slice(0, 4));
const AS_OF_MID = `${Y}-06-30`;
const AS_OF_END = `${Y}-12-31`;
const AS_OFS = [AS_OF_MID, AS_OF_END] as const;

let b: Base;
const uniq = (p: string) => `${p} ${randomUUID().slice(0, 6)}`;
const code = (p: string) => `${p}${randomUUID().slice(0, 4).toUpperCase()}`;

async function leaveTypeRow(o: {
  code: string;
  name?: string;
  balanceSourceTypeId?: string;
  visibleToEmployee?: boolean;
  archived?: boolean;
  essViewConfig?: Record<string, boolean>;
  role?: 'annual';
}) {
  const [row] = await owner.db
    .insert(schema.leaveType)
    .values({
      tenantId: b.tenantId,
      code: o.code,
      name: o.name ?? uniq(o.code),
      paid: true,
      counting: 'calendar_days',
      allowNegativeBalance: true,
      ...(o.balanceSourceTypeId ? { balanceSourceTypeId: o.balanceSourceTypeId } : {}),
      ...(o.visibleToEmployee === false ? { visibleToEmployee: false } : {}),
      ...(o.archived ? { archivedAt: new Date(`${Y}-01-02T00:00:00Z`) } : {}),
      ...(o.essViewConfig ? { essViewConfig: o.essViewConfig } : {}),
      ...(o.role ? { role: o.role } : {}),
    })
    .returning({ id: schema.leaveType.id });
  return row.id;
}

const ledger = (employmentId: string, leaveTypeId: string, days: number, effectiveOn: string) =>
  owner.db.insert(schema.leaveLedger).values({
    tenantId: b.tenantId,
    employmentId,
    leaveTypeId,
    entryType: 'accrual',
    days: days.toFixed(2),
    effectiveOn,
  });

async function hire(name: string, hiredOn = '2020-01-01') {
  return hireEmployee(adminCtx(b), {
    person: { fullName: name, primaryEmail: `r404_${randomUUID().slice(0, 8)}@t.local` },
    companyId: b.companyId,
    departmentId: b.deptA,
    employmentType: 'full_time',
    hiredOn,
  });
}

async function ctxFor(e: { personId: string }, role: 'employee' | 'manager' | 'hr_admin'): Promise<SessionContext> {
  return {
    tenantId: b.tenantId,
    userId: await createAppUser(b.tenantId, e.personId, role),
    personId: e.personId,
    roles: [role],
    entitlements: adminCtx(b).entitlements,
  };
}

const codeOf = async (employmentId: string) => {
  const rows = await owner.db.select({ id: schema.employment.id, code: schema.employment.employeeCode }).from(schema.employment);
  return rows.find((r) => r.id === employmentId)!.code;
};

/**
 * The world: Annual Leave pool (with an entitlement table) and a HIDDEN Emergency Leave borrowing from it
 * (production's shape), a hidden type holding the employee's own days, an archived type still holding days,
 * a type with nothing at all, and four people — Aisyah (the employee), her manager, an HR administrator who
 * is also an employee, and a colleague hired this year (the prorated case). Each holds a DIFFERENT number of
 * Annual Leave days, so a row from the wrong person is visible in its figure.
 */
async function world() {
  // role 'annual': proration is decided by the leave type's ROLE (845903a3), so the mid-year hire prorates.
  const AL = await leaveTypeRow({ code: code('AL'), name: uniq('Annual'), role: 'annual' });
  const EL = await leaveTypeRow({ code: code('EL'), name: uniq('Emergency'), balanceSourceTypeId: AL, visibleToEmployee: false });
  const HID = await leaveTypeRow({ code: code('HD'), name: uniq('Hidden Own'), visibleToEmployee: false });
  const ARC = await leaveTypeRow({ code: code('AR'), name: uniq('Retired'), archived: true });
  const ZERO = await leaveTypeRow({ code: code('ZZ'), name: uniq('Nothing') });

  const tpl = await createEntitlementTemplate(adminCtx(b), {
    leaveTypeId: AL,
    name: uniq('AL table'),
    serviceBands: [{ fromYears: 0, toYears: null, days: 14 }],
    validFrom: '2019-01-01',
  });
  await createEligibilityRule(adminCtx(b), {
    name: uniq('AL rule'),
    templateLineageId: tpl.lineageId,
    criteria: {} as never,
    validFrom: '2019-01-01',
  });

  const aisyah = await hire('Aisyah R');
  const mgr = await hire('Manager M');
  const hr = await hire('Hana HR');
  const newbie = await hire('Newbie N', `${Y}-03-01`);
  await setReportingLine(adminCtx(b), {
    subordinateEmploymentId: aisyah.employmentId,
    managerEmploymentId: mgr.employmentId,
    lineType: 'administrative',
    validFrom: '2020-01-01',
  });

  // Aisyah: 16 days this year (+2 on 1 September) + 5 brought forward from last year, one approved and one pending EL day-pair
  // drawn from the pool, 4 days on the hidden type, 3 on the retired type.
  await ledger(aisyah.employmentId, AL, 16, `${Y}-01-01`);
  await ledger(aisyah.employmentId, AL, 5, `${Y - 1}-06-01`);
  // A credit BETWEEN the two As-at dates: without it a read that ignored asOf would answer both dates alike.
  await ledger(aisyah.employmentId, AL, 2, `${Y}-09-01`);
  await ledger(aisyah.employmentId, HID, 4, `${Y}-01-01`);
  await ledger(aisyah.employmentId, ARC, 3, `${Y}-01-01`);
  const ctx = adminCtx(b);
  // The approved day is posted as the ledger debit an approval writes (decideLeave left this fixture's request
  // pending under the seeded approval chain, and the fixture must not depend on the chain or the calendar).
  await owner.db.insert(schema.leaveLedger).values({
    tenantId: b.tenantId,
    employmentId: aisyah.employmentId,
    leaveTypeId: EL,
    entryType: 'debit',
    days: '-1.00',
    effectiveOn: `${Y}-03-02`,
  });
  await requestLeave(ctx, { employmentId: aisyah.employmentId, leaveTypeId: EL, startDate: `${Y}-04-06`, endDate: `${Y}-04-07`, today: `${Y}-01-15` });

  await ledger(mgr.employmentId, AL, 9, `${Y}-01-01`);
  await ledger(hr.employmentId, AL, 7, `${Y}-01-01`);
  await ledger(newbie.employmentId, AL, 2, `${Y}-03-01`);

  return {
    types: { AL, EL, HID, ARC, ZERO },
    aisyah: { ...aisyah, ctx: await ctxFor(aisyah, 'employee'), code: await codeOf(aisyah.employmentId) },
    mgr: { ...mgr, ctx: await ctxFor(mgr, 'manager'), code: await codeOf(mgr.employmentId) },
    hr: { ...hr, ctx: await ctxFor(hr, 'hr_admin'), code: await codeOf(hr.employmentId) },
    newbie: { ...newbie, ctx: await ctxFor(newbie, 'employee'), code: await codeOf(newbie.employmentId) },
  };
}

const byId = <T extends { leaveTypeId: string }>(rows: T[]) => new Map(rows.map((r) => [r.leaveTypeId, r]));

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

describe('r404 · 1. PARITY — the employee sees HR’s figures for the same employee and date', () => {
  it('self rows (employee session) equal HR rows (HR session) field for field, narrowed by the visibility rule', async () => {
    const w = await world();
    let compared = 0;
    for (const who of [w.aisyah, w.newbie]) {
      for (const asOf of AS_OFS) {
        const hr = await employeeBalanceRows(adminCtx(b), who.employmentId, asOf, 'en');
        const self = await employeeBalanceRows(who.ctx, who.employmentId, asOf, 'en', {}, { audience: 'self' });
        // THE RULE, read from the kernel the employee's own screens use — not restated here.
        const visible = new Set(
          (await leaveBalances(who.ctx, who.employmentId, 'en', { includeHidden: false, includeArchived: true, includeIneligible: false, asOf })).map(
            (r) => r.leaveTypeId,
          ),
        );
        const expected = hr.filter((r) => visible.has(r.leaveTypeId) && hasAnyFigure(r));
        expect(self.map((r) => r.leaveTypeId), `${asOf}: the same rows, in the same order`).toEqual(expected.map((r) => r.leaveTypeId));
        expect(self.length, `${asOf}: non-vacuous`).toBeGreaterThan(0);
        const hrById = byId(hr);
        for (const s of self) {
          // No ESS switch is off in this world, so the self row must be HR's row EXACTLY — every figure, the
          // breakdown the Explain panel opens (derivation included), the captions' inputs.
          expect(s, `${asOf} ${s.code}`).toEqual(hrById.get(s.leaveTypeId));
          compared++;
        }
      }
    }
    expect(compared, 'figures were actually compared').toBeGreaterThanOrEqual(6);
  });

  it('the world exercises what the plan names: two dates that differ, a borrower, an archived type with days, BF, a prorated hire', async () => {
    const w = await world();
    const mid = byId(await employeeBalanceRows(w.aisyah.ctx, w.aisyah.employmentId, AS_OF_MID, 'en', {}, { audience: 'self' }));
    const end = byId(await employeeBalanceRows(w.aisyah.ctx, w.aisyah.employmentId, AS_OF_END, 'en', {}, { audience: 'self' }));
    const al = mid.get(w.types.AL)!;
    expect(al.share, 'the hidden borrower’s approved day shows on the pool’s Share').toBe(1);
    expect(al.pendingShare, 'and its pending days on Pending Share').toBe(2);
    expect((al.sharedBalance?.contributions ?? []).some((c) => c.leaveTypeId === w.types.EL), 'the EL badge has its contribution').toBe(true);
    // Last year's 5 days reach the row's breakdown as the balance before the year opened; with no carry rule
    // they do not carry, which is itself a figure the parity comparison above holds HR and self to.
    expect(al.breakdown?.broughtForward, 'brought forward from last year reaches the row').toBe(5);
    expect(mid.get(w.types.ARC)?.balance, 'the archived type holding days is listed').toBe(3);
    // The second date must answer differently somewhere, or "two dates" proves nothing about asOf.
    const hrMid = await employeeBalanceRows(adminCtx(b), w.newbie.employmentId, AS_OF_MID, 'en');
    const hrEnd = await employeeBalanceRows(adminCtx(b), w.newbie.employmentId, AS_OF_END, 'en');
    expect(JSON.stringify(hrMid) === JSON.stringify(hrEnd) && JSON.stringify(mid) === JSON.stringify(end), 'the two dates are distinguishable').toBe(false);
    const nb = byId(await employeeBalanceRows(w.newbie.ctx, w.newbie.employmentId, AS_OF_END, 'en', {}, { audience: 'self' })).get(w.types.AL)!;
    expect(nb.breakdown?.entitlement.prorated, 'the mid-year hire’s entitlement is prorated').toBe(true);
    expect(nb.fullEntitlement, 'and so is below the 14-day band').toBeLessThan(14);
  });
});

describe('r404 · 2. SCOPE — no parameter reaches anybody else’s row', () => {
  const HOSTILE = (id: string, personId: string, code: string) => ({
    emp: id,
    employmentId: id,
    employment: id,
    personId,
    code,
  });

  it('the loader, under an employee, a manager and HR, returns the session’s own rows whatever the address says', async () => {
    const w = await world();
    const cases = [
      { who: w.aisyah, other: w.newbie },
      // The manager tries their own direct report — RLS lets a manager read that row, so only the design stops it.
      { who: w.mgr, other: w.aisyah },
      // HR tries anybody — RLS lets HR read every row.
      { who: w.hr, other: w.aisyah },
    ];
    for (const { who, other } of cases) {
      const sp = HOSTILE(other.employmentId, other.personId, other.code ?? '');
      const got = await loadLeaveDetails(who.ctx, { ...sp, asOf: AS_OF_END }, 'en');
      expect(got.me?.employmentId, `${who.ctx.roles?.[0]}: the employment is the session’s`).toBe(who.employmentId);
      const own = await employeeBalanceRows(who.ctx, who.employmentId, AS_OF_END, 'en', {}, { audience: 'self' });
      expect(got.rows, `${who.ctx.roles?.[0]}: the session’s own rows`).toEqual(own);
      const theirs = await employeeBalanceRows(adminCtx(b), other.employmentId, AS_OF_END, 'en', {}, { audience: 'self' });
      expect(JSON.stringify(got.rows), `${who.ctx.roles?.[0]}: distinguishable from the colleague’s`).not.toEqual(JSON.stringify(theirs));
    }
  });

  it('the PAGE, given a colleague’s id in every shape, renders the session’s own name, code and figures only', async () => {
    const w = await world();
    for (const { who, other } of [
      { who: w.aisyah, other: w.newbie },
      { who: w.mgr, other: w.aisyah },
      { who: w.hr, other: w.aisyah },
    ]) {
      sessionHolder.s = who.ctx;
      const tree = await LeaveDetailsPage({
        searchParams: Promise.resolve({ ...HOSTILE(other.employmentId, other.personId, other.code ?? ''), asOf: AS_OF_END }),
      });
      const markup = JSON.stringify(tree);
      expect(markup, 'non-vacuous: the page rendered its table').toContain('leave-details-table');
      expect(markup, 'the session’s own name').toContain(
        who === w.aisyah ? 'Aisyah R' : who === w.mgr ? 'Manager M' : 'Hana HR',
      );
      expect(markup, 'never the colleague’s name').not.toContain(other === w.newbie ? 'Newbie N' : 'Aisyah R');
      expect(markup, 'never the colleague’s employment id').not.toContain(other.employmentId);
      if (other.code) expect(markup, 'never the colleague’s Employee No.').not.toContain(`"${other.code}"`);
      // The download link carries the date only — nothing that names a person.
      expect(markup).toContain(JSON.stringify(leaveDetailsExportHref(AS_OF_END, undefined)));
    }
  });

  it('the EXPORT, given a colleague’s id, hands back the session’s own workbook under the session’s own Employee No.', async () => {
    const w = await world();
    const alHeading = (EN.leave.inquiry.colLeaveCode as string);
    for (const { who, other, ownAl } of [
      { who: w.aisyah, other: w.newbie, ownAl: null as number | null },
      { who: w.mgr, other: w.aisyah, ownAl: 9 },
      { who: w.hr, other: w.aisyah, ownAl: 7 },
    ]) {
      sessionHolder.s = who.ctx;
      const qs = new URLSearchParams({ ...HOSTILE(other.employmentId, other.personId, other.code ?? ''), asOf: AS_OF_END });
      const res = await exportGET(new Request(`http://t.local/leave/details/export?${qs.toString()}`));
      expect(res.status).toBe(200);
      expect(res.headers.get('content-type')).toContain('spreadsheetml.sheet');
      expect(res.headers.get('content-disposition')).toContain(`filename="${leaveDetailsFilename(who.code, AS_OF_END)}.xlsx"`);
      if (other.code) expect(res.headers.get('content-disposition')).not.toContain(other.code);
      const wb = XLSX.read(new Uint8Array(await res.arrayBuffer()), { type: 'array' });
      const grid = XLSX.utils.sheet_to_json<(string | number | null)[]>(wb.Sheets[wb.SheetNames[0]!]!, { header: 1, defval: null });
      expect(grid[0]![0]).toBe(alHeading);
      const own = await employeeBalanceRows(who.ctx, who.employmentId, AS_OF_END, 'en', {}, { audience: 'self' });
      expect(grid.length - 1, 'one line per own row').toBe(own.length);
      const balCol = LEAVE_DETAILS_COLUMNS.findIndex((c) => c.id === 'balance');
      const alRow = own.findIndex((r) => r.leaveTypeId === w.types.AL);
      expect(grid[alRow + 1]![balCol], 'the AL balance is the session’s own').toBe(own[alRow]!.balance);
      if (ownAl != null) expect(own[alRow]!.balance).toBe(ownAl);
    }
  });

  it('a login linked to no employee gets the not-linked state on the page and a 403 from the export', async () => {
    sessionHolder.s = adminCtx(b); // the seeded HR admin has no person
    const tree = JSON.stringify(await LeaveDetailsPage({ searchParams: Promise.resolve({ emp: randomUUID() }) }));
    expect(tree).toContain('leave-details-not-linked');
    expect(tree).not.toContain('leave-details-table');
    const res = await exportGET(new Request(`http://t.local/leave/details/export?emp=${randomUUID()}`));
    expect(res.status).toBe(403);
  });

  it('the source reads no person-naming parameter — the loader reads asOf and q, the route hands the loader the query', () => {
    const data = codeOnly(read('app/leave/details/data.ts'));
    const page = codeOnly(read('app/leave/details/page.tsx'));
    const route = codeOnly(read('app/leave/details/export/route.ts'));
    for (const [name, src] of [['data', data], ['page', page], ['route', route]] as const) {
      expect(src.length, `${name} is non-empty`).toBeGreaterThan(500);
      expect(src, `${name} must never read an employee off the address`).not.toMatch(/\b(sp|input|searchParams|url\.searchParams)\s*(\.|\[)\s*['"]?(emp|employmentId|personId)\b/);
    }
    expect(data).toContain('myEmployment(session)');
    expect(data).toContain('employeeBalanceRows(session, me.employmentId, asOf, locale, { q }, { audience: \'self\' })');
    expect(page).toContain('loadLeaveDetails(session, sp, locale)');
    expect(route).toContain('loadLeaveDetails(session,');
  });
});

describe('r404 · 3. VISIBILITY — what the employee may and may not see', () => {
  it('hidden, all-zero types are absent; the archived type with days is present; HR still sees every one', async () => {
    const w = await world();
    const self = byId(await employeeBalanceRows(w.aisyah.ctx, w.aisyah.employmentId, AS_OF_END, 'en', {}, { audience: 'self' }));
    const hr = byId(await employeeBalanceRows(adminCtx(b), w.aisyah.employmentId, AS_OF_END, 'en'));
    expect(self.has(w.types.EL), 'Emergency Leave is hidden from employees (visible_to_employee=false)').toBe(false);
    expect(self.has(w.types.HID), 'a hidden type holding days is still hidden').toBe(false);
    expect(self.has(w.types.ZERO), 'a type with nothing at all is left out').toBe(false);
    expect(self.has(w.types.ARC), 'a retired type that still holds days is shown').toBe(true);
    expect(self.has(w.types.AL)).toBe(true);
    for (const id of [w.types.EL, w.types.HID, w.types.ARC, w.types.AL]) expect(hr.has(id), 'HR’s screen is unchanged').toBe(true);
  });

  it('an ineligible type is absent for the employee (includeIneligible: false), present for HR', async () => {
    const w = await world();
    const INEL = await leaveTypeRow({ code: code('IN'), name: uniq('Ineligible') });
    // Profile eligibility (gender) — the identity half `includeIneligible` is about (d272834b).
    await owner.db.update(schema.leaveType).set({ eligibility: { gender: ['female'] } }).where(eqId(INEL));
    await owner.db.update(schema.person).set({ gender: 'male' }).where(eq(schema.person.id, w.aisyah.personId));
    await ledger(w.aisyah.employmentId, INEL, 2, `${Y}-01-01`);
    const self = byId(await employeeBalanceRows(w.aisyah.ctx, w.aisyah.employmentId, AS_OF_END, 'en', {}, { audience: 'self' }));
    const hr = byId(await employeeBalanceRows(adminCtx(b), w.aisyah.employmentId, AS_OF_END, 'en'));
    expect(hr.has(INEL), 'HR keeps seeing a balance under a type the employee is not eligible for').toBe(true);
    expect(self.has(INEL), 'the employee does not').toBe(false);
  });

  it('an ESS-hidden figure is null on the employee’s row, the Explain panel is withheld, and HR still sees the number', async () => {
    const w = await world();
    await owner.db.update(schema.leaveType).set({ essViewConfig: { taken: false } }).where(eqId(w.types.AL));
    const self = byId(await employeeBalanceRows(w.aisyah.ctx, w.aisyah.employmentId, AS_OF_END, 'en', {}, { audience: 'self' })).get(w.types.AL)!;
    const hr = byId(await employeeBalanceRows(adminCtx(b), w.aisyah.employmentId, AS_OF_END, 'en')).get(w.types.AL)!;
    expect(self.taken, 'Taken hidden').toBeNull();
    expect(self.share, 'Share is the same days seen from the pool — hidden with Taken').toBeNull();
    expect(self.balance, 'Balance needs Taken').toBeNull();
    expect(self.breakdown, 'no Explain panel that could be read for the hidden figure').toBeNull();
    expect(self.available, 'Available is still shown').toBe(hr.available);
    expect(hr.taken, 'HR’s figure is untouched').not.toBeNull();
    expect(hr.breakdown).not.toBeNull();
    // …and the page prints a dash where the number would be, never the number.
    sessionHolder.s = w.aisyah.ctx;
    const markup = JSON.stringify(await LeaveDetailsPage({ searchParams: Promise.resolve({ asOf: AS_OF_END }) }));
    expect(markup).toContain('leave-details-table');
  });

  it('selfView blanks each column under its own switch, and only that (all nine switches)', () => {
    const base: EmployeeBalanceRow = {
      leaveTypeId: 't', leaveType: 'T', code: 'T', entitlementYear: String(Y), cycleStart: `${Y}-01-01`, cycleEnd: `${Y}-12-31`,
      ytdEntitled: 1, fullEntitlement: 2, share: 3, pendingShare: 4, entitlementStatus: 'granted', entitlementTemplateName: 'Tbl',
      entitlementFromPool: null, sharedBalance: null, broughtForward: 5, taken: 6, pending: 7, adjustment: 8, overutilized: 9,
      forfeitedBf: 10, balance: 11, breakdown: { leaveTypeId: 't' } as never, available: 12, visual: { color: null, icon: null, code: null },
      hrExplanation: { sharedBalance: null, entitlementFromPool: null },
    };
    expect(selfView(base, {}), 'nothing hidden ⇒ HR’s row').toEqual(base);
    const blanked: Record<string, (keyof SelfBalanceRow)[]> = {
      eligible: ['fullEntitlement', 'entitlementTemplateName'],
      ytdEntitled: ['ytdEntitled'],
      broughtForward: ['broughtForward'],
      adjustment: ['adjustment'],
      total: [],
      taken: ['taken', 'share', 'balance'],
      pendingApproval: ['pending', 'pendingShare'],
      forfeited: ['forfeitedBf'],
      available: ['available', 'overutilized', 'pendingShare', 'balance'],
    };
    expect(Object.keys(blanked).sort()).toEqual([...ESS_VIEW_COMPONENT_KEYS].sort());
    for (const key of ESS_VIEW_COMPONENT_KEYS) {
      const v = selfView(base, { [key]: false });
      expect(v.breakdown, `${key} off ⇒ no Explain panel`).toBeNull();
      for (const f of Object.keys(base) as (keyof SelfBalanceRow)[]) {
        if (f === 'breakdown') continue;
        if (blanked[key]!.includes(f)) expect(v[f], `${key} off blanks ${f}`).toBeNull();
        else expect(v[f], `${key} off leaves ${f}`).toEqual(base[f as keyof EmployeeBalanceRow]);
      }
    }
  });
});

describe('r404 · 4. THE FILE IS THE SCREEN', () => {
  it('the workbook carries exactly the sixteen on-screen headings, in order, and the screen’s digits', async () => {
    const w = await world();
    sessionHolder.s = w.aisyah.ctx;
    const res = await exportGET(new Request(`http://t.local/leave/details/export?asOf=${AS_OF_END}`));
    const wb = XLSX.read(new Uint8Array(await res.arrayBuffer()), { type: 'array' });
    const grid = XLSX.utils.sheet_to_json<(string | number | null)[]>(wb.Sheets[wb.SheetNames[0]!]!, { header: 1, defval: null });
    const headings = LEAVE_DETAILS_COLUMNS.map((c) => dig(EN, `${c.ns}.${c.key}`));
    expect(LEAVE_DETAILS_COLUMNS).toHaveLength(16);
    expect(grid[0], 'the sixteen headings, in screen order').toEqual(headings);
    expect(headings, 'every heading resolves to a real string').not.toContain(undefined);
    // The page renders the same list.
    const tree = JSON.stringify(await LeaveDetailsPage({ searchParams: Promise.resolve({ asOf: AS_OF_END }) }));
    for (const h of headings) expect(tree, `the page prints "${h}"`).toContain(JSON.stringify(h));
    // Figures: the cell is the number formatDays prints on screen, an empty cell where the screen has "—".
    const rows = await employeeBalanceRows(w.aisyah.ctx, w.aisyah.employmentId, AS_OF_END, 'en', {}, { audience: 'self' });
    expect(grid.length - 1).toBe(rows.length);
    rows.forEach((r, i) => {
      LEAVE_DETAILS_FIGURES.forEach((k, j) => {
        const cell = grid[i + 1]![j + 2];
        const screen = formatDays(r[k]);
        if (screen === '—') expect(cell, `${r.code} ${k}`).toBeNull();
        else expect(Number(cell).toFixed(2), `${r.code} ${k}`).toBe(screen);
      });
      expect(grid[i + 1]![14], 'Date').toBe(AS_OF_END);
    });
  });

  it('the As-at rule is shared by page and file, and a non-date falls back to today', () => {
    expect(leaveDetailsAsOf('2024-02-29', '2026-01-01')).toBe('2024-02-29');
    expect(leaveDetailsAsOf('2025-02-29', TODAY), 'not a calendar day').toBe(TODAY);
    expect(leaveDetailsAsOf('31/12/2026', TODAY)).toBe(TODAY);
    expect(leaveDetailsAsOf(undefined, TODAY)).toBe(TODAY);
    expect(leaveDetailsAsOf(['2024-01-31'], TODAY)).toBe('2024-01-31');
    expect(leaveDetailsFilename('E-01/../x', '2026-01-31')).toBe('LeaveDetails_E-01x_2026-01-31');
    expect(leaveDetailsFilename(null, '2026-01-31')).toBe('LeaveDetails_employee_2026-01-31');
  });
});

describe('r404 · the Explain panel speaks to "you", in six languages', () => {
  it('every third-person explain sentence has a second-person twin, with the same placeholders, in every locale', () => {
    const explain = EN.leave.breakdown.explain as Record<string, string>;
    const thirdPerson = Object.entries(explain)
      .filter(([, v]) => /this employee|the employee|someone|\bthey\b|\bthem\b|\btheir\b/i.test(v))
      // "they add up" / "waiting on them" — pronouns for records and applications, not a person.
      .filter(([k]) => k !== 'itemsDoNotAddUp' && k !== 'availableFromBalancePool')
      .map(([k]) => k)
      .sort();
    expect(thirdPerson.length, 'non-vacuous').toBeGreaterThanOrEqual(5);
    expect([...SELF_VOICED_EXPLAIN_KEYS].sort(), 'the swap set is exactly the third-person sentences').toEqual(thirdPerson);
    const placeholders = (s: string) => [...s.matchAll(/\{(\w+)/g)].map((m) => m[1]).sort();
    for (const l of LOCALES) {
      const c = cat(l);
      for (const k of SELF_VOICED_EXPLAIN_KEYS) {
        const self = c.leave.breakdown.explainSelf?.[k];
        expect(typeof self, `${l} leave.breakdown.explainSelf.${k}`).toBe('string');
        expect(placeholders(self), `${l} ${k} keeps its placeholders`).toEqual(placeholders(c.leave.breakdown.explain[k]));
      }
      for (const k of ['title', 'description', 'viewOnly', 'searchLabel', 'searchPlaceholder', 'downloadExcel', 'footnote', 'noRows', 'noMatch', 'tableLabel', 'scrollHint'])
        expect(typeof c.leaveDetails?.[k], `${l} leaveDetails.${k}`).toBe('string');
      expect(typeof c.nav.leaveDetails, `${l} nav.leaveDetails`).toBe('string');
    }
    expect(EN.leave.breakdown.explainSelf.eligibleViaScheme).not.toMatch(/employee/i);
  });

  it('the page mounts the panel in the self voice with the Employee Leave View applied', () => {
    const page = codeOnly(read('app/leave/details/page.tsx'));
    const at = page.indexOf('<EntitlementBreakdown');
    expect(at, 'the panel is mounted').toBeGreaterThanOrEqual(0);
    const mount = page.slice(at, page.indexOf('/>', at));
    expect(mount.length).toBeGreaterThan(200);
    expect(mount).toContain('voice="self"');
    expect(mount).toContain('applyEssConfig');
    expect(mount).toContain('action="/leave/details"');
    const panel = codeOnly(read('components/leave/LeaveDetailsPanel.tsx'));
    expect(panel).toContain("voice === 'self' && SELF_VOICED_EXPLAIN_KEYS.has(s.key)");
    expect(panel).toContain('t(`explainSelf.${s.key}`');
  });
});

describe('r404 · HR’s audience is untouched', () => {
  it('the default audience is byte-identical to audience "hr"', async () => {
    const w = await world();
    for (const asOf of AS_OFS) {
      const a = await employeeBalanceRows(adminCtx(b), w.aisyah.employmentId, asOf, 'en');
      const c = await employeeBalanceRows(adminCtx(b), w.aisyah.employmentId, asOf, 'en', {}, { audience: 'hr' });
      expect(JSON.stringify(c)).toBe(JSON.stringify(a));
      expect(a.some((r) => r.leaveTypeId === w.types.EL), 'HR lists the hidden borrower').toBe(true);
      expect(a.some((r) => r.leaveTypeId === w.types.ZERO), 'and the all-zero type').toBe(true);
    }
  });
});

function eqId(id: string) {
  return eq(schema.leaveType.id, id);
}
