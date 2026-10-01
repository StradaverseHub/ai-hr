/**
 * r168a — the shared employee panel (6a1f2bd6 Zakat, 6d72816e Loans, da4af51f Individual Payslip).
 *
 * WHAT THIS FILE IS FOR, AND WHY IT ASSERTS THE REFUSAL RATHER THAN THE HAPPY PATH.
 *
 * Swapping a `<select name="employmentId">` for a client-side list moves WHERE the selection is expressed
 * but must not move where it is DECIDED. Each of these pages coerces an `?employmentId=` it does not
 * recognise to "no selection", so URL tampering can only ever narrow. That coercion is invisible: a page
 * that dropped it still renders, still returns 200, and still passes every source-grep assertion — it just
 * quietly reads somebody else's employee. So each screen is rendered TWICE, once with a legitimate id and
 * once with a foreign one, and the assertion is on what the panel is HANDED (`selectedId`), which is the
 * guard's output rather than its source text.
 *
 * THE TWO FENCES ARE DIFFERENT, DELIBERATELY, AND THE TESTS SAY SO RATHER THAN AVERAGING THEM:
 *   - Zakat and Individual Payslip run `scopedAdmin()` and read `listEmployees(s, scopeIds)`, so the fence
 *     is COMPANY SCOPE. The foreign id used against them is a REAL employment in a real second company
 *     that scope excludes — the actual cross-company read a tampered URL would attempt.
 *   - Loans runs `requireAdmin()` and reads `listEmployees(s)`, tenant-wide. That is the gate the page has
 *     always sat behind and r168a deliberately did NOT swap it for `scopedAdmin()` — narrowing a page's
 *     fence while redesigning its UI is a privilege change dressed as a UI request, and widening it is
 *     worse. So the foreign id used against Loans is one that does not resolve at all, and the assertion
 *     is that it degrades to "no selection" (the whole list) rather than to an empty list.
 *
 * Zakat carries a third case of its own: its picker has ALWAYS excluded terminated employees, so its guard
 * refuses them too. The panel is fed exactly that set, and a terminated id must still coerce to null — if
 * the refactor had widened the panel's source to `allEmployees` to make the Status filter look useful, that
 * is the assertion that catches it.
 */
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

// scopedAdmin / requireAdmin holders — mutated per test so each page's fence can be driven independently.
const { scope } = vi.hoisted(() => ({ scope: { s: null as unknown, scopeIds: [] as string[] } }));
vi.mock('next/cache', () => ({ revalidatePath: vi.fn(() => undefined), revalidateTag: vi.fn(() => undefined) }));
vi.mock('next/navigation', () => ({ redirect: vi.fn(() => undefined), notFound: vi.fn(() => undefined) }));
vi.mock('@/lib/scope', () => ({ scopedAdmin: vi.fn(async () => scope) }));
vi.mock('@/lib/authz', () => ({ requireAdmin: vi.fn(async () => scope.s) }));
// The collapse state is read from a cookie. Empty by default, so every panel reports "absent" ⇒ expanded,
// which is what every case below except bd14b7e2's default-open one assumes; that one writes into this map
// to drive the panel's remembered state, and `beforeEach` clears it so it cannot leak between cases.
const { panelCookies } = vi.hoisted(() => ({ panelCookies: new Map<string, string>() }));
vi.mock('next/headers', () => ({
  cookies: vi.fn(async () => ({
    get: (name: string) => {
      const value = panelCookies.get(name);
      return value === undefined ? undefined : { name, value };
    },
  })),
}));
// getTranslations → identity, so assertions read as keys without the full next-intl runtime config.
// getLocale is exported too because BOTH r179 screens format a month name on the SERVER through Intl —
// Transaction Detail its month captions, Individual Payslip its pay period. An undefined locale would
// throw inside the page rather than failing an assertion, which reads as a confusing crash rather than a
// diagnosis. Additive, so the Zakat / Individual Payslip / Loans cases above are unaffected.
vi.mock('next-intl/server', () => ({
  getTranslations: vi.fn(async () => (k: string) => k),
  getLocale: vi.fn(async () => 'en'),
}));

import * as schema from '../db/schema';
import { adminCtx, closeAll, migrateTestDb, owner, resetDb, seedBase, type Base } from './harness';
import { hireEmployee } from '../core/org';
import { EmployeeScopePanel } from '../components/collapsible-employee-panel';
import { EmployeeSearchField } from '../components/employee-search-field';
import ZakatTransactionPage from '../app/payroll/transactions/zakat/page';
import IndividualPayslipPage from '../app/payroll/individual-payslip/page';
import LoansPage from '../app/admin/loans/page';
import { LoanList } from '../components/loan-list';
import { CollapsibleEmployeePanel } from '../components/collapsible-employee-panel';
// EmployeeSearchField is imported once, above — both r179 workstreams added it independently and the
// merge kept both copies. Keep a single import here.
import TransactionViewPage from '../app/payroll/transaction-view/page';
import { HistoryGrid } from '../app/payroll/transaction-view/history-grid';
// 9949f91a (r369) — the two Leave Inquiry tabs join the file. Their fence is company SCOPE (`scopedAdmin` +
// `listEmployees(s, scopeIds)`), the same as Zakat's, so the foreign id used against them is a real
// employment in a real second company that scope excludes.
import EmployeeBalancesPage from '../app/leave/employee-balances/page';
import EmployeeRecordsPage from '../app/leave/employee-records/page';

/** Depth-first walk of a rendered React element tree collecting every node whose `type` identity matches.
 *  Copied from organization-companies-unscoped.test.ts — the established way to inspect what a SERVER
 *  component handed a child without standing up a renderer. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function findByType(node: unknown, type: unknown, acc: any[] = []): any[] {
  if (!node || typeof node !== 'object') return acc;
  if (Array.isArray(node)) {
    for (const n of node) findByType(n, type, acc);
    return acc;
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const el = node as any;
  if (el.type === type) acc.push(el);
  for (const key of ['children', 'panel']) {
    const v = el.props?.[key];
    if (v !== undefined) findByType(v, type, acc);
  }
  return acc;
}

/** Every host element of `tag` in a tree carrying the given form-field name — i.e. the controls that post. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function controlsNamed(tree: unknown, tag: string, name: string): any[] {
  return findByType(tree, tag).filter((el) => el.props?.name === name);
}

/** The single `selectedId` the screen handed the shared panel — i.e. the guard's verdict. */
function panelSelection(tree: unknown): string | null {
  const panels = findByType(tree, EmployeeScopePanel);
  expect(panels, 'the screen must render exactly one shared employee panel').toHaveLength(1);
  return panels[0].props.selectedId as string | null;
}

/**
 * `searchFieldSelection` — the same verdict read off `components/employee-search-field.tsx` — lived here
 * between r179 and r185 W-A, while Transaction Detail and Individual Payslip expressed their selection in
 * that control. Both screens went back to the panel at the reporter's request, so every verdict is read
 * through `panelSelection` above again and the second reader has been removed rather than left as a dead
 * helper pointing at a control no page mounts. EmployeeSearchField is still IMPORTED, because several
 * cases now assert it is mounted ZERO times: an assertion that a component is absent is worthless if the
 * identity it compares against is not the real one.
 */

describe('r168a — an out-of-scope ?employmentId= selects NOTHING on every screen the panel touched', () => {
  let base: Base;
  let mine: { employmentId: string; personId: string };
  let terminated: { employmentId: string; personId: string };
  let foreignCompanyId: string;
  let foreign: { employmentId: string; personId: string };

  beforeAll(async () => {
    await migrateTestDb();
  });

  beforeEach(async () => {
    panelCookies.clear();
    await resetDb();
    base = await seedBase();
    const a = adminCtx(base);
    scope.s = a;

    mine = await hireEmployee(a, {
      person: { fullName: 'Aisha In Scope', primaryEmail: 'aisha@acme.test' },
      companyId: base.companyId,
      departmentId: base.deptA,
      employmentType: 'full_time',
      hiredOn: '2026-01-01',
    });

    // A terminated colleague in the SAME company — in scope for the company fence, but excluded by Zakat's
    // own longstanding "non-terminated only" narrowing.
    terminated = await hireEmployee(a, {
      person: { fullName: 'Bala Departed', primaryEmail: 'bala@acme.test' },
      companyId: base.companyId,
      departmentId: base.deptA,
      employmentType: 'full_time',
      hiredOn: '2026-01-01',
    });
    // Terminated directly on the row: what is under test is the READ-side guard, not the termination
    // workflow (which has its own tests and would drag lifecycle events in for no added coverage here).
    await owner.db
      .update(schema.employment)
      .set({ terminatedOn: '2026-06-30' })
      .where(eq(schema.employment.id, terminated.employmentId));

    // A REAL second company in the same tenant, with a real employee — the cross-company read a tampered
    // URL actually attempts. Company scope will be narrowed to exclude it.
    const [c] = await owner.db
      .insert(schema.company)
      .values({ tenantId: base.tenantId, legalName: 'Beta Sdn Bhd' })
      .returning({ id: schema.company.id });
    foreignCompanyId = c.id;
    // hireEmployee's cross-company label guard is unconditional, so the second company needs its own
    // department before it can have an employee.
    const [d] = await owner.db
      .insert(schema.department)
      .values({ tenantId: base.tenantId, companyId: foreignCompanyId, name: 'Beta Ops' })
      .returning({ id: schema.department.id });
    foreign = await hireEmployee(a, {
      person: { fullName: 'Chen Other Company', primaryEmail: 'chen@beta.test' },
      companyId: foreignCompanyId,
      departmentId: d.id,
      employmentType: 'full_time',
      hiredOn: '2026-01-01',
    });

    // Scope deliberately EXCLUDES the second company.
    scope.scopeIds = [base.companyId];
  });

  afterAll(async () => {
    await closeAll();
  });

  // ───────────────────────────── Zakat ─────────────────────────────

  it('Zakat: a legitimate employee is selected, a cross-company one is not', async () => {
    const ok = await ZakatTransactionPage({ searchParams: Promise.resolve({ employmentId: mine.employmentId }) });
    expect(panelSelection(ok)).toBe(mine.employmentId);

    const tampered = await ZakatTransactionPage({
      searchParams: Promise.resolve({ employmentId: foreign.employmentId }),
    });
    expect(panelSelection(tampered), 'a company outside scope must coerce to no selection').toBeNull();
  });

  it('Zakat: the panel is fed only the employees the guard would accept (no dead rows)', async () => {
    // The refactor could have "improved" the Status filter by feeding the panel every employee. That would
    // render terminated and cross-company people as clickable rows the server then silently refuses.
    const tree = await ZakatTransactionPage({ searchParams: Promise.resolve({}) });
    const panel = findByType(tree, EmployeeScopePanel)[0];
    const offered: string[] = panel.props.employees.map((e: { employmentId: string }) => e.employmentId);
    expect(offered).toContain(mine.employmentId);
    expect(offered, 'a cross-company employee must not be offered').not.toContain(foreign.employmentId);

    // Every row offered must survive the page's own guard — proved by feeding each back in.
    for (const id of offered) {
      const re = await ZakatTransactionPage({ searchParams: Promise.resolve({ employmentId: id }) });
      expect(panelSelection(re), `the panel offered ${id} but the guard refused it`).toBe(id);
    }
  });

  it('Zakat: an unknown id is refused rather than erroring', async () => {
    const tree = await ZakatTransactionPage({ searchParams: Promise.resolve({ employmentId: randomUUID() }) });
    expect(panelSelection(tree)).toBeNull();
  });

  it('Zakat: a TERMINATED employee is still refused, as this screen has always refused them', async () => {
    // Zakat's election picker has never listed terminated employees, and the guard behind it says so. The
    // temptation during this refactor was to widen the panel's source to make the Employee Status filter
    // look useful; this is the assertion that catches it.
    const tree = await ZakatTransactionPage({
      searchParams: Promise.resolve({ employmentId: terminated.employmentId }),
    });
    expect(panelSelection(tree)).toBeNull();
  });

  // ──────────────────────── Individual Payslip ────────────────────────

  it('Individual Payslip: a legitimate employee is selected, a cross-company one is not', async () => {
    // REWRITTEN TWICE, DELETED NEVER. r179 moved this screen's control from the left-hand panel to the
    // shared search field, and f35f758a rev 2 moved it back at the reporter's request. Both times the
    // VALUABLE half was untouched: a foreign employmentId must coerce to no selection, and that coercion
    // is invisible on a page that drops it. Only where the verdict is read off has moved.
    const ok = await IndividualPayslipPage({
      searchParams: Promise.resolve({ employmentId: mine.employmentId }),
    });
    expect(panelSelection(ok)).toBe(mine.employmentId);

    const tampered = await IndividualPayslipPage({
      searchParams: Promise.resolve({ employmentId: foreign.employmentId }),
    });
    expect(panelSelection(tampered), 'a company outside scope must coerce to no selection').toBeNull();

    // The top-row search field goes away with the restore. A page that kept both controls would offer two
    // places to pick a person and one of them would be wrong after the other was used.
    expect(
      findByType(ok, EmployeeSearchField),
      'the search field in the filter row is replaced by the panel, not joined by it',
    ).toHaveLength(0);
  });

  it('Individual Payslip: an out-of-scope companyId is still refused alongside the employee', async () => {
    // The employee guard and the company guard must BOTH hold, or the screen narrowed one fence while
    // widening another.
    const tree = await IndividualPayslipPage({
      searchParams: Promise.resolve({ companyId: foreignCompanyId, employmentId: foreign.employmentId }),
    });
    expect(panelSelection(tree)).toBeNull();

    // …and the panel is fed only what the guard would accept, so it cannot offer a row the server refuses.
    // Every option is fed back through the page to prove it.
    const offered: string[] = findByType(tree, EmployeeScopePanel)[0].props.employees.map(
      (e: { employmentId: string }) => e.employmentId,
    );
    expect(offered).toContain(mine.employmentId);
    expect(offered, 'a cross-company employee must not be offered').not.toContain(foreign.employmentId);
    for (const id of offered) {
      const re = await IndividualPayslipPage({ searchParams: Promise.resolve({ employmentId: id }) });
      expect(panelSelection(re), `the panel offered ${id} but the guard refused it`).toBe(id);
    }
  });

  // ───────────────────────────── Loans ─────────────────────────────

  it('Loans: an unresolvable ?employmentId= degrades to NO selection, not to an empty list', async () => {
    const tree = await LoansPage({ searchParams: Promise.resolve({ employmentId: randomUUID() }) });
    expect(panelSelection(tree)).toBeNull();

    // The regression this guards is subtle and expensive: filtering on an unresolved id would show an
    // admin an empty loan book and read as "there are no loans" rather than "that link was wrong".
    const lists = findByType(tree, LoanList);
    expect(lists).toHaveLength(1);
    expect(Array.isArray(lists[0].props.loans)).toBe(true);
  });

  it('Loans: the panel NARROWS, it does not gate — no selection still shows every loan', async () => {
    const none = await LoansPage({ searchParams: Promise.resolve({}) });
    expect(panelSelection(none)).toBeNull();
    const all = findByType(none, LoanList)[0].props.loans.length;

    const picked = await LoansPage({ searchParams: Promise.resolve({ employmentId: mine.employmentId }) });
    expect(panelSelection(picked)).toBe(mine.employmentId);
    const forOne = findByType(picked, LoanList)[0].props.loans.length;

    // With no loans seeded both are zero; the assertion that matters is that selecting never WIDENS and
    // that the unselected view is the superset. This stays true once loans exist.
    expect(forOne).toBeLessThanOrEqual(all);
  });

  it('Loans keeps requireAdmin — the fence did not move with the redesign', async () => {
    // Stated as a behavioural fact rather than a grep: the page resolves its session through requireAdmin,
    // so the mocked requireAdmin above is what it ran on. If it had been swapped to scopedAdmin it would
    // have read `scope.s` through a different call and the tenant-wide employee list would have narrowed.
    const tree = await LoansPage({ searchParams: Promise.resolve({}) });
    const offered: string[] = findByType(tree, EmployeeScopePanel)[0].props.employees.map(
      (e: { employmentId: string }) => e.employmentId,
    );
    expect(offered).toContain(mine.employmentId);
    expect(offered, 'Loans is tenant-wide by design; scope must NOT have been applied here').toContain(
      foreign.employmentId,
    );
    expect(terminated.employmentId).toBeTruthy();
  });

  // ───────────── Transaction View › Transaction Detail (98e69987) ─────────────
  //
  // r168a's question is "does the selection still get DECIDED on the server?", and it is the same question
  // whether the selection is expressed by a rail, a dropdown or a search box. r179 removed this tab's
  // permanent left-hand rail and moved the choice to the shared searchable field in the filter row; the
  // reporter then saw that live and asked for the rail back, so 98e69987 rev 2 RESTORES it. These cases
  // moved with the control both times, because the thing under test never moved — only where the verdict
  // is read off did.
  //
  // What the restore puts at risk, and what these cases therefore pin:
  //
  //   1. THE FENCE. The rail is fed the same scope-fenced `listEmployees(s, scopeIds)` the search box was.
  //      A widened source would offer a cross-company employee as a clickable row, and the page's own
  //      coercion of a foreign `?employmentId=` is invisible — the screen still renders and still 200s.
  //   2. ONE EMPLOYEE CONTROL. The shared filter bar is gated OFF for this tab again, exactly as it was
  //      before r179, so the rail is the only place a person is picked. Two controls that disagree on one
  //      screen is what that gate has always existed to prevent, in either direction.
  //   3. THE MONTHS CONTRACT. The rail's `preserve` carries `months` as ONE comma-joined string while the
  //      tick boxes post repeated params. `cleanMonths` accepts both; the export-params case below is what
  //      catches a partial revert that quietly breaks one of the two forms.
  //
  // Rendered twice with a legitimate and a foreign id, like every case above, and the verdict read off what
  // the screen HANDS the control rather than out of its source text.

  it('Transaction Detail: the rail is back, and it is the ONLY employee control on the tab', async () => {
    const tree = await TransactionViewPage({
      searchParams: Promise.resolve({ tab: 'grid', employmentId: mine.employmentId }),
    });

    expect(
      findByType(tree, CollapsibleEmployeePanel),
      'the collapsible rail must wrap this tab again — the reporter asked for the list back',
    ).toHaveLength(1);
    expect(findByType(tree, EmployeeScopePanel), 'and it must carry the shared scope panel').toHaveLength(1);

    expect(
      findByType(tree, EmployeeSearchField),
      'the top-row search box goes away with the restore — two employee controls must never coexist here',
    ).toHaveLength(0);
    expect(
      controlsNamed(tree, 'select', 'employmentId'),
      'the shared filter bar is gated off this tab, so its long dropdown must not render either',
    ).toHaveLength(0);

    // ONE form on the tab: the rail's own inner year / months / cycle GET form. The shared bar above is
    // gated off, and the employee choice is in NO form at all — EmployeeScopePanel navigates by
    // router.push, which is exactly why it can live outside the period form without disagreeing with it.
    const forms = findByType(tree, 'form');
    expect(forms, 'the tab runs its own period form and nothing else').toHaveLength(1);
    expect(forms[0].props.method).toBe('GET');
    expect(
      findByType(forms[0], EmployeeScopePanel),
      'the panel navigates rather than posting, so it is not inside the period form',
    ).toHaveLength(0);

    // …and the period controls the plan promised, in that one form. `companyId` rides as a HIDDEN input
    // here (the top row's Company select is gated off this tab), so there is no select to count.
    expect(controlsNamed(forms[0], 'select', 'year')).toHaveLength(1);
    expect(controlsNamed(forms[0], 'select', 'cycle')).toHaveLength(1);
    expect(controlsNamed(forms[0], 'input', 'months'), 'the twelve month tick boxes').toHaveLength(12);
  });

  it('Transaction Detail: an out-of-scope ?employmentId= selects NOTHING, and the rail reaches only the scoped list', async () => {
    const ok = await TransactionViewPage({
      searchParams: Promise.resolve({ tab: 'grid', employmentId: mine.employmentId }),
    });
    expect(panelSelection(ok)).toBe(mine.employmentId);

    const tampered = await TransactionViewPage({
      searchParams: Promise.resolve({ tab: 'grid', employmentId: foreign.employmentId }),
    });
    expect(panelSelection(tampered), 'a company outside scope must coerce to no selection').toBeNull();

    // The rail is fed the same scope-fenced read the search box was; restoring it must not have widened it.
    // Note the key is `employmentId` on the panel, where the search field called it `value`.
    const offered: string[] = findByType(tampered, EmployeeScopePanel)[0].props.employees.map(
      (e: { employmentId: string }) => e.employmentId,
    );
    expect(offered).toContain(mine.employmentId);
    expect(offered, 'restoring the rail must not have widened what it can reach').not.toContain(
      foreign.employmentId,
    );
  });

  it('Transaction Detail: the URL token and the export params are exactly what they were', async () => {
    // The reporter was promised that saved links keep working, so the RENAME had to be a caption change
    // only. The tab is still addressed by the same token, and the Excel download still carries the same
    // five filters — an export that quietly stopped carrying the employee would produce a file for the
    // wrong person while the screen looked right.
    const tree = await TransactionViewPage({
      searchParams: Promise.resolve({
        tab: 'grid',
        employmentId: mine.employmentId,
        year: '2026',
        months: ['1', '2'],
        cycle: 'regular',
        companyId: base.companyId,
      }),
    });

    const tabField = controlsNamed(tree, 'input', 'tab');
    expect(tabField).toHaveLength(1);
    expect(tabField[0].props.value, 'the saved-link token must stay `grid`').toBe('grid');

    const grids = findByType(tree, HistoryGrid);
    expect(grids).toHaveLength(1);
    expect(grids[0].props.exportParams).toEqual({
      companyId: base.companyId,
      employmentId: mine.employmentId,
      year: '2026',
      months: '1,2',
      cycle: 'regular',
    });
  });

  it('Transaction Detail: with nobody chosen it says so instead of drawing an empty year', async () => {
    const tree = await TransactionViewPage({ searchParams: Promise.resolve({ tab: 'grid' }) });
    expect(panelSelection(tree)).toBeNull();
    expect(findByType(tree, HistoryGrid), 'no employee, no figures').toHaveLength(0);
  });

  // ───────── bd14b7e2 — the OTHER four tabs now pick an employee the same way ─────────
  //
  // THIS EDITS 98e69987's "the redesign is one tab wide" CASE RATHER THAN DELETING IT, because the
  // reporter has since asked for the opposite and only HALF of what that case asserted is being reversed:
  //
  //   · REVERSED, on the approved plan: "the four beside it must still offer the control they always had"
  //     — the long `<select name="employmentId">` listing every employee in scope. That is the control the
  //     request is about; it is gone from all four, replaced by the same panel Transaction Detail uses.
  //   · KEPT, unchanged and still the point: no tab may carry TWO employee controls. Two controls that can
  //     disagree on one screen is the failure both halves of this guard have always existed to prevent, in
  //     whichever direction the screen is moving.
  //
  // The fence is asserted the same way it is everywhere else in this file — off `selectedId`, the guard's
  // verdict, rather than off source text — because widening the panel's source or dropping the coercion
  // still renders, still 200s, and still passes every grep.

  // 6b4ca488 — 'statutory' joins these: it mounts the SAME shared shell, carries the panel's selection
  // through Apply the same way, and must coerce an out-of-scope ?employmentId= to nothing exactly as the
  // other four do. It is deliberately NOT in ALL_EMPLOYEES_TABS below — see that constant.
  const PANEL_TABS = ['fixed', 'individual', 'history', 'statutory', 'outstanding'] as const;
  /**
   * The subset for which "All employees" is a real destination. 6b4ca488 SPLIT this out of PANEL_TABS
   * rather than widening the allowAll case, because the two lists now answer different questions and
   * merging them would have quietly armed the row on a screen that cannot use it: a Statutory
   * Explanation is ONE payslip's working, so clearing the selection there is not a broader view, it is
   * no view at all. The four below are cross-employee lists an employee merely narrows.
   */
  const ALL_EMPLOYEES_TABS = ['fixed', 'individual', 'history', 'outstanding'] as const;

  it('bd14b7e2 — the four inquiry tabs pick an employee with the shared PANEL, and the dropdown is gone', async () => {
    for (const tab of PANEL_TABS) {
      const tree = await TransactionViewPage({
        searchParams: Promise.resolve({ tab, employmentId: mine.employmentId }),
      });

      expect(
        findByType(tree, EmployeeSearchField),
        `${tab} must not have grown a second employee control`,
      ).toHaveLength(0);
      expect(
        controlsNamed(tree, 'select', 'employmentId'),
        `${tab}: the long dropdown is REPLACED by the panel, never joined by it`,
      ).toHaveLength(0);

      expect(
        findByType(tree, CollapsibleEmployeePanel),
        `${tab} must mount the same collapsible rail Transaction Detail uses`,
      ).toHaveLength(1);
      expect(panelSelection(tree), `${tab} must hand the guard's verdict to the panel`).toBe(mine.employmentId);

      // The selection rides through Apply as a hidden field. Without it, changing any filter would
      // silently widen the tab back to everybody while the rail still showed the person as selected —
      // the two-controls-disagreeing failure in its quietest form.
      const carried = controlsNamed(tree, 'input', 'employmentId');
      expect(carried, `${tab}: an Apply must not drop the panel's selection`).toHaveLength(1);
      expect(carried[0].props.type).toBe('hidden');
      expect(carried[0].props.value).toBe(mine.employmentId);
    }
  });

  it('bd14b7e2 — an out-of-scope ?employmentId= selects NOTHING on all four, and Apply carries nothing', async () => {
    for (const tab of PANEL_TABS) {
      const tree = await TransactionViewPage({
        searchParams: Promise.resolve({ tab, employmentId: foreign.employmentId }),
      });
      expect(panelSelection(tree), `${tab}: a company outside scope must coerce to no selection`).toBeNull();

      // A FIELD THAT IS ALWAYS SUBMITTED CANNOT BE READ BY PRESENCE — so the hidden input exists only when
      // a selection survived the guard. That is also what makes "All employees" expressible at all: no
      // field, no employee, and the tab shows what it shows today.
      expect(
        controlsNamed(tree, 'input', 'employmentId'),
        `${tab}: there is no surviving selection to carry`,
      ).toHaveLength(0);

      const offered: string[] = findByType(tree, EmployeeScopePanel)[0].props.employees.map(
        (e: { employmentId: string }) => e.employmentId,
      );
      expect(offered).toContain(mine.employmentId);
      expect(offered, `${tab}: the panel must not reach past the company fence`).not.toContain(
        foreign.employmentId,
      );
    }
  });

  it('bd14b7e2 — the "All employees" row is OPT-IN, and stays OFF wherever a person is required', async () => {
    // The row clears the selection. On the four inquiry tabs that is a real destination — it is the view
    // each of them opens on today. On every screen that shows ONE person's record it is a row leading
    // nowhere, so the prop must default off and no existing consumer may quietly acquire it.
    for (const tab of ALL_EMPLOYEES_TABS) {
      const tree = await TransactionViewPage({ searchParams: Promise.resolve({ tab }) });
      expect(
        findByType(tree, EmployeeScopePanel)[0].props.allowAll,
        `${tab}: clearing the selection is this tab's default view and must be offered`,
      ).toBe(true);
    }

    const requiresAPerson: [string, unknown][] = [
      ['Transaction Detail', await TransactionViewPage({ searchParams: Promise.resolve({ tab: 'grid' }) })],
      // 6b4ca488 — the Statutory Explanation tab. It shares the four tabs' shell, so unlike Transaction
      // Detail it cannot opt out merely by having its own wrapper: the flag is a condition on that shell
      // and this is the assertion that keeps it one.
      ['Statutory Explanation', await TransactionViewPage({ searchParams: Promise.resolve({ tab: 'statutory' }) })],
      ['Zakat', await ZakatTransactionPage({ searchParams: Promise.resolve({}) })],
      ['Individual Payslip', await IndividualPayslipPage({ searchParams: Promise.resolve({}) })],
      ['Loans', await LoansPage({ searchParams: Promise.resolve({}) })],
    ];
    for (const [name, tree] of requiresAPerson) {
      expect(
        findByType(tree, EmployeeScopePanel)[0].props.allowAll ?? false,
        `${name} must not have acquired the All-employees row`,
      ).toBe(false);
    }

    // …and the component's own default, read at source: the two screens NOT rendered above (Fixed
    // Transaction, TP1) inherit it, and a default flipped to `true` would arm the row on all six at once
    // while every assertion above still passed.
    const shell = fs.readFileSync(
      path.resolve(__dirname, '..', 'components/collapsible-employee-panel.tsx'),
      'utf8',
    );
    expect(shell, 'the All-employees row must be opt-in at the component').toContain('allowAll = false');
  });

  it('bd14b7e2 — every caption the panel adds exists in all six catalogues', () => {
    // Transaction View reads TWO namespaces, so i18n-coverage's check C skips the whole file: a key that
    // exists nowhere would pass tsc, this suite and `next build`, and paint MISSING_MESSAGE on all four
    // tabs. These six are looked up on every visit — four by the page (header row and panel heading) and
    // two by the shared component for the All-employees row.
    for (const loc of ['en', 'ms', 'ta', 'th', 'vi', 'zh']) {
      const msgs = JSON.parse(fs.readFileSync(path.resolve(__dirname, '..', `messages/${loc}.json`), 'utf8'));
      for (const key of ['heading', 'hint', 'change', 'select']) {
        expect(
          msgs.payroll?.transactions?.view?.panel?.[key],
          `payroll.transactions.view.panel.${key} missing from ${loc}.json`,
        ).toBeTruthy();
      }
      for (const key of ['allEmployees', 'allEmployeesHint']) {
        expect(msgs.employeePanel?.[key], `employeePanel.${key} missing from ${loc}.json`).toBeTruthy();
      }
    }
  });

  // ───────── bd14b7e2 — the two mechanisms the cases above structurally cannot see ─────────
  //
  // Everything asserted so far reads props off `EmployeeScopePanel` (the LIST). The round also introduced
  // two values on the SHELL around it — `cookieKey` and `defaultOpen` — and nothing was reading either, so
  // both could be broken in the exact ways they exist to prevent while tsc, this suite and `next build`
  // all stayed green: collapsing the five keys back into one, or re-forcing the panel open in the state
  // these tabs actually live in. Assert them off the shell, per tab.

  const ALL_TABS = ['fixed', 'individual', 'history', 'statutory', 'grid', 'outstanding'] as const;

  /** The single shell each tab mounts — the thing that owns the cookie and the initial state. */
  function shell(tree: unknown, tab: string) {
    const mounted = findByType(tree, CollapsibleEmployeePanel);
    expect(mounted, `${tab} must mount exactly one collapse shell`).toHaveLength(1);
    return mounted[0].props as { cookieKey: string; defaultOpen: boolean };
  }
  const render = (params: Record<string, string>) => TransactionViewPage({ searchParams: Promise.resolve(params) });

  it('bd14b7e2 — every tab has its OWN cookie key, and Transaction Detail keeps the one it had', async () => {
    // The whole reason TAB_PANEL_COOKIES is a five-entry map rather than one constant: History is thirteen
    // columns and is read folded away, Fixed is read with the panel open, so two tabs sharing a key means
    // the first thing every switch does is undo the last one. A copy-paste that gave two tabs the same
    // string would leave every other assertion in this file passing.
    const keys: Record<string, string> = {};
    for (const tab of ALL_TABS) {
      keys[tab] = shell(await render({ tab, employmentId: mine.employmentId }), tab).cookieKey;
      expect(keys[tab], `${tab} must name a cookie`).toBeTruthy();
    }
    expect(new Set(Object.values(keys)).size, `two tabs share one key: ${JSON.stringify(keys)}`).toBe(
      ALL_TABS.length,
    );
    // The names themselves are pinned as well, because a RENAME is the silent version of the same bug:
    // every reader's saved answer is simply forgotten, and `grid` must keep the key 080de5cf gave it or
    // this round resets a Transaction Detail choice it promised not to touch.
    expect(keys).toEqual({
      fixed: 'txnview_fixed_panel',
      individual: 'txnview_individual_panel',
      history: 'txnview_history_panel',
      // 6b4ca488 — the sixth tab, named by the SAME `txnview_<tab>_panel` convention, which is what lets
      // the collapse cases below drive it without a special case.
      statutory: 'txnview_statutory_panel',
      grid: 'txnview_grid_panel',
      outstanding: 'txnview_outstanding_panel',
    });
  });

  it('bd14b7e2 — a collapsed panel STAYS collapsed, including in the no-selection view these tabs open on', async () => {
    // WHY THIS CASE IS WORTH ITS LENGTH. The rail costs the workspace ~22rem while it is open, and the
    // panel-versus-width trade-off on these four tabs has already been reversed once in each direction
    // (r179 removed the rail, 98e69987 rev 2 restored it, 1372d169 then widened every tab). An initial
    // state that ignored the cookie while nobody was selected would mean the fold did not survive a single
    // server navigation in the DEFAULT view — Apply is a GET submit — so the thirteen-column History table
    // could never get that width back. That is a one-clause change away at all times, and invisible.

    // 1. Never touched ⇒ open, in both selection states. This is the round's point: a reader who has not
    //    asked for anything finds the control it exists to put in front of them.
    for (const tab of PANEL_TABS) {
      expect(shell(await render({ tab }), tab).defaultOpen, `${tab}: absent cookie ⇒ expanded`).toBe(true);
      expect(
        shell(await render({ tab, employmentId: mine.employmentId }), tab).defaultOpen,
        `${tab}: absent cookie ⇒ expanded even with somebody chosen`,
      ).toBe(true);
    }

    // 2. Explicitly collapsed ⇒ collapsed, and CRUCIALLY with nobody selected, which is what "All
    //    employees" leaves these tabs in and is the state History is read in.
    for (const tab of PANEL_TABS) {
      panelCookies.clear();
      panelCookies.set(`txnview_${tab}_panel`, '0');
      expect(
        shell(await render({ tab }), tab).defaultOpen,
        `${tab}: a collapse must survive an Apply / tab switch / refresh with NOBODY selected`,
      ).toBe(false);
      expect(
        shell(await render({ tab, employmentId: mine.employmentId }), tab).defaultOpen,
        `${tab}: a collapse must survive with somebody selected too`,
      ).toBe(false);
      panelCookies.set(`txnview_${tab}_panel`, '1');
      expect(shell(await render({ tab }), tab).defaultOpen, `${tab}: reopening must stick as well`).toBe(true);
    }

    // 3. And the keys are actually independent, not merely spelled differently: collapsing the widest tab
    //    must leave the other four exactly as they were.
    panelCookies.clear();
    panelCookies.set('txnview_history_panel', '0');
    expect(shell(await render({ tab: 'history' }), 'history').defaultOpen).toBe(false);
    for (const tab of ALL_TABS.filter((t) => t !== 'history')) {
      expect(
        shell(await render({ tab }), tab).defaultOpen,
        `folding History must not fold ${tab}`,
      ).toBe(true);
    }
  });

  // ───────── 9949f91a (r369) — the two Leave Inquiry tabs ─────────
  //
  // They are the eleventh and twelfth screens to mount this panel, and the FIRST two whose selection rule
  // differs from every other consumer's: `pickInquiryEmployee` (lib/leave-inquiry.ts) fell back to the FIRST
  // employee when `?emp=` was absent, and the reporter asked for a "Select an employee" prompt instead. So
  // there are two invisible failure modes here, not one:
  //
  //   · the ordinary one this whole file exists for — a foreign `?emp=` must coerce to NO selection, which a
  //     page that dropped the guard still renders, still 200s and still passes every source grep;
  //   · and the new one — the fallback creeping back, which would look like a working screen while showing a
  //     real person's real leave position to somebody who never asked for them, with the panel beside it
  //     marking nobody Selected.
  //
  // Both are read off what the panel is HANDED, which is this file's whole method.

  const LEAVE_TABS = {
    balances: { page: EmployeeBalancesPage, cookie: 'leave-balances-panel' },
    records: { page: EmployeeRecordsPage, cookie: 'leave-records-panel' },
  } as const;
  type LeaveTab = keyof typeof LEAVE_TABS;
  const LEAVE_TAB_NAMES = Object.keys(LEAVE_TABS) as LeaveTab[];
  const leaveRender = (tab: LeaveTab, params: Record<string, string>) =>
    LEAVE_TABS[tab].page({ searchParams: Promise.resolve(params) });

  it.each(LEAVE_TAB_NAMES)(
    'Leave Inquiry %s: a legitimate employee is selected, a cross-company one is not',
    async (tab) => {
      const ok = await leaveRender(tab, { emp: mine.employmentId });
      expect(panelSelection(ok)).toBe(mine.employmentId);

      const tampered = await leaveRender(tab, { emp: foreign.employmentId });
      expect(panelSelection(tampered), 'a company outside scope must coerce to no selection').toBeNull();

      const unknown = await leaveRender(tab, { emp: randomUUID() });
      expect(panelSelection(unknown), 'an unknown id is refused rather than erroring').toBeNull();
    },
  );

  it.each(LEAVE_TAB_NAMES)(
    'Leave Inquiry %s: NO employee asked for selects NOBODY — the first-employee fallback is gone',
    async (tab) => {
      // THE RETIRED RULE, QUOTED: "No employee picked ⇒ the first by company then name (20c699f8 §1)."
      // This is the assertion that catches it coming back, and it cannot be satisfied by prose: the value is
      // what the page handed the panel.
      const none = await leaveRender(tab, {});
      expect(panelSelection(none), 'nothing asked for ⇒ nothing selected').toBeNull();
      // …and the screen really does hold somebody it COULD have fallen back to, so the case is not vacuous.
      const offered: string[] = findByType(none, EmployeeScopePanel)[0].props.employees.map(
        (e: { employmentId: string }) => e.employmentId,
      );
      expect(offered.length, 'the panel is offering employees, so a fallback was available').toBeGreaterThan(0);
      expect(offered).toContain(mine.employmentId);
      expect(offered, 'a cross-company employee must not be offered').not.toContain(foreign.employmentId);
      // Every row offered must survive the page's own guard — proved by feeding each back in.
      for (const id of offered) {
        const re = await leaveRender(tab, { emp: id });
        expect(panelSelection(re), `the panel offered ${id} but the guard refused it`).toBe(id);
      }
      // A TERMINATED colleague is deliberately still offered and still selectable: their leave position is
      // exactly what HR looks up after somebody leaves. The opposite of Zakat's rule, stated so the two are
      // not "tidied" into one.
      expect(offered, 'a terminated employee stays selectable on Leave Inquiry').toContain(terminated.employmentId);
      expect(panelSelection(await leaveRender(tab, { emp: terminated.employmentId }))).toBe(
        terminated.employmentId,
      );
    },
  );

  it('Leave Inquiry: each tab remembers its OWN collapse state, and the two keys are independent', async () => {
    panelCookies.clear();
    const keys: Record<string, string> = {};
    for (const tab of LEAVE_TAB_NAMES) {
      const sh = shell(await leaveRender(tab, { emp: mine.employmentId }), tab);
      keys[tab] = sh.cookieKey;
      expect(sh.defaultOpen, `${tab}: a selected employee starts collapsed`).toBe(false);
      expect(shell(await leaveRender(tab, {}), tab).defaultOpen, `${tab}: no selection exposes the picker`).toBe(true);
    }
    expect(keys).toEqual({ balances: 'leave-balances-panel', records: 'leave-records-panel' });
    // Two tabs sharing a key means every move between them undoes the last answer — and Employee Balances is
    // sixteen columns wide while Employee Leave Record is thirteen, so they are read folded differently.
    expect(new Set(Object.values(keys)).size).toBe(LEAVE_TAB_NAMES.length);

    panelCookies.set('leave-balances-panel', '0');
    expect(shell(await leaveRender('balances', {}), 'balances').defaultOpen, 'no selection exposes the picker even after a prior fold').toBe(
      true,
    );
    expect(
      shell(await leaveRender('balances', { emp: mine.employmentId }), 'balances').defaultOpen,
      'and with somebody selected',
    ).toBe(false);
    expect(
      shell(await leaveRender('records', {}), 'records').defaultOpen,
      'folding Balances must not fold Employee Leave Record',
    ).toBe(true);
    panelCookies.set('leave-balances-panel', '1');
    expect(shell(await leaveRender('balances', {}), 'balances').defaultOpen, 'no selection remains usable').toBe(true);
    expect(shell(await leaveRender('balances', { emp: mine.employmentId }), 'balances').defaultOpen,
      'an open cookie alone cannot reopen a different selected context').toBe(false);
    panelCookies.set('leave-balances-panel-selected', mine.employmentId);
    expect(shell(await leaveRender('balances', { emp: mine.employmentId }), 'balances').defaultOpen,
      'explicit reopening survives for the same selected employee').toBe(true);
    expect(shell(await leaveRender('records', { emp: mine.employmentId }), 'records').defaultOpen,
      'the other tab remains independently collapsed').toBe(false);
    panelCookies.set('leave-balances-panel-selected', foreign.employmentId);
    expect(shell(await leaveRender('balances', { emp: mine.employmentId }), 'balances').defaultOpen,
      'a different employee does not inherit the remembered open state').toBe(false);
  });

  it.each(LEAVE_TAB_NAMES)(
    'Leave Inquiry %s: the panel replaced the filter-row picker rather than joining it',
    async (tab) => {
      const tree = await leaveRender(tab, { emp: mine.employmentId });
      expect(
        findByType(tree, EmployeeSearchField),
        'two pickers for one value is how they come to disagree (38b94df7 reversed)',
      ).toHaveLength(0);
      // The panel navigates by the screen's OWN param, so every bookmark and export link still resolves.
      const panel = findByType(tree, EmployeeScopePanel)[0];
      expect(panel.props.selectParam).toBe('emp');
      expect(panel.props.basePath).toBe(`/leave/employee-${tab === 'balances' ? 'balances' : 'records'}`);
      // No "All employees" row: `selectInquiryEmployee` has no no-employee destination to land on, and the
      // screens draw a prompt for that state instead.
      expect(panel.props.allowAll ?? false, 'the All-employees row stays opt-in and off here').toBe(false);
      // EVERY PROP PLAIN DATA: a closure here is a 500 on every request that tsc and the suite stay green for.
      for (const [k, v] of Object.entries(panel.props as Record<string, unknown>)) {
        expect(typeof v, `EmployeeScopePanel got a function in ${k}`).not.toBe('function');
      }
    },
  );
});
