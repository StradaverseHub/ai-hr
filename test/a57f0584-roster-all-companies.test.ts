/**
 * a57f0584 — "I cannot immediately see the overall employee roster."
 *
 * THE REPORTED CAUSE WAS WRONG, AND THE PLAN SAID SO BEFORE THIS WAS BUILT. The ticket blamed the filters:
 * that the screen demanded choices before showing anything. It never did — `companyId` fell back to
 * `companies[0].id`, the month defaulted, and Business Unit and Department were always optional.
 *
 * THE REAL FAULT IS THE COMPANY. The screen showed ONE at a time. Measured on production: twelve company
 * rows, 75 active employments spread 31 / 15 / 5 / 4 / 4 / 3 / 2 / 1 across nine of them. So opening
 * Roster showed whichever company sorted first and about a third of the workforce, and the only way to
 * see the rest was to switch company eleven times.
 *
 * WHAT THIS PINS
 *   1. unchosen means EVERY authorised company, not the first one;
 *   2. every row says whose employee it is, because it now can be anyone's;
 *   3. choosing a company still narrows, exactly as before;
 *   4. ⚠️ THE AUTHORISED SET DOES NOT WIDEN BY ONE ROW. This changes what is ASKED FOR, never what is
 *      permitted — the screen's own company list is `listCompanies(s)` narrowed to `scopeIds`, and that
 *      is what feeds the read;
 *   5. the WRITE affordances still take one company, and say so rather than posting an empty field.
 */
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import * as schema from '../db/schema';
import { adminCtx, closeAll, migrateTestDb, owner, resetDb, seedBase, type Base } from './harness';
import { hireEmployee } from '../core/org';
import { rosterMonthView } from '../core/roster';

const ROOT = join(__dirname, '..');
const src = (p: string) =>
  readFileSync(join(ROOT, p), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^[ \t]*\/\/.*$/gm, '');
const PAGE = src('app/roster/page.tsx');
const EXPORT = src('app/roster/export/route.ts');
const GRID = src('components/roster-grid.tsx');

let b: Base;
let ctx: ReturnType<typeof adminCtx>;
const MONTH = '2026-08';

/** A SECOND company in the same tenant, with its own department — the shape the reporter actually has. */
async function secondCompany() {
  const [c] = await owner.db
    .insert(schema.company)
    .values({ tenantId: b.tenantId, legalName: 'Beta Sdn Bhd' })
    .returning({ id: schema.company.id });
  const [d] = await owner.db
    .insert(schema.department)
    .values({ tenantId: b.tenantId, companyId: c.id, name: 'Beta Ops' })
    .returning({ id: schema.department.id });
  return { companyId: c.id, departmentId: d.id };
}

async function hire(companyId: string, departmentId: string, fullName: string) {
  return hireEmployee(ctx, {
    person: { fullName, primaryEmail: `r57_${randomUUID().slice(0, 8)}@t.local` },
    companyId,
    departmentId,
    employmentType: 'full_time',
    hiredOn: '2020-01-01',
  });
}

beforeAll(async () => {
  await migrateTestDb();
});
afterAll(async () => {
  await closeAll();
});
beforeEach(async () => {
  await resetDb();
  b = await seedBase();
  ctx = adminCtx(b);
});

describe('a57f0584 · the roster spans companies', () => {
  it('returns every company asked for, with each row naming its own', async () => {
    const beta = await secondCompany();
    await hire(b.companyId, b.deptA, 'Alpha Person');
    await hire(beta.companyId, beta.departmentId, 'Beta Person');

    const view = await rosterMonthView(ctx, { companyIds: [b.companyId, beta.companyId], month: MONTH });
    const names = view.allEmployees.map((e) => e.name);
    expect(names).toEqual(expect.arrayContaining(['Alpha Person', 'Beta Person']));

    const betaRow = view.allEmployees.find((e) => e.name === 'Beta Person')!;
    expect(betaRow.companyId, 'a row must say whose employee it is').toBe(beta.companyId);
    expect(betaRow.company, 'and by name, because the column prints it').toBe('Beta Sdn Bhd');
  });

  /** THE OLD BEHAVIOUR, kept reachable: choosing a company still narrows to exactly that company. */
  it('one company asked for is one company returned', async () => {
    const beta = await secondCompany();
    await hire(b.companyId, b.deptA, 'Alpha Person');
    await hire(beta.companyId, beta.departmentId, 'Beta Person');

    const view = await rosterMonthView(ctx, { companyIds: [beta.companyId], month: MONTH });
    expect(view.allEmployees.map((e) => e.name)).toEqual(['Beta Person']);
  });

  /**
   * AN EMPTY ARRAY IS "EVERY COMPANY THIS SESSION MAY SEE", matching listEmployees' own contract for an
   * absent filter — NOT a request for nothing. Getting this backwards would show an empty roster to
   * everybody, which is the kind of thing that reads as "the screen is broken" rather than as a bug.
   */
  it('an empty company list means everyone, not no one', async () => {
    const beta = await secondCompany();
    await hire(b.companyId, b.deptA, 'Alpha Person');
    await hire(beta.companyId, beta.departmentId, 'Beta Person');

    const view = await rosterMonthView(ctx, { companyIds: [], month: MONTH });
    expect(view.allEmployees.length, 'both companies').toBeGreaterThanOrEqual(2);
  });

  it('the other filters still narrow across the widened set', async () => {
    const beta = await secondCompany();
    await hire(b.companyId, b.deptA, 'Alpha Person');
    await hire(beta.companyId, beta.departmentId, 'Beta Person');

    const both = [b.companyId, beta.companyId];
    expect(
      (await rosterMonthView(ctx, { companyIds: both, month: MONTH, departmentId: beta.departmentId }))
        .employees.map((e) => e.name),
    ).toEqual(['Beta Person']);
    expect(
      (await rosterMonthView(ctx, { companyIds: both, month: MONTH, q: 'alpha' })).employees.map((e) => e.name),
    ).toEqual(['Alpha Person']);
  });
});

describe('a57f0584 · what must NOT have widened', () => {
  /**
   * The read is fed from the screen's OWN company list, which is `listCompanies(s)` already narrowed to
   * `scopeIds`. Pinned on the source because the alternative — a page that derives the set from anywhere
   * else — is a scope leak that no fixture with one authorised admin would reveal.
   */
  it('the page feeds the read from the SCOPED company list, never from a wider one', () => {
    expect(PAGE).toContain('const companyIds = companyId ? [companyId] : companies.map((c) => c.id);');
    expect(PAGE, 'and that list is the scoped one').toContain(
      'const companies = (await listCompanies(s)).filter((c) => scopeIds.length === 0 || scopeIds.includes(c.id));',
    );
    // The old fallback must be gone, or the screen silently picks one company again.
    expect(PAGE, 'companies[0] was the whole fault').not.toContain('companies[0].id');
  });

  it('every dependent read takes the same set, so nothing narrows behind the grid', () => {
    for (const call of ['companyIds, today: todayIso', 'listToilPolicies(s, companyIds)', 'listDepartments(s, { companyIds })']) {
      expect(PAGE, `${call} must use the widened set`).toContain(call);
    }
  });

  /** The export re-reads the SAME view the screen renders — its own header says so — so it widens too, or
   *  the file disagrees with what was on screen when it was asked for. */
  it('the export spans the same companies as the screen', () => {
    expect(EXPORT).toContain('const companyIds = chosen ? [chosen.id] : inScope.map((c) => c.id);');
    expect(EXPORT, 'no first-company fallback here either').not.toContain('?? inScope[0]');
  });
});

describe('a57f0584 · the write affordances still take one company', () => {
  /**
   * generateRosterAction and copyRosterAction each write roster_assignment for a NAMED company, so neither
   * means anything across twelve. Rendering them with an empty hidden companyId would post '' and fail
   * inside the action, so the affordance is withdrawn and the reason given on screen.
   *
   * This is also what keeps the widening safe without pagination: the cross-company view is READ-ONLY, so
   * copy's "every employee on screen" hidden-input list can never silently span companies, and the
   * writable view holds exactly the rows it held before this change.
   */
  it('generate, copy and upload appear only once a company is chosen', () => {
    expect(PAGE.match(/\{admin && companyId && \(/g) ?? [], 'generate and copy').toHaveLength(2);
    expect(PAGE, 'and the upload link with them').toContain('{companyId && (');
    expect(PAGE, 'with a reason, not silence').toContain("t('pickCompanyToEdit')");
  });

  it('the switcher offers All, and it is the default', () => {
    expect(PAGE).toContain("defaultValue={companyId ?? ''}");
    expect(PAGE).toContain("<option value=\"\">{t('allCompanies')}</option>");
    expect(PAGE, 'unchosen resolves to null, not to a company').toContain(
      "? sp.companyId : null;",
    );
  });
});

describe('a57f0584 · the Company column earns its place', () => {
  it('is dropped from the sticky order entirely when one company is on screen', () => {
    // Not rendered empty — dropped, so every offset after it closes up. The grid derives left from width.
    expect(GRID).toContain("filter((k) => k !== 'company' || showCompany)");
    expect(GRID).toContain('const showCompany = employees.some((e) => (e.company ?? \'\') !== \'\');');
  });

  it('carries a width in the shared table, like every other pinned column', () => {
    expect(GRID).toMatch(/PINNED_W = \{[^}]*company: \d+/);
    for (const order of ['EDIT_ORDER', 'VIEW_ORDER']) {
      const line = GRID.slice(GRID.indexOf(`const ${order}`), GRID.indexOf('\n', GRID.indexOf(`const ${order}`)));
      expect(line, `${order} must place company`).toContain("'company'");
    }
  });

  it('the page only fills it when the roster actually spans companies', () => {
    expect(PAGE).toContain('company: showCompany ? e.company : null,');
    expect(PAGE).toContain('const showCompany = companyIds.length > 1;');
  });
});
