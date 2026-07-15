/**
 * ADR-0055 — org-based public-holiday override over the state engine (ADR-0038 2C). A holiday calendar can
 * be set at the BUSINESS-GROUP (company-subtree) level, on top of state and national. Resolution is
 * single-winner replacement: business-group → state → national. If ANY company-scoped row matches the
 * employee's company CHAIN (upward ancestor walk via app.is_company_descendant) in the window, those rows
 * ARE the calendar; otherwise the engine falls back to the unchanged 2C path (national ∪ effState).
 *
 * Window (reused from state-holidays.test.ts): Mon 2026-07-20 → Fri 2026-07-24 = 5 working days.
 *   - national holiday Tue 2026-07-21 (applies to everyone in the 2C fallback)
 *   - Sarawak holiday Wed 2026-07-22 (Sarawak only, 2C fallback)
 *   - GROUP holiday Thu 2026-07-23 (set on a parent company; single-winner replaces nat+state)
 */
import { eq } from 'drizzle-orm';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import * as schema from '../db/schema';
import { hireEmployee } from '../core/org';
import { requestLeave } from '../core/leave';
import { adminCtx, closeAll, migrateTestDb, owner, resetDb, seedBase, type Base } from './harness';

let b: Base;
let wdTypeId: string;

/** Create a company (optionally under a parent) plus a department in it, so hireEmployee's cross-company
 *  guard is satisfied. Returns the company + department ids. */
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
    person: { fullName: 'OH', primaryEmail: `oh_${randomUUID().slice(0, 8)}@t.local` },
    companyId,
    departmentId,
    employmentType: 'full_time',
    hiredOn: '2024-01-01',
  });
  if (workState) await owner.db.update(schema.employment).set({ workState }).where(eq(schema.employment.id, e.employmentId));
  return e;
};

const daysFor = async (employmentId: string) =>
  (await requestLeave(adminCtx(b), { employmentId, leaveTypeId: wdTypeId, startDate: '2026-07-20', endDate: '2026-07-24' })).days;

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
  const [lt] = await owner.db
    .insert(schema.leaveType)
    .values({ allowNegativeBalance: true, tenantId: b.tenantId, code: 'WD', name: 'Working-day leave', paid: true, counting: 'working_days' })
    .returning({ id: schema.leaveType.id });
  wdTypeId = lt.id;
  // Base 2C calendar: national Tue 21st + Sarawak Wed 22nd (companyId null).
  await owner.db.insert(schema.holiday).values([
    { tenantId: b.tenantId, country: 'MY', state: null, holidayDate: '2026-07-21', name: 'National Holiday' },
    { tenantId: b.tenantId, country: 'MY', state: 'Sarawak', holidayDate: '2026-07-22', name: 'Sarawak Day' },
  ]);
});
afterAll(async () => {
  await closeAll();
});

describe('ADR-0055 — org-based holiday override', () => {
  it('(a) group calendar wins over state + national for an employee in the scoped company', async () => {
    // Group holiday Thu 23rd set on the seedBase company itself. Single-winner replace → ONLY Thu 23rd
    // counts; the national (Tue) and Sarawak (Wed) rows are ignored even for a Sarawak employee.
    await owner.db.insert(schema.holiday).values(groupHoliday(b.companyId, '2026-07-23', 'Group Founders Day'));
    const [da] = await owner.db.select({ id: schema.department.id }).from(schema.department).where(eq(schema.department.id, b.deptA)).limit(1);
    const emp = await hireInto(b.companyId, da.id, 'Sarawak');
    expect(await daysFor(emp.employmentId)).toBe(4); // 5 − Thu only (NOT 3 = 5 − nat − Sarawak)
  });

  it('(b) parent-group calendar applies to a child-company employee (upward ancestor walk)', async () => {
    const child = await makeCompany('Acme Factory Sdn Bhd', b.companyId); // parent = seedBase company
    await owner.db.insert(schema.holiday).values(groupHoliday(b.companyId, '2026-07-23', 'Group Founders Day'));
    const emp = await hireInto(child.companyId, child.deptId);
    // The override is set on the PARENT; is_company_descendant(child, parent) is true → it cascades down.
    expect(await daysFor(emp.employmentId)).toBe(4); // 5 − Thu only
  });

  it('(c) a sibling subsidiary with no shared override falls back to state/national', async () => {
    const childA = await makeCompany('Acme Factory A', b.companyId);
    const childB = await makeCompany('Acme Factory B', b.companyId);
    // Override on child A only. Child B shares the parent but NOT child A's node → no match → 2C fallback.
    await owner.db.insert(schema.holiday).values(groupHoliday(childA.companyId, '2026-07-23', 'Factory A Day'));
    const empA = await hireInto(childA.companyId, childA.deptId);
    const empB = await hireInto(childB.companyId, childB.deptId);
    expect(await daysFor(empA.employmentId)).toBe(4); // group override: Thu only
    expect(await daysFor(empB.employmentId)).toBe(4); // 2C fallback: national only (Tue) = 5 − 1
  });

  it('(d) regression — no company rows: 2C numbers are byte-identical (Sarawak=3, Selangor=4)', async () => {
    // No company-scoped rows at all → the resolver is the unchanged 2C path.
    const [da] = await owner.db.select({ id: schema.department.id }).from(schema.department).where(eq(schema.department.id, b.deptA)).limit(1);
    const sarawak = await hireInto(b.companyId, da.id, 'Sarawak');
    const selangor = await hireInto(b.companyId, da.id, 'Selangor');
    expect(await daysFor(sarawak.employmentId)).toBe(3); // 5 − national − Sarawak
    expect(await daysFor(selangor.employmentId)).toBe(4); // 5 − national only
  });

  it('(e) multi-country regression — the resolver country-filter excludes the other country national holiday', async () => {
    // A second company in a different country (SG) with its own national holiday on Thu 23rd. A MY-company
    // employee must NOT have the SG holiday subtracted — the resolver filters by the company's country.
    const [sg] = await owner.db
      .insert(schema.company)
      .values({ tenantId: b.tenantId, legalName: 'Acme SG Pte Ltd', country: 'SG' })
      .returning({ id: schema.company.id });
    await owner.db.insert(schema.holiday).values({ tenantId: b.tenantId, country: 'SG', state: null, holidayDate: '2026-07-23', name: 'SG National' });
    const [da] = await owner.db.select({ id: schema.department.id }).from(schema.department).where(eq(schema.department.id, b.deptA)).limit(1);
    const myEmp = await hireInto(b.companyId, da.id, 'Selangor'); // MY company
    expect(await daysFor(myEmp.employmentId)).toBe(4); // 5 − MY national (Tue) only; SG Thu NOT counted
    expect(sg.id).toBeDefined();
  });

  it('(f) company-has-rows-but-no-match: a different subtree has rows → still falls back to national∪state', async () => {
    // Override exists in the tenant but for an UNRELATED company subtree. The employee's chain has no
    // company rows → the non-empty-set short-circuit must NOT fire; fall back to 2C.
    const other = await makeCompany('Unrelated Holdings'); // no shared ancestor with seedBase company
    await owner.db.insert(schema.holiday).values(groupHoliday(other.companyId, '2026-07-23', 'Other Group Day'));
    const [da] = await owner.db.select({ id: schema.department.id }).from(schema.department).where(eq(schema.department.id, b.deptA)).limit(1);
    const emp = await hireInto(b.companyId, da.id, 'Sarawak');
    expect(await daysFor(emp.employmentId)).toBe(3); // 2C fallback: 5 − national − Sarawak (Thu ignored)
  });

  it('(g) DB shape — widened unique index admits national+state+group on the SAME date; CHECK rejects multi-scope', async () => {
    // The widened holiday_uq is a strict SUPERSET of the old columns, so national + state + group rows can
    // coexist on the same date without collision (backfill-safe — proves the populated migration path).
    const date = '2026-08-31';
    await owner.db.insert(schema.holiday).values([
      { tenantId: b.tenantId, country: 'MY', state: null, companyId: null, holidayDate: date, name: 'Merdeka (national)' },
      { tenantId: b.tenantId, country: 'MY', state: 'Sarawak', companyId: null, holidayDate: date, name: 'Sarawak overlay' },
      groupHoliday(b.companyId, date, 'Group overlay'),
    ]);
    const rows = await owner.db
      .select({ id: schema.holiday.id })
      .from(schema.holiday)
      .where(eq(schema.holiday.holidayDate, date));
    expect(rows.length).toBe(3); // all three scopes accepted on one date
    // The CHECK holiday_scope_excl makes scope mutually exclusive at the DB — a state-AND-company row throws.
    await expect(
      owner.db.insert(schema.holiday).values({
        tenantId: b.tenantId,
        country: 'MY',
        state: 'Selangor',
        companyId: b.companyId,
        holidayDate: '2026-09-16',
        name: 'Illegal multi-scope',
      }),
    ).rejects.toThrow();
  });
});

describe('ADR-0055 — i18n scope keys present in all 6 locales (4.3)', () => {
  // The coverage test does not catch present-but-English or verify ICU template parity; assert the 3
  // static scope keys + the ICU badge template exist in every locale so a dynamic-key escape can't slip in.
  const LOCALES = ['en', 'ms', 'ta', 'th', 'vi', 'zh'] as const;
  const read = (loc: string) =>
    JSON.parse(fs.readFileSync(path.resolve(__dirname, '..', 'messages', `${loc}.json`), 'utf8'));

  for (const loc of LOCALES) {
    it(`${loc}: scope.national/state/group + scopeBadge ICU template exist`, () => {
      const h = read(loc)?.admin?.holidays;
      expect(h?.scope?.national, `${loc} scope.national`).toBeTruthy();
      expect(h?.scope?.state, `${loc} scope.state`).toBeTruthy();
      expect(h?.scope?.group, `${loc} scope.group`).toBeTruthy();
      // ICU template parity: must contain both {label} and {name} placeholders.
      expect(String(h?.scopeBadge ?? ''), `${loc} scopeBadge`).toContain('{label}');
      expect(String(h?.scopeBadge ?? ''), `${loc} scopeBadge`).toContain('{name}');
    });
  }
});
