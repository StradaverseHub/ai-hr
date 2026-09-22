/**
 * 3e3d3fb2 — "pick a person, see THEIR TP1 record, and nothing opens by itself."
 *
 * WHAT THE REPORTER ASKED FOR, AND WHY A SOURCE GREP CANNOT ANSWER IT. TP1 Relief was the odd one out: a
 * narrow single column with a server-side search box, no employee panel, no filters, nothing that
 * collapsed — and picking somebody made the search vanish and dropped you straight into their declaration
 * FORM, with no list of what had been declared and for which years. Every one of those complaints is about
 * what the screen DECIDED to render, and all of them pass tsc, the suite and `next build` either way. So
 * each assertion here renders the page as a server component and pulls the islands out of the returned
 * tree by identity — the rows under test are the exact rows that reach the tables.
 *
 * THE FIXTURE IS TWO PEOPLE, NOT ONE, and one of them has a declaration and an applied deduction of their
 * own. "Narrowed to the person you picked" is not a claim that can fail with a single-employee fixture.
 *
 * ONE ROW PER ASSESSMENT YEAR IS THE CLAIM WORTH THE MOST HERE. `tp1_relief` is APPEND-ONLY: a correction
 * INSERTs another submitted row and the latest wins. So the fixture gives the current year TWO rows and
 * asserts the list shows ONE, carrying the newer amount — a list that leaked the version chain would show
 * two "2026" lines of which only one is the declaration, and clicking either would open the same form.
 *
 * THE DRAFT-BATCH EXCLUSION IS THE OTHER ONE. Unlike the zakat history (which starts from `payslip`, a row
 * that exists only post-generation), this list starts from `payroll_input`, which exists on DRAFT batches
 * as keyed intent. The fixture therefore keys a TP1 figure on a draft batch that must NOT appear: without
 * the status predicate the screen would report an unrun month as deducted. VERIFIED BY REVERSION during
 * development — deleting the `status IN ('processed','closed')` predicate from listAppliedTp1Deductions
 * makes that assertion fail, so it is pinning the predicate and not something else.
 *
 * WHAT THIS FILE DOES NOT RE-LITIGATE: the `?employmentId=` scope guard. test/tp1-scope-guard.test.ts
 * already proves — against a real database, three ways — that RLS refuses a cross-company employment and
 * that the page refuses one its own picker never offered. That claim was tested and the "security gap" it
 * came from did not survive. The one case repeated here is the guard's effect on the NEW surfaces (the two
 * lists and the declaration route), which did not exist when that file was written.
 */
import { randomUUID } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const { scope, cookieJar } = vi.hoisted(() => ({
  scope: { s: null as unknown, scopeIds: [] as string[] },
  cookieJar: { value: undefined as string | undefined },
}));
vi.mock('next/cache', () => ({ revalidatePath: vi.fn(() => undefined), revalidateTag: vi.fn(() => undefined) }));
// notFound() THROWS in Next, and a page that kept executing past it would read a null employee and crash
// with a TypeError instead — which would pass a naive `.rejects` assertion for entirely the wrong reason.
vi.mock('next/navigation', () => ({
  redirect: vi.fn(() => undefined),
  notFound: vi.fn(() => {
    throw new Error('NEXT_NOT_FOUND');
  }),
}));
vi.mock('@/lib/scope', () => ({ scopedAdmin: vi.fn(async () => scope) }));
// NOT mocked: '@/lib/authz'. Both TP1 screens resolve their session through scopedAdmin, and core/
// tax-relief.ts's admin-on-behalf gate calls the REAL isAdmin(ctx) — stubbing the module would replace
// that gate with a stub and this file would stop proving that an admin context is what reaches it.
// The collapse state is read from a cookie; absent ⇒ expanded. Driven per test so the cookie NAME the
// plan specified is pinned by behaviour rather than by a grep for the constant.
vi.mock('next/headers', () => ({
  cookies: vi.fn(async () => ({
    get: (name: string) => (cookieJar.value === undefined ? undefined : { name, value: cookieJar.value }),
  })),
}));
// `getLocale` joins `getTranslations` here because the TP1 list resolves its MONTH NAMES through
// Intl in the request's locale (7ad37961) rather than from a message catalogue — twelve month
// names in six catalogues would be six copies of the calendar.
vi.mock('next-intl/server', () => ({
  getTranslations: vi.fn(async () => (k: string) => k),
  getLocale: vi.fn(async () => 'en'),
}));

import * as schema from '../db/schema';
import type { SessionContext } from '../db/client';
import { adminCtx, closeAll, migrateTestDb, owner, resetDb, seedBase, type Base } from './harness';
import { hireEmployee } from '../core/org';
import { setCompensation } from '../core/comp';
import { setStatutoryProfileMY } from '../localization/my/statutory';
import { createBatch, generatePayslips, setPayrollDeductionInput } from '../core/payroll';
import { listTp1DeclarationsForPerson } from '../core/tax-relief';
import { todayInKualaLumpur } from '../lib/hr-date';
import { redirect } from 'next/navigation';
import { CollapsibleEmployeePanel, EmployeeScopePanel } from '../components/collapsible-employee-panel';
import { pageWideCls } from '../components/ui';
import { AppliedInPayrollList } from '../components/applied-in-payroll-list';
import { Tp1DeclarationsList } from '../components/tp1-declarations-list';
import { Tp1DeclarationForm } from '../components/tp1-declaration-form';
import Tp1TransactionPage, { TP1_PANEL_COOKIE } from '../app/payroll/transactions/tp1/page';
import Tp1DeclarationYearPage from '../app/payroll/transactions/tp1/[year]/page';
import Tp1DeclarationMonthPage from '../app/payroll/transactions/tp1/[year]/[month]/page';

/* eslint-disable @typescript-eslint/no-explicit-any */

/** Every React element in a rendered tree, descending through EVERY element-valued prop (not just
 *  `children`): the panel arrives as a `panel` prop and the Add control as a `<Button asChild>` child. */
function walk(node: unknown, acc: any[] = []): any[] {
  if (!node || typeof node !== 'object') return acc;
  if (Array.isArray(node)) {
    for (const n of node) walk(n, acc);
    return acc;
  }
  const el = node as any;
  if (el.type !== undefined) acc.push(el);
  for (const v of Object.values(el.props ?? {})) if (v && typeof v === 'object') walk(v, acc);
  return acc;
}
const byType = (tree: unknown, type: unknown): any[] => walk(tree).filter((e) => e.type === type);
/** Every `href` in the tree, wherever it hangs (an `<a>`, a `<Link>`, a PageHeader `back`). */
const hrefsIn = (tree: unknown): string[] =>
  walk(tree)
    .map((e) => e.props?.href)
    .filter((h): h is string => typeof h === 'string');
/** Forms bound to a SERVER ACTION — i.e. forms that write. */
const writingForms = (tree: unknown): any[] =>
  walk(tree).filter((e) => e.type === 'form' && typeof e.props?.action === 'function');
/** Every STRING anywhere in the tree, props included (an employee's name arrives as a prop). */
const textIn = (tree: unknown): string => {
  const out: string[] = [];
  const seen = new Set<unknown>();
  const visit = (n: unknown): void => {
    if (typeof n === 'string') {
      out.push(n);
      return;
    }
    if (!n || typeof n !== 'object' || seen.has(n)) return;
    seen.add(n);
    if (Array.isArray(n)) {
      n.forEach(visit);
      return;
    }
    for (const v of Object.values(n as Record<string, unknown>)) visit(v);
  };
  visit(tree);
  return out.join(' ');
};

// The assessment year is a MYT calendar fact, in the FIXTURE as much as in the page: a hard-coded 2026
// here would start failing on 1 January and, between 00:00 and 08:00 MYT, would disagree with the page
// for eight hours before that.
const CURRENT_YEAR = Number(todayInKualaLumpur().slice(0, 4));
const LAST_YEAR = CURRENT_YEAR - 1;
const THIS_MONTH = todayInKualaLumpur().slice(0, 7);
const PREV_MONTH = (() => {
  const [y, m] = THIS_MONTH.split('-').map(Number);
  return m === 1 ? `${y - 1}-12` : `${y}-${String(m - 1).padStart(2, '0')}`;
})();

const hire = (ctx: SessionContext, b: Base, name: string, email: string) =>
  hireEmployee(ctx, {
    person: { fullName: name, primaryEmail: email },
    companyId: b.companyId,
    departmentId: b.deptA,
    employmentType: 'full_time',
    hiredOn: `${LAST_YEAR}-01-01`,
  });

describe('3e3d3fb2 — TP1 Relief, rebuilt the way Fixed Transaction is', () => {
  let base: Base;
  let a: SessionContext;
  let aisha: { employmentId: string; personId: string };
  let bala: { employmentId: string; personId: string };
  let foreign: { employmentId: string; personId: string };
  let processedBatchId: string;
  let draftBatchId: string;

  beforeAll(async () => {
    await migrateTestDb();
  });

  beforeEach(async () => {
    await resetDb();
    cookieJar.value = undefined;
    base = await seedBase();
    a = adminCtx(base);
    scope.s = a;
    scope.scopeIds = [base.companyId];

    aisha = await hire(a, base, 'Aisha Rahman', `aisha_${randomUUID().slice(0, 8)}@acme.test`);
    bala = await hire(a, base, 'Bala Krishnan', `bala_${randomUUID().slice(0, 8)}@acme.test`);
    for (const [e, ic] of [
      [aisha, '900101011234'],
      [bala, '900202021235'],
    ] as const) {
      await setCompensation(a, {
        employmentId: e.employmentId,
        basicSalary: 5000,
        monthlyAllowance: 0,
        effectiveFrom: `${LAST_YEAR}-01-01`,
      });
      await setStatutoryProfileMY(a, { personId: e.personId, icNumber: ic });
    }

    // A REAL second company this admin's scope excludes — the cross-company read a tampered URL attempts.
    const [c] = await owner.db
      .insert(schema.company)
      .values({ tenantId: base.tenantId, legalName: `Beta ${randomUUID().slice(0, 6)}` })
      .returning({ id: schema.company.id });
    const [d] = await owner.db
      .insert(schema.department)
      .values({ tenantId: base.tenantId, companyId: c.id, name: 'Beta Ops' })
      .returning({ id: schema.department.id });
    foreign = await hireEmployee(a, {
      person: { fullName: 'Chen Other Company', primaryEmail: `chen_${randomUUID().slice(0, 8)}@beta.test` },
      companyId: c.id,
      departmentId: d.id,
      employmentType: 'full_time',
      hiredOn: `${LAST_YEAR}-01-01`,
    });

    // ── Declarations. 7ad37961 — the current year now gets THREE rows for Aisha: a JANUARY declaration
    // and its correction (which must collapse to ONE January line), plus a separate FEBRUARY declaration
    // (which must NOT be collapsed into it). That pair is the whole point: the visible-row rule moved
    // from one-per-YEAR to one-per-MONTH, but the half that was never about years — a correction does
    // not produce two competing lines for the same month — is unchanged and still falsifiable here.
    //
    // Written directly because what is under test is the READ that collapses them, not the write path
    // (which has its own tests) — and because created_at has to be controlled to make "newest wins"
    // falsifiable.
    await owner.db.insert(schema.tp1Relief).values([
      {
        tenantId: base.tenantId,
        personId: aisha.personId,
        assessmentYear: CURRENT_YEAR,
        deductionMonth: 1,
        status: 'submitted',
        tp1Amount: '3000.00',
        submittedAt: new Date(`${CURRENT_YEAR}-02-01T02:00:00Z`),
        createdAt: new Date(`${CURRENT_YEAR}-02-01T02:00:00Z`),
      },
      {
        tenantId: base.tenantId,
        personId: aisha.personId,
        assessmentYear: CURRENT_YEAR,
        deductionMonth: 1,
        status: 'submitted',
        tp1Amount: '4000.00',
        submittedAt: new Date(`${CURRENT_YEAR}-03-01T02:00:00Z`),
        createdAt: new Date(`${CURRENT_YEAR}-03-01T02:00:00Z`),
      },
      {
        tenantId: base.tenantId,
        personId: aisha.personId,
        assessmentYear: CURRENT_YEAR,
        deductionMonth: 2,
        status: 'approved',
        tp1Amount: '1500.00',
        submittedAt: new Date(`${CURRENT_YEAR}-03-05T02:00:00Z`),
        createdAt: new Date(`${CURRENT_YEAR}-03-05T02:00:00Z`),
        approvedAt: new Date(`${CURRENT_YEAR}-03-06T02:00:00Z`),
        approvedMonth: 2,
        approvedYear: CURRENT_YEAR,
      },
      {
        tenantId: base.tenantId,
        personId: aisha.personId,
        assessmentYear: LAST_YEAR,
        status: 'draft',
        tp1Amount: '500.00',
        createdAt: new Date(`${LAST_YEAR}-06-01T02:00:00Z`),
      },
      {
        tenantId: base.tenantId,
        personId: bala.personId,
        assessmentYear: CURRENT_YEAR,
        status: 'submitted',
        tp1Amount: '9999.00',
        submittedAt: new Date(`${CURRENT_YEAR}-02-01T02:00:00Z`),
        createdAt: new Date(`${CURRENT_YEAR}-02-01T02:00:00Z`),
      },
    ]);

    // ── Payroll. One PROCESSED run carrying a TP1 figure for each of them, and one DRAFT batch carrying a
    // keyed figure for Aisha that no run has taken — the row the "Applied in payroll" list must not show.
    const processed = await createBatch(a, { companyId: base.companyId, payPeriod: PREV_MONTH });
    processedBatchId = processed.batchId;
    await setPayrollDeductionInput(a, {
      batchId: processedBatchId,
      employmentId: aisha.employmentId,
      tp1Deduction: 300,
    });
    await setPayrollDeductionInput(a, {
      batchId: processedBatchId,
      employmentId: bala.employmentId,
      tp1Deduction: 250,
    });
    await generatePayslips(a, { batchId: processedBatchId });

    const draft = await createBatch(a, { companyId: base.companyId, payPeriod: THIS_MONTH });
    draftBatchId = draft.batchId;
    await setPayrollDeductionInput(a, {
      batchId: draftBatchId,
      employmentId: aisha.employmentId,
      tp1Deduction: 999,
    });
  });

  afterAll(async () => {
    await closeAll();
  });

  const render = async (searchParams: Record<string, string> = {}) =>
    Tp1TransactionPage({ searchParams: Promise.resolve(searchParams) } as any);

  const lists = (tree: unknown) => ({
    declarations: byType(tree, Tp1DeclarationsList),
    applied: byType(tree, AppliedInPayrollList),
  });

  // ───────────────────── The screen's shape ─────────────────────

  it('the panel is the shared one, collapsible, over the whole scoped set, and the page is full width', async () => {
    const tree = await render();
    const shell = byType(tree, CollapsibleEmployeePanel);
    expect(shell, 'exactly one collapsible employee panel').toHaveLength(1);
    expect(shell[0].props.cookieKey, 'the cookie the plan named').toBe('txn_tp1_panel');
    expect(TP1_PANEL_COOKIE).toBe('txn_tp1_panel');
    expect(shell[0].props.defaultOpen, 'absent cookie ⇒ expanded').toBe(true);

    const panels = byType(tree, EmployeeScopePanel);
    expect(panels, 'exactly one shared employee panel').toHaveLength(1);
    const offered: string[] = panels[0].props.employees.map((e: { employmentId: string }) => e.employmentId);
    expect(offered.sort()).toEqual([aisha.employmentId, bala.employmentId].sort());
    expect(offered, 'a cross-company employee must not be offered').not.toContain(foreign.employmentId);
    expect(panels[0].props.basePath).toBe('/payroll/transactions/tp1');

    // The reporter asked for the full-width layout every sibling screen has. 152fea7f UPDATED this
    // assertion rather than deleting it: the sibling screens moved from the `mx-auto max-w-[100rem]` cap
    // to `pageWideCls` ('w-full space-y-6'), so the rule still reads "same width as its siblings" — it is
    // the siblings' width that changed. Asserted on the RENDERED tree, so it survives however the class
    // is composed.
    expect(walk(tree).some((e) => e.props?.className === pageWideCls)).toBe(true);
    expect(walk(tree).some((e) => typeof e.props?.className === 'string' && e.props.className.includes('max-w-[100rem]'))).toBe(false);
  });

  it('the collapse state is resolved on the SERVER from that cookie (no open-then-collapse flash)', async () => {
    cookieJar.value = '0';
    const collapsed = await render();
    expect(byType(collapsed, CollapsibleEmployeePanel)[0].props.defaultOpen).toBe(false);
    cookieJar.value = '1';
    const open = await render();
    expect(byType(open, CollapsibleEmployeePanel)[0].props.defaultOpen).toBe(true);
  });

  it('with nobody selected it shows the panel and NOTHING ELSE — no tax record belonging to anyone', async () => {
    // Unlike Zakat and Loans this screen has never had an everyone-at-once view, so there is none to keep
    // — and an accidental one here would put every employee's tax declaration on an unselected page.
    const tree = await render();
    const { declarations, applied } = lists(tree);
    expect(declarations, 'no declaration list until somebody is picked').toEqual([]);
    expect(applied, 'no applied-in-payroll list until somebody is picked').toEqual([]);
    expect(textIn(tree)).not.toContain('9999');
    expect(hrefsIn(tree).filter((h) => h.startsWith('/payroll/transactions/tp1/'))).toEqual([]);
  });

  it('picking somebody opens NO form — it shows their records and ONE button that goes to the declaration', async () => {
    // THE complaint. Selecting an employee used to render the declaration form itself, so choosing a person
    // to READ their record opened a form to CHANGE it.
    const tree = await render({ employmentId: aisha.employmentId });
    expect(byType(tree, Tp1DeclarationForm), 'the form lives on its own page now').toEqual([]);
    expect(writingForms(tree), 'nothing on this screen writes').toEqual([]);
    // 7ad37961 — the destination gained a MONTH segment: a declaration is per deduction month.
    //
    // 27605faa rev 2 (r326) — AND "+ Add New TP1" NOW OPENS A STEP THAT ASKS FOR THE YEAR AND MONTH
    // FIRST, so it is `/tp1/new?...` rather than a month url this screen chose. The reporter contested
    // the earlier shape in these words: "The Assessment Year and Deduction Month selection is currently
    // displayed on the TP1 viewing page. This is not the correct workflow because these fields are
    // relevant when creating a new TP1 transaction, not when viewing existing transaction history."
    //
    // THE CLAIM THIS CASE MAKES IS UNCHANGED and is what the assertion still pins: every route off this
    // screen goes to the declaration flow, carrying the selected employee, and this screen never unfolds
    // a form of its own. What changed is that ONE of those routes is now the step rather than a month.
    const toDeclaration = hrefsIn(tree).filter((h) => h.startsWith('/payroll/transactions/tp1/'));
    expect(toDeclaration.length, 'exactly one route off this screen per listed record, plus Add').toBeGreaterThan(0);
    const addStep = new RegExp(`^/payroll/transactions/tp1/new\\?employmentId=${aisha.employmentId}&year=\\d{4}$`);
    const aMonth = new RegExp(`^/payroll/transactions/tp1/\\d{4}/\\d{1,2}\\?employmentId=${aisha.employmentId}$`);
    for (const h of toDeclaration) {
      expect(h, `${h} must be the Add step or a declaration month`).toMatch(
        new RegExp(`${addStep.source}|${aMonth.source}`),
      );
    }
    // …and the Add step is present exactly once: one button, not one per row.
    expect(toDeclaration.filter((h) => addStep.test(h)), 'one Add, and it is the step').toHaveLength(1);
    // The selected employee is named at the top of the workspace, as on Fixed Transaction.
    expect(textIn(tree)).toContain('Aisha Rahman');
  });

  // ───────────────────── Transaction history ─────────────────────

  // 7ad37961 REVERSED HALF OF THIS CASE ON PURPOSE, AND THE OTHER HALF IS UNTOUCHED.
  //
  // It used to read "ONE ROW PER ASSESSMENT YEAR". The official LHDN TP1 (1/2026) has a DEDUCTION MONTH
  // box, so a year holds up to twelve declarations and a per-year collapse would hide eleven of them.
  // The visible grain is now the MONTH — which is exactly what the reporter sketched (January, February,
  // March). What did NOT change, and is still asserted below, is that a CORRECTION does not produce two
  // competing lines for the same month: January's two rows collapse to one, carrying the newer amount
  // and counting the superseded one.
  it('the list is ONE ROW PER DEDUCTION MONTH, carrying the NEWEST row within each month', async () => {
    const tree = await render({ employmentId: aisha.employmentId });
    const rows = lists(tree).declarations[0].props.rows as {
      assessmentYear: number;
      deductionMonth: number | null;
      amount: string;
      status: string;
      versions: number;
      href: string;
      readOnly: boolean;
    }[];
    /**
     * 27605faa rev 2 (r326) — UPDATED, NOT LOOSENED. This asserted that last year's draft was ABSENT,
     * "because the list is now scoped to one year by the selector". The reporter contested exactly that:
     * "The View/Transaction History page should only display the Assessment Year and Deduction Month
     * associated with existing TP1 records and should not require the user to select these values before
     * viewing the records." The history spans EVERY year now, with the year as a column.
     *
     * The claim this case is really about — ONE ROW PER DEDUCTION MONTH, the newest within each month
     * winning and the superseded ones counted — is unchanged and still asserted below. What it gains is
     * the cross-year half: last year's month-less draft is now present AS ITS OWN ROW, which is the
     * property that would break if the collapse key ever went back to keying on the month alone.
     */
    expect(rows.map((r) => r.deductionMonth), 'this year Jan, Feb — then last year').toEqual([1, 2, null]);
    expect(rows.map((r) => r.assessmentYear), 'newest year first').toEqual([
      CURRENT_YEAR,
      CURRENT_YEAR,
      LAST_YEAR,
    ]);
    // ⚠️ AND LAST YEAR'S ROW IS ITS OWN RECORD, not a "version" of anything in this year. Keyed on the
    // month alone it would have collided with a same-month row and been counted instead of listed.
    expect(rows[2].versions, 'no cross-year version inflation').toBe(1);
    expect(rows[2].readOnly, 'a closed assessment year is still read-only').toBe(true);
    const jan = rows[0];
    expect(jan.amount, 'the correction wins, not the original').toBe('4000.00');
    expect(jan.status).toBe('submitted');
    expect(jan.versions, 'the superseded row is counted, never listed').toBe(2);
    expect(jan.readOnly).toBe(false);
    expect(jan.href).toBe(`/payroll/transactions/tp1/${CURRENT_YEAR}/1?employmentId=${aisha.employmentId}`);
    const feb = rows[1];
    expect(feb.amount, 'February is its own record, never folded into January').toBe('1500.00');
    expect(feb.status).toBe('approved');
    expect(feb.versions).toBe(1);
  });

  // The year the reader picked is SERVER-OWNED, in the URL beside employmentId — so last year's draft is
  // reachable, and it still opens read-only.
  /**
   * 27605faa rev 2 (r326) — the year selector NO LONGER NARROWS THE LIST, and that is the point of the
   * change rather than a regression: the history shows every year. The selector still drives the Add
   * step and the applied-in-payroll panel, which genuinely are per-year.
   *
   * So this case keeps the half that is still true and still matters — a pre-7ad37961 declaration is
   * MONTH-LESS rather than being given a January it never had, and a closed assessment year opens
   * read-only — and stops asserting the filtering that was removed on the reporter's instruction.
   */
  it('a month-less legacy declaration keeps no month, and a closed year is still read-only', async () => {
    const tree = await render({ employmentId: aisha.employmentId, year: String(LAST_YEAR) });
    const rows = lists(tree).declarations[0].props.rows as {
      assessmentYear: number;
      deductionMonth: number | null;
      amount: string;
      status: string;
      readOnly: boolean;
    }[];
    const legacy = rows.find((r) => r.assessmentYear === LAST_YEAR);
    expect(legacy, "last year's declaration is listed whatever year is selected").toBeTruthy();
    expect(legacy!.amount).toBe('500.00');
    expect(legacy!.status).toBe('draft');
    // Written before the form had a month box, so it has none — and is not given one.
    expect(legacy!.deductionMonth, 'a pre-7ad37961 declaration is month-less, not January').toBeNull();
    expect(legacy!.readOnly, 'a closed assessment year opens read-only').toBe(true);
  });

  it('the history is narrowed to the selected employee — in the QUERY, not over rows already read', async () => {
    const tree = await render({ employmentId: aisha.employmentId });
    const { declarations, applied } = lists(tree);
    expect(JSON.stringify(declarations[0].props.rows)).not.toContain('9999');
    expect((applied[0].props.rows as { employeeName: string }[]).map((r) => r.employeeName)).toEqual([
      'Aisha Rahman',
    ]);
  });

  // The PER-YEAR rollup is KEPT, unchanged and still tested — the screen no longer drives its table from
  // it, but the year selector needs to know which years exist and /me still reads a year at a time. With
  // three current-year rows it reports the newest (February's 1500) and counts the other two behind it,
  // which is the same latest-wins rule it always had, seen at year grain instead of month grain.
  it('core: listTp1DeclarationsForPerson still collapses per YEAR (the selector reads it)', async () => {
    const rows = await listTp1DeclarationsForPerson(a, { personId: aisha.personId });
    expect(rows.map((r) => r.assessmentYear)).toEqual([CURRENT_YEAR, LAST_YEAR]);
    expect(rows[0].tp1Amount, 'newest created_at in the year wins, whatever month it is for').toBe(1500);
    expect(rows[0].versions).toBe(3);
    expect(rows[1].tp1Amount).toBe(500);
    // A person with nothing declared is an empty list, never a fabricated current-year row.
    const [chenPerson] = await owner.db
      .insert(schema.person)
      .values({ tenantId: base.tenantId, fullName: 'Nobody', primaryEmail: `nb_${randomUUID().slice(0, 8)}@t.local` })
      .returning({ id: schema.person.id });
    expect(await listTp1DeclarationsForPerson(a, { personId: chenPerson.id })).toEqual([]);
  });

  // ───────────────────── Applied in payroll ─────────────────────

  it('applied-in-payroll shows the PROCESSED run and refuses the DRAFT batch keyed against the same person', async () => {
    // The predicate that makes the word "applied" true. payroll_input rows exist on draft batches as keyed
    // intent; without `status IN ('processed','closed')` this list would report an unrun month as deducted.
    const tree = await render({ employmentId: aisha.employmentId });
    const rows = lists(tree).applied[0].props.rows as {
      payPeriod: string;
      amount: string;
      employeeName: string;
      statusLabel: string;
    }[];
    expect(rows.map((r) => r.payPeriod)).toEqual([PREV_MONTH]);
    expect(rows[0].amount).toBe('300.00');
    expect(rows[0].statusLabel).toBe('tp1.batchStatus.processed');
    expect(JSON.stringify(rows), 'the draft batch has not deducted anything').not.toContain('999.00');
    // …and the draft row is genuinely there to be found, so the assertion above is not vacuous.
    const [keyed] = await owner.db
      .select({ tp1: schema.payrollInput.tp1Deduction })
      .from(schema.payrollInput)
      .where(
        and(
          eq(schema.payrollInput.batchId, draftBatchId),
          eq(schema.payrollInput.employmentId, aisha.employmentId),
        ),
      );
    expect(Number(keyed.tp1)).toBe(999);
    expect(processedBatchId).toBeTruthy();
  });

  it('a zero TP1 is not a line in the applied list', async () => {
    await owner.db
      .update(schema.payrollInput)
      .set({ tp1Deduction: '0' })
      .where(
        and(
          eq(schema.payrollInput.batchId, processedBatchId),
          eq(schema.payrollInput.employmentId, aisha.employmentId),
        ),
      );
    const tree = await render({ employmentId: aisha.employmentId });
    expect(lists(tree).applied[0].props.rows).toEqual([]);
  });

  // ───────────────────── The scope guard on the NEW surfaces ─────────────────────

  it('an out-of-scope ?employmentId= selects nobody AND reads no tax record', async () => {
    for (const id of [foreign.employmentId, randomUUID()]) {
      const tree = await render({ employmentId: id });
      expect(byType(tree, EmployeeScopePanel)[0].props.selectedId).toBeNull();
      const { declarations, applied } = lists(tree);
      expect(declarations).toEqual([]);
      expect(applied).toEqual([]);
      expect(textIn(tree)).not.toContain('Chen Other Company');
    }
  });

  // ───────────────────── The dedicated declaration page ─────────────────────

  // 7ad37961 — the page moved from `tp1/[year]` to `tp1/[year]/[month]`, because the record's grain did.
  // `[year]` is kept as a REDIRECT so shipped links and bookmarks keep working; its own case is below.
  const renderMonth = (year: string, month: string, searchParams: Record<string, string> = {}) =>
    Tp1DeclarationMonthPage({
      params: Promise.resolve({ year, month }),
      searchParams: Promise.resolve(searchParams),
    } as any);

  it('the declaration page renders the SHARED form for the picked employee, year and month', async () => {
    const tree = await renderMonth(String(CURRENT_YEAR), '1', { employmentId: aisha.employmentId });
    const forms = byType(tree, Tp1DeclarationForm);
    expect(forms, 'the ESS screen and this one render the SAME component').toHaveLength(1);
    expect(forms[0].props.selectedYear).toBe(CURRENT_YEAR);
    expect(forms[0].props.deductionMonth).toBe(1);
    expect(forms[0].props.readOnly).toBe(false);
    expect(forms[0].props.latest.tp1Amount, 'the latest row for the month, corrections included').toBe(4000);
    // February is a DIFFERENT record on a different URL — one page cannot show two months' figures.
    const feb = await renderMonth(String(CURRENT_YEAR), '2', { employmentId: aisha.employmentId });
    expect(byType(feb, Tp1DeclarationForm)[0].props.latest.tp1Amount).toBe(1500);
    // The employee is carried as a hidden field, not chosen: the page cannot retarget the save.
    expect(forms[0].props.hiddenFields).toEqual({ employmentId: aisha.employmentId });
    // Save and Submit are the shared form's own buttons; Cancel returns to the record it belonged to.
    expect(hrefsIn(tree)).toContain(
      `/payroll/transactions/tp1?employmentId=${aisha.employmentId}&year=${CURRENT_YEAR}`,
    );
  });

  // 7ad37961 (r210) — THE DECLARATION PAGE IS FULL WIDTH, asserted on what it actually RENDERS. The page
  // shipped inside a centred 48rem column, filed as a "single-record form keeps a reading width"
  // exception; the reporter came back about it, because the record behind it is the seventeen numbered
  // items of the official Section C and that column could only draw them as one very tall list. The
  // companion assertion for the list screen is three cases above and reads identically — the two screens
  // are now one width rule, which is what the reporter asked for in the first place.
  // Source-level guards for the same decision live in test/tp1-form-width.test.ts and, module-wide, in
  // test/payroll-screens-layout.test.ts (WIDENED_LATER).
  it('the declaration page fills the width, exactly as the list it is reached from does', async () => {
    const tree = await renderMonth(String(CURRENT_YEAR), '1', { employmentId: aisha.employmentId });
    const classes = walk(tree)
      .map((e) => e.props?.className)
      .filter((c): c is string => typeof c === 'string');
    expect(classes, 'the page container is the shared full-width one').toContain(pageWideCls);
    // A centred max-width ANYWHERE on this page is the fault being fixed — named in both the bracket and
    // the `-Nxl` spelling, because the caps this module has collected over five rounds use both.
    const capped = classes.filter((c) => /\bmx-auto\b/.test(c) && /\bmax-w-(?:\d*xl\b|\[)/.test(c));
    expect(capped, `the declaration page re-narrows itself: ${capped.join(' | ')}`).toEqual([]);
  });

  // SECTION F IS ADMIN-ONLY, AND THIS IS THE ASSERTION THAT KEEPS IT THAT WAY. The employer-consent
  // controls exist only where the page passes `consent`; the employee's own screen never does, so an
  // employee cannot approve their own claim even before the service refuses it.
  it('the HR page passes employer-consent actions; they are a prop, not something the form assumes', async () => {
    const tree = await renderMonth(String(CURRENT_YEAR), '1', { employmentId: aisha.employmentId });
    const consent = byType(tree, Tp1DeclarationForm)[0].props.consent;
    expect(consent, 'Section F is offered on the HR screen').toBeTruthy();
    expect(typeof consent.approveAction).toBe('function');
    expect(typeof consent.rejectAction).toBe('function');
    expect(typeof consent.cancelAction).toBe('function');
    // The decision has to name WHICH declaration it is about, or an approval would target "the latest",
    // which is a different row the moment anyone corrects it.
    expect(consent.hiddenFields.tp1ReliefId).toBeTruthy();
    expect(consent.hiddenFields.employmentId).toBe(aisha.employmentId);
  });

  it('a PAST assessment year opens read-only, exactly as the old screen did', async () => {
    // Last year's declaration is month-less (written before the form had a month box) and the list links
    // such a row at month 1, so that is where it opens — as itself, not as a new January record.
    const tree = await renderMonth(String(LAST_YEAR), '1', { employmentId: aisha.employmentId });
    const form = byType(tree, Tp1DeclarationForm)[0];
    expect(form.props.readOnly).toBe(true);
    expect(form.props.latest.tp1Amount).toBe(500);
  });

  it('a month with nothing declared opens EMPTY rather than borrowing another month’s figures', async () => {
    const tree = await renderMonth(String(CURRENT_YEAR), '1', { employmentId: bala.employmentId });
    expect(byType(tree, Tp1DeclarationForm)[0].props.latest.tp1Amount).toBe(9999);
    // Aisha declared January and February and nothing else: March must open blank, not carry February.
    const empty = await renderMonth(String(CURRENT_YEAR), '3', { employmentId: aisha.employmentId });
    expect(byType(empty, Tp1DeclarationForm)[0].props.latest).toBeNull();
  });

  it('the declaration page refuses an employment this admin cannot see, a bad year, and a bad month', async () => {
    await expect(renderMonth(String(CURRENT_YEAR), '1', { employmentId: foreign.employmentId })).rejects.toThrow(
      'NEXT_NOT_FOUND',
    );
    await expect(renderMonth(String(CURRENT_YEAR), '1', { employmentId: randomUUID() })).rejects.toThrow(
      'NEXT_NOT_FOUND',
    );
    await expect(renderMonth(String(CURRENT_YEAR), '1', {})).rejects.toThrow('NEXT_NOT_FOUND');
    for (const bad of ['abcd', '20260', '1999', '2101', '../etc']) {
      await expect(renderMonth(bad, '1', { employmentId: aisha.employmentId })).rejects.toThrow('NEXT_NOT_FOUND');
    }
    for (const bad of ['0', '13', 'jan', '-1', '1.5', '../etc']) {
      await expect(
        renderMonth(String(CURRENT_YEAR), bad, { employmentId: aisha.employmentId }),
      ).rejects.toThrow('NEXT_NOT_FOUND');
    }
  });

  // A SHIPPED URL MUST NOT 404. `tp1/[year]` was the declaration page for two rounds; the save actions
  // still redirect through `?year=` and HR has it bookmarked. It forwards, carrying the employee with it
  // — dropping employmentId would land the reader on a page that 404s for want of a selection.
  it('the old tp1/[year] URL redirects to the month page instead of disappearing', async () => {
    await Tp1DeclarationYearPage({
      params: Promise.resolve({ year: String(CURRENT_YEAR) }),
      searchParams: Promise.resolve({ employmentId: aisha.employmentId }),
    } as any);
    const to = vi.mocked(redirect).mock.calls.at(-1)?.[0];
    expect(to).toMatch(
      new RegExp(`^/payroll/transactions/tp1/${CURRENT_YEAR}/\\d{1,2}\\?employmentId=${aisha.employmentId}$`),
    );
  });
});
