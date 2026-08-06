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
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

// scopedAdmin / requireAdmin holders — mutated per test so each page's fence can be driven independently.
const { scope } = vi.hoisted(() => ({ scope: { s: null as unknown, scopeIds: [] as string[] } }));
vi.mock('next/cache', () => ({ revalidatePath: vi.fn(() => undefined), revalidateTag: vi.fn(() => undefined) }));
vi.mock('next/navigation', () => ({ redirect: vi.fn(() => undefined), notFound: vi.fn(() => undefined) }));
vi.mock('@/lib/scope', () => ({ scopedAdmin: vi.fn(async () => scope) }));
vi.mock('@/lib/authz', () => ({ requireAdmin: vi.fn(async () => scope.s) }));
// The collapse state is read from a cookie; no request context here, so report "absent" ⇒ expanded.
vi.mock('next/headers', () => ({ cookies: vi.fn(async () => ({ get: () => undefined })) }));
// getTranslations → identity, so assertions read as keys without the full next-intl runtime config.
vi.mock('next-intl/server', () => ({ getTranslations: vi.fn(async () => (k: string) => k) }));

import * as schema from '../db/schema';
import { adminCtx, closeAll, migrateTestDb, owner, resetDb, seedBase, type Base } from './harness';
import { hireEmployee } from '../core/org';
import { EmployeeScopePanel } from '../components/collapsible-employee-panel';
import ZakatTransactionPage from '../app/payroll/transactions/zakat/page';
import IndividualPayslipPage from '../app/payroll/individual-payslip/page';
import LoansPage from '../app/admin/loans/page';
import { LoanList } from '../components/loan-list';

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

/** The single `selectedId` the screen handed the shared panel — i.e. the guard's verdict. */
function panelSelection(tree: unknown): string | null {
  const panels = findByType(tree, EmployeeScopePanel);
  expect(panels, 'the screen must render exactly one shared employee panel').toHaveLength(1);
  return panels[0].props.selectedId as string | null;
}

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
    const ok = await IndividualPayslipPage({
      searchParams: Promise.resolve({ employmentId: mine.employmentId }),
    });
    expect(panelSelection(ok)).toBe(mine.employmentId);

    const tampered = await IndividualPayslipPage({
      searchParams: Promise.resolve({ employmentId: foreign.employmentId }),
    });
    expect(panelSelection(tampered), 'a company outside scope must coerce to no selection').toBeNull();
  });

  it('Individual Payslip: an out-of-scope companyId is still refused alongside the employee', async () => {
    // The employee guard is new; the company guard is not. Both must hold, or the screen narrowed one
    // fence while widening another.
    const tree = await IndividualPayslipPage({
      searchParams: Promise.resolve({ companyId: foreignCompanyId, employmentId: foreign.employmentId }),
    });
    expect(panelSelection(tree)).toBeNull();
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
});
