/**
 * 6a1f2bd6 (Zakat) + 6d72816e (Loans) — "pick a person, see THEIR records, and nothing opens by itself."
 *
 * WHY THIS FILE EXISTS BESIDE test/employee-scope-panel-guard.test.ts. That file proves the SERVER still
 * refuses what it always refused: an `?employmentId=` it does not recognise selects nobody. It cannot prove
 * the complaint that came back on the re-plan, which was not about refusal at all:
 *
 *   "The moment you pick somebody, the setup form springs open on its own, before you have asked for
 *    anything. And the two lists underneath still show everyone."
 *
 * Both halves passed tsc, the suite and `next build`, and both returned 200. The narrowing bug was one
 * argument — `listZakatElections` was called with the whole company scope, and the applied-in-payroll list
 * was filtered by a SEPARATE dropdown that ignored the panel — so a source grep for `EmployeeScopePanel`
 * said nothing at all about whether picking somebody changed what was shown.
 *
 * SO THE ASSERTIONS ARE ON WHAT THE SCREEN DECIDED, NOT ON ITS SOURCE TEXT. Each page is rendered as a
 * server component and the list islands are pulled out of the returned tree by identity, so the rows under
 * test are the exact rows that reach the table. Two employees are seeded with a zakat setup EACH, a zakat
 * deduction EACH on the same processed run, and a loan EACH with an applied instalment — so "narrowed to
 * one person" is a claim that can fail, which it could not with a single-employee fixture.
 *
 * THE ABSENCE ASSERTIONS ARE THE REPORTER'S ACTUAL WORDS. Selecting somebody must leave NO editing form on
 * either list screen: no `<form>` bound to a server action on Zakat, and no LoanNewForm anywhere on Loans.
 * Both are stated as absence-in-the-rendered-tree rather than as a grep, because a form moved behind a
 * conditional still greps.
 *
 * (What the rows LOOK like once the tables have them is test/applied-in-payroll-list.dom.test.tsx — jsdom
 * cannot reach Postgres in this project split, so the two halves are proved in the two places they can be.)
 */
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const { scope } = vi.hoisted(() => ({ scope: { s: null as unknown, scopeIds: [] as string[] } }));
vi.mock('next/cache', () => ({ revalidatePath: vi.fn(() => undefined), revalidateTag: vi.fn(() => undefined) }));
// notFound() THROWS in Next, and a page that keeps executing past it would read a null employee and crash
// with a TypeError instead — which would pass a naive `expect(...).rejects` for entirely the wrong reason.
// So the stub throws a sentinel the assertions match on by name.
vi.mock('next/navigation', () => ({
  redirect: vi.fn(() => undefined),
  notFound: vi.fn(() => {
    throw new Error('NEXT_NOT_FOUND');
  }),
}));
vi.mock('@/lib/scope', () => ({ scopedAdmin: vi.fn(async () => scope) }));
vi.mock('@/lib/authz', () => ({ requireAdmin: vi.fn(async () => scope.s) }));
vi.mock('next/headers', () => ({ cookies: vi.fn(async () => ({ get: () => undefined })) }));
vi.mock('next-intl/server', () => ({ getTranslations: vi.fn(async () => (k: string) => k) }));

import * as schema from '../db/schema';
import type { SessionContext } from '../db/client';
import { adminCtx, closeAll, migrateTestDb, owner, resetDb, seedBase, type Base } from './harness';
import { hireEmployee } from '../core/org';
import { setCompensation } from '../core/comp';
import { setStatutoryProfileMY } from '../localization/my/statutory';
import { createBatch, generatePayslips } from '../core/payroll';
import { createLoan } from '../core/loans';
import { exportZakatTxnsCsv } from '../core/payroll-view';
import { AppliedInPayrollList } from '../components/applied-in-payroll-list';
import { LoanList } from '../components/loan-list';
import { LoanNewForm } from '../components/loan-new-form';
import { ZakatElectionsList } from '../app/payroll/transactions/zakat/elections-list';
import ZakatTransactionPage from '../app/payroll/transactions/zakat/page';
import ZakatElectionPage from '../app/payroll/transactions/zakat/election/page';
import LoansPage from '../app/admin/loans/page';
import NewLoanPage from '../app/admin/loans/new/page';
import LoanDetailPage from '../app/admin/loans/[id]/page';

/* eslint-disable @typescript-eslint/no-explicit-any */

/** Every React element in a rendered tree, descending through EVERY element-valued prop (not just
 *  `children`): the panel arrives as a `panel` prop and the Add control as a `<Button asChild>` child, so a
 *  children-only walk would miss exactly the things under test. */
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
/** Forms bound to a SERVER ACTION — i.e. forms that write. The GET filter form carries no `action`. */
const writingForms = (tree: unknown): any[] =>
  walk(tree).filter((e) => e.type === 'form' && typeof e.props?.action === 'function');

const hire = (ctx: SessionContext, b: Base, name: string, email: string) =>
  hireEmployee(ctx, {
    person: { fullName: name, primaryEmail: email },
    companyId: b.companyId,
    departmentId: b.deptA,
    employmentType: 'full_time',
    hiredOn: '2026-01-01',
  });

describe('6a1f2bd6 + 6d72816e — selecting an employee narrows the lists and opens nothing', () => {
  let base: Base;
  let a: SessionContext;
  let aisha: { employmentId: string; personId: string };
  let bala: { employmentId: string; personId: string };
  let aishaLoanId: string;
  let balaLoanId: string;

  beforeAll(async () => {
    await migrateTestDb();
  });

  beforeEach(async () => {
    await resetDb();
    base = await seedBase();
    a = adminCtx(base);
    scope.s = a;
    scope.scopeIds = [base.companyId];

    // TWO people, each with a zakat setup, each with a zakat deduction on the same processed run, and each
    // with a loan carrying an applied instalment. One of anything would make "narrowed" unfalsifiable.
    aisha = await hire(a, base, 'Aisha Rahman', 'aisha@acme.test');
    bala = await hire(a, base, 'Bala Krishnan', 'bala@acme.test');
    for (const [e, ic] of [
      [aisha, '900101011234'],
      [bala, '900202021235'],
    ] as const) {
      await setCompensation(a, {
        employmentId: e.employmentId,
        basicSalary: 5000,
        monthlyAllowance: 0,
        effectiveFrom: '2026-01-01',
      });
      await setStatutoryProfileMY(a, {
        personId: e.personId,
        icNumber: ic,
        zakatActive: true,
        zakatMethod: 'fixed',
        zakatFixed: 100,
        zakatState: 'Selangor',
      });
    }

    const batch = await createBatch(a, { companyId: base.companyId, payPeriod: '2026-05' });
    await generatePayslips(a, { batchId: batch.batchId });

    // Loans are created AFTER generation so the run cannot reserve an instalment underneath the fixture;
    // instalment 1 is then stamped APPLIED against that same processed batch. What is under test is the
    // READ of loan_repayment, not the two-phase reserve→apply path (core/loans.ts owns that, with its own
    // tests) — the same reasoning employee-scope-panel-guard.test.ts uses to terminate an employment
    // directly on the row.
    for (const [e, ref] of [
      [aisha, 'aisha'],
      [bala, 'bala'],
    ] as const) {
      const loan = await createLoan(a, {
        employmentId: e.employmentId,
        loanType: 'personal',
        principal: 2400,
        interestRate: 0,
        interestMethod: 'none',
        durationMonths: 24,
        startDate: '2026-02-01',
      });
      if (ref === 'aisha') aishaLoanId = loan.id;
      else balaLoanId = loan.id;
      await owner.db
        .update(schema.loanRepayment)
        .set({
          status: 'applied',
          appliedBatchId: batch.batchId,
          appliedAmount: '100.00',
          appliedAt: new Date('2026-05-25T00:00:00Z'),
        })
        .where(and(eq(schema.loanRepayment.loanId, loan.id), eq(schema.loanRepayment.sequenceNo, 1)));
    }
  });

  afterAll(async () => {
    await closeAll();
  });

  // ───────────────────────────── Zakat ─────────────────────────────

  const zakatLists = async (searchParams: Record<string, string> = {}) => {
    const tree = await ZakatTransactionPage({ searchParams: Promise.resolve(searchParams) });
    const elections = byType(tree, ZakatElectionsList);
    const applied = byType(tree, AppliedInPayrollList);
    expect(elections, 'exactly one transaction-history list').toHaveLength(1);
    expect(applied, 'exactly one applied-in-payroll list').toHaveLength(1);
    return {
      tree,
      history: elections[0].props.rows as { employmentId: string; employeeName: string }[],
      applied: applied[0].props.rows as { employeeName: string }[],
    };
  };

  it('Zakat: with nobody selected BOTH lists still show everyone (the everyone-at-once view is not gated)', async () => {
    const { history, applied } = await zakatLists();
    expect(history.map((r) => r.employmentId).sort()).toEqual([aisha.employmentId, bala.employmentId].sort());
    expect(applied.map((r) => r.employeeName).sort()).toEqual(['Aisha Rahman', 'Bala Krishnan']);
  });

  it('Zakat: with an employee selected NEITHER list contains anybody else', async () => {
    // The defect this pins: `listZakatElections` took only companyIds, so the history list showed every
    // employee with a setup no matter who was highlighted, and the applied list obeyed a separate dropdown.
    const { history, applied } = await zakatLists({ employmentId: aisha.employmentId });
    expect(history.map((r) => r.employmentId)).toEqual([aisha.employmentId]);
    expect(applied.map((r) => r.employeeName)).toEqual(['Aisha Rahman']);
    expect(JSON.stringify([history, applied])).not.toContain('Bala');
  });

  it('Zakat: selecting an employee opens NO form — it offers one button that goes to the editor', async () => {
    const { tree } = await zakatLists({ employmentId: aisha.employmentId });
    expect(writingForms(tree), 'picking somebody must not open the election editor').toEqual([]);
    const toEditor = hrefsIn(tree).filter((h) => h.startsWith('/payroll/transactions/zakat/election'));
    expect(toEditor).toEqual([`/payroll/transactions/zakat/election?employmentId=${aisha.employmentId}`]);
  });

  it('Zakat: an out-of-scope ?employmentId= selects nobody AND leaves the everyone view intact', async () => {
    // Degrading to an EMPTY list would read as "this person has no zakat", which is a different and worse
    // lie than "that link was wrong".
    const { history, applied } = await zakatLists({ employmentId: randomUUID() });
    expect(history.map((r) => r.employmentId).sort()).toEqual([aisha.employmentId, bala.employmentId].sort());
    expect(applied).toHaveLength(2);
  });

  it('Zakat: the CSV export carries the SAME employee filter as the list it sits above', async () => {
    const { tree, applied } = await zakatLists({ employmentId: aisha.employmentId });
    const exportHref = hrefsIn(tree).find((h) => h.startsWith('/payroll/transactions/zakat/history-export'))!;
    expect(exportHref, 'the applied list must still offer its export').toBeTruthy();
    const q = new URLSearchParams(exportHref.split('?')[1] ?? '');
    // The panel selection has to reach the export, not just the on-screen table: before this the export
    // read `hEmploymentId` only, so exporting a narrowed list handed back everybody's rows.
    expect(q.get('hEmploymentId')).toBe(aisha.employmentId);
    const file = await exportZakatTxnsCsv(a, { companyIds: scope.scopeIds, employmentId: q.get('hEmploymentId')! });
    expect(file.rowCount).toBe(applied.length);
    expect(file.content).not.toContain('Bala');
  });

  it('Zakat election page: refuses an employment this admin cannot see, and fixes the employee it can', async () => {
    await expect(
      ZakatElectionPage({ searchParams: Promise.resolve({ employmentId: randomUUID() }) }),
    ).rejects.toThrow('NEXT_NOT_FOUND');
    await expect(ZakatElectionPage({ searchParams: Promise.resolve({}) })).rejects.toThrow('NEXT_NOT_FOUND');

    const ok = await ZakatElectionPage({ searchParams: Promise.resolve({ employmentId: aisha.employmentId }) });
    const forms = writingForms(ok);
    expect(forms, 'the editor lives HERE now — exactly one saving form').toHaveLength(1);
    // The employee is carried as a hidden field, not chosen: the page cannot retarget the save.
    const hidden = walk(ok).filter((e) => e.type === 'input' && e.props?.type === 'hidden');
    expect(hidden.find((h) => h.props.name === 'employmentId')?.props.value).toBe(aisha.employmentId);
    expect(hidden.find((h) => h.props.name === 'personId')?.props.value).toBe(aisha.personId);
  });

  // ───────────────────────────── Loans ─────────────────────────────

  const loanLists = async (searchParams: Record<string, string> = {}) => {
    const tree = await LoansPage({ searchParams: Promise.resolve(searchParams) });
    const lists = byType(tree, LoanList);
    const applied = byType(tree, AppliedInPayrollList);
    expect(lists, 'exactly one loan list').toHaveLength(1);
    expect(applied, 'exactly one applied-in-payroll list').toHaveLength(1);
    return {
      tree,
      loans: lists[0].props.loans as { id: string; employmentId: string; employeeName?: string }[],
      applied: applied[0].props.rows as { employeeName: string }[],
    };
  };

  it('Loans: with nobody selected BOTH lists still show every loan and every applied instalment', async () => {
    const { loans, applied } = await loanLists();
    expect(loans.map((l) => l.id).sort()).toEqual([aishaLoanId, balaLoanId].sort());
    expect(applied.map((r) => r.employeeName).sort()).toEqual(['Aisha Rahman', 'Bala Krishnan']);
  });

  it('Loans: with an employee selected NEITHER list contains anybody else', async () => {
    const { loans, applied } = await loanLists({ employmentId: aisha.employmentId });
    expect(loans.map((l) => l.id)).toEqual([aishaLoanId]);
    expect(applied.map((r) => r.employeeName)).toEqual(['Aisha Rahman']);
  });

  it('Loans: the new-loan form is GONE from the list screen, selected or not', async () => {
    // THE complaint. loan-new-form.tsx used to render unconditionally at the bottom of this page with its
    // own employee dropdown, so the screen carried two employee controls that could disagree and looking at
    // somebody's loans presented a form to create one.
    for (const params of [{}, { employmentId: aisha.employmentId }] as Record<string, string>[]) {
      const { tree } = await loanLists(params);
      expect(byType(tree, LoanNewForm), 'nothing is created until Add is pressed').toEqual([]);
      expect(writingForms(tree)).toEqual([]);
    }
    const { tree } = await loanLists({ employmentId: aisha.employmentId });
    expect(hrefsIn(tree)).toContain(`/admin/loans/new?employmentId=${aisha.employmentId}`);
  });

  it('Loans: the Add button needs an employee — no selection, no Add link', async () => {
    const { tree } = await loanLists();
    expect(hrefsIn(tree).filter((h) => h.startsWith('/admin/loans/new'))).toEqual([]);
  });

  it('New loan page: refuses an employment it cannot resolve, and fixes the one it can', async () => {
    await expect(NewLoanPage({ searchParams: Promise.resolve({ employmentId: randomUUID() }) })).rejects.toThrow(
      'NEXT_NOT_FOUND',
    );
    await expect(NewLoanPage({ searchParams: Promise.resolve({}) })).rejects.toThrow('NEXT_NOT_FOUND');

    const ok = await NewLoanPage({ searchParams: Promise.resolve({ employmentId: aisha.employmentId }) });
    const forms = byType(ok, LoanNewForm);
    expect(forms).toHaveLength(1);
    expect(forms[0].props.employmentId).toBe(aisha.employmentId);
    expect(forms[0].props.cancelHref).toBe(`/admin/loans?employmentId=${aisha.employmentId}`);
  });

  it('New loan page: refuses a TERMINATED employment — there is no future run to deduct from', async () => {
    await owner.db
      .update(schema.employment)
      .set({ terminatedOn: '2026-04-30' })
      .where(eq(schema.employment.id, bala.employmentId));
    await expect(
      NewLoanPage({ searchParams: Promise.resolve({ employmentId: bala.employmentId }) }),
    ).rejects.toThrow('NEXT_NOT_FOUND');
  });

  it('Loan detail page: a real loan id under the WRONG employee is a 404, not a cross-employee read', async () => {
    // The tamper this refuses: both ids are legitimate on their own, and matching on the id alone would
    // have rendered Bala's loan under Aisha's name with her employment on every action form.
    await expect(
      LoanDetailPage({
        params: Promise.resolve({ id: balaLoanId }),
        searchParams: Promise.resolve({ employmentId: aisha.employmentId }),
      }),
    ).rejects.toThrow('NEXT_NOT_FOUND');
    await expect(
      LoanDetailPage({
        params: Promise.resolve({ id: aishaLoanId }),
        searchParams: Promise.resolve({}),
      }),
    ).rejects.toThrow('NEXT_NOT_FOUND');
    await expect(
      LoanDetailPage({
        params: Promise.resolve({ id: randomUUID() }),
        searchParams: Promise.resolve({ employmentId: aisha.employmentId }),
      }),
    ).rejects.toThrow('NEXT_NOT_FOUND');
  });

  it('Loan detail page: the matching pair renders the schedule and the actions, each carrying the loan id', async () => {
    const ok = await LoanDetailPage({
      params: Promise.resolve({ id: aishaLoanId }),
      searchParams: Promise.resolve({ employmentId: aisha.employmentId }),
    });
    const forms = writingForms(ok);
    // amend + suspend + settle (cancel is gone: one instalment has already been deducted).
    expect(forms.length).toBeGreaterThanOrEqual(3);
    const hidden = walk(ok).filter((e) => e.type === 'input' && e.props?.type === 'hidden');
    expect(new Set(hidden.filter((h) => h.props.name === 'loanId').map((h) => h.props.value))).toEqual(
      new Set([aishaLoanId]),
    );
    // Every action returns to the list the operator came from, not to the everyone view.
    expect(new Set(hidden.filter((h) => h.props.name === 'returnEmploymentId').map((h) => h.props.value))).toEqual(
      new Set([aisha.employmentId]),
    );
    // Cancel is refused once an instalment has been taken — the service refuses it and the page must not
    // offer it. 24 scheduled rows, one of them applied.
    expect(walk(ok).filter((e) => e.type === 'tr').length).toBeGreaterThan(20);
  });
});

/**
 * The Zakat screen is a MULTI-NAMESPACE file (`payroll.transactions` + `payroll.list`), and check C of
 * test/i18n-coverage.test.ts skips those ENTIRELY — static keys included. So the Add / Edit button caption
 * and the "showing everyone" line it gained here are unguarded by that file: a typo in either would render
 * a raw key on the screen with a fully green suite and a 200 response. Pinned here, the same way
 * test/function-access.test.ts pins /admin/users for exactly this reason.
 *
 * The dynamic lookups (cycle, batch status) are unguarded EVERYWHERE by construction, so the two enum sets
 * the applied-in-payroll table reads are checked whole rather than key by key.
 */
describe('the Zakat screen’s static keys resolve, though the coverage check cannot see them', () => {
  const en = JSON.parse(readFileSync(new URL('../messages/en.json', import.meta.url), 'utf8'));
  const at = (dotted: string): unknown =>
    dotted.split('.').reduce<unknown>((o, k) => (o && typeof o === 'object' ? (o as any)[k] : undefined), en);

  it('every literal t() / tList() key on app/payroll/transactions/zakat/page.tsx exists in en.json', () => {
    const src = readFileSync(new URL('../app/payroll/transactions/zakat/page.tsx', import.meta.url), 'utf8');
    const missing: string[] = [];
    for (const m of src.matchAll(/\bt\(\s*'([a-zA-Z0-9_.]+)'/g)) {
      if (at(`payroll.transactions.${m[1]}`) === undefined) missing.push(`payroll.transactions.${m[1]}`);
    }
    for (const m of src.matchAll(/\btList\(\s*'([a-zA-Z0-9_.]+)'/g)) {
      if (at(`payroll.list.${m[1]}`) === undefined) missing.push(`payroll.list.${m[1]}`);
    }
    expect(missing, missing.join('\n')).toEqual([]);
  });

  it('the applied-in-payroll table can label every cycle and every batch status it can be handed', () => {
    // `loans` keeps its OWN copies so app/admin/loans/page.tsx stays single-namespace (which is what buys
    // it check-C coverage); the copies must not drift from the catalogs they were taken from.
    expect(Object.keys(at('loans.cycle') as object).sort()).toEqual(
      Object.keys(at('payroll.transactions.individual.cycle') as object).sort(),
    );
    for (const st of ['draft', 'processed', 'closed']) {
      expect(at(`loans.batchStatus.${st}`), `loans.batchStatus.${st}`).toBeTruthy();
      expect(at(`payroll.list.status.${st}`), `payroll.list.status.${st}`).toBeTruthy();
    }
  });
});
