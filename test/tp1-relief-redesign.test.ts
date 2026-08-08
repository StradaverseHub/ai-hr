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
vi.mock('next-intl/server', () => ({ getTranslations: vi.fn(async () => (k: string) => k) }));

import * as schema from '../db/schema';
import type { SessionContext } from '../db/client';
import { adminCtx, closeAll, migrateTestDb, owner, resetDb, seedBase, type Base } from './harness';
import { hireEmployee } from '../core/org';
import { setCompensation } from '../core/comp';
import { setStatutoryProfileMY } from '../localization/my/statutory';
import { createBatch, generatePayslips, setPayrollDeductionInput } from '../core/payroll';
import { listTp1DeclarationsForPerson } from '../core/tax-relief';
import { todayInKualaLumpur } from '../lib/hr-date';
import { CollapsibleEmployeePanel, EmployeeScopePanel } from '../components/collapsible-employee-panel';
import { AppliedInPayrollList } from '../components/applied-in-payroll-list';
import { Tp1DeclarationsList } from '../components/tp1-declarations-list';
import { Tp1DeclarationForm } from '../components/tp1-declaration-form';
import Tp1TransactionPage, { TP1_PANEL_COOKIE } from '../app/payroll/transactions/tp1/page';
import Tp1DeclarationYearPage from '../app/payroll/transactions/tp1/[year]/page';

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

    // ── Declarations. The current year gets TWO rows for Aisha: the original and a correction. Written
    // directly because what is under test is the READ that collapses them, not the write path (which has
    // its own tests) — and because created_at has to be controlled to make "newest wins" falsifiable.
    await owner.db.insert(schema.tp1Relief).values([
      {
        tenantId: base.tenantId,
        personId: aisha.personId,
        assessmentYear: CURRENT_YEAR,
        status: 'submitted',
        tp1Amount: '3000.00',
        submittedAt: new Date(`${CURRENT_YEAR}-02-01T02:00:00Z`),
        createdAt: new Date(`${CURRENT_YEAR}-02-01T02:00:00Z`),
      },
      {
        tenantId: base.tenantId,
        personId: aisha.personId,
        assessmentYear: CURRENT_YEAR,
        status: 'submitted',
        tp1Amount: '4000.00',
        submittedAt: new Date(`${CURRENT_YEAR}-03-01T02:00:00Z`),
        createdAt: new Date(`${CURRENT_YEAR}-03-01T02:00:00Z`),
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

    // The reporter asked for the full-width layout every sibling screen has.
    expect(walk(tree).some((e) => typeof e.props?.className === 'string' && e.props.className.includes('max-w-[100rem]'))).toBe(true);
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
    const toDeclaration = hrefsIn(tree).filter((h) => h.startsWith('/payroll/transactions/tp1/'));
    expect(toDeclaration).toContain(
      `/payroll/transactions/tp1/${CURRENT_YEAR}?employmentId=${aisha.employmentId}`,
    );
    // The selected employee is named at the top of the workspace, as on Fixed Transaction.
    expect(textIn(tree)).toContain('Aisha Rahman');
  });

  // ───────────────────── Transaction history ─────────────────────

  it('the history is ONE ROW PER ASSESSMENT YEAR, carrying the NEWEST row within each year', async () => {
    const tree = await render({ employmentId: aisha.employmentId });
    const rows = lists(tree).declarations[0].props.rows as {
      assessmentYear: number;
      amount: string;
      status: string;
      versions: number;
      href: string;
      readOnly: boolean;
    }[];
    expect(rows.map((r) => r.assessmentYear)).toEqual([CURRENT_YEAR, LAST_YEAR]);
    const current = rows[0];
    expect(current.amount, 'the correction wins, not the original').toBe('4000.00');
    expect(current.status).toBe('submitted');
    expect(current.versions, 'the superseded row is counted, never listed').toBe(2);
    expect(current.readOnly).toBe(false);
    expect(current.href).toBe(`/payroll/transactions/tp1/${CURRENT_YEAR}?employmentId=${aisha.employmentId}`);
    const past = rows[1];
    expect(past.amount).toBe('500.00');
    expect(past.status).toBe('draft');
    expect(past.versions).toBe(1);
    expect(past.readOnly, 'a closed assessment year opens read-only').toBe(true);
  });

  it('the history is narrowed to the selected employee — in the QUERY, not over rows already read', async () => {
    const tree = await render({ employmentId: aisha.employmentId });
    const { declarations, applied } = lists(tree);
    expect(JSON.stringify(declarations[0].props.rows)).not.toContain('9999');
    expect((applied[0].props.rows as { employeeName: string }[]).map((r) => r.employeeName)).toEqual([
      'Aisha Rahman',
    ]);
  });

  it('core: listTp1DeclarationsForPerson collapses the append-only chain the same way the form reads it', async () => {
    const rows = await listTp1DeclarationsForPerson(a, { personId: aisha.personId });
    expect(rows.map((r) => r.assessmentYear)).toEqual([CURRENT_YEAR, LAST_YEAR]);
    expect(rows[0].tp1Amount).toBe(4000);
    expect(rows[0].versions).toBe(2);
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

  const renderYear = (year: string, searchParams: Record<string, string> = {}) =>
    Tp1DeclarationYearPage({
      params: Promise.resolve({ year }),
      searchParams: Promise.resolve(searchParams),
    } as any);

  it('the declaration page renders the SHARED form for the picked employee and year', async () => {
    const tree = await renderYear(String(CURRENT_YEAR), { employmentId: aisha.employmentId });
    const forms = byType(tree, Tp1DeclarationForm);
    expect(forms, 'the ESS screen and this one render the SAME component').toHaveLength(1);
    expect(forms[0].props.selectedYear).toBe(CURRENT_YEAR);
    expect(forms[0].props.readOnly).toBe(false);
    expect(forms[0].props.latest.tp1Amount, 'the latest row for the year, corrections included').toBe(4000);
    // The employee is carried as a hidden field, not chosen: the page cannot retarget the save.
    expect(forms[0].props.hiddenFields).toEqual({ employmentId: aisha.employmentId });
    // Save and Submit are the shared form's own buttons; Cancel returns to the record it belonged to.
    expect(hrefsIn(tree)).toContain(`/payroll/transactions/tp1?employmentId=${aisha.employmentId}`);
  });

  it('a PAST assessment year opens read-only, exactly as the old screen did', async () => {
    const tree = await renderYear(String(LAST_YEAR), { employmentId: aisha.employmentId });
    const form = byType(tree, Tp1DeclarationForm)[0];
    expect(form.props.readOnly).toBe(true);
    expect(form.props.latest.tp1Amount).toBe(500);
  });

  it('a year with nothing declared opens EMPTY rather than borrowing another year’s figures', async () => {
    const tree = await renderYear(String(CURRENT_YEAR), { employmentId: bala.employmentId });
    expect(byType(tree, Tp1DeclarationForm)[0].props.latest.tp1Amount).toBe(9999);
    const empty = await renderYear(String(CURRENT_YEAR - 5), { employmentId: bala.employmentId });
    expect(byType(empty, Tp1DeclarationForm)[0].props.latest).toBeNull();
  });

  it('the declaration page refuses an employment this admin cannot see, and a year that is not one', async () => {
    await expect(renderYear(String(CURRENT_YEAR), { employmentId: foreign.employmentId })).rejects.toThrow(
      'NEXT_NOT_FOUND',
    );
    await expect(renderYear(String(CURRENT_YEAR), { employmentId: randomUUID() })).rejects.toThrow(
      'NEXT_NOT_FOUND',
    );
    await expect(renderYear(String(CURRENT_YEAR), {})).rejects.toThrow('NEXT_NOT_FOUND');
    for (const bad of ['abcd', '20260', '1999', '2101', '../etc']) {
      await expect(renderYear(bad, { employmentId: aisha.employmentId })).rejects.toThrow('NEXT_NOT_FOUND');
    }
  });
});
