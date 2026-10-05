import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
const session = vi.hoisted(() => ({ value: null as unknown }));
vi.mock('@/lib/authz', () => ({ requireAdmin: vi.fn(async () => session.value) }));
vi.mock('next/headers', () => ({ cookies: vi.fn(async () => ({ get: () => undefined })) }));
vi.mock('next-intl/server', () => ({ getTranslations: vi.fn(async () => (key: string) => key) }));
import * as schema from '../db/schema';
import { adminCtx, closeAll, migrateTestDb, owner, resetDb, seedBase, type Base } from './harness';
import { hireEmployee } from '../core/org';
import { createLoan, listLoansPage, listAppliedLoanRepaymentsPage } from '../core/loans';
import { createBatch } from '../packs/payroll/service';
import LoansPage from '../app/admin/loans/page';
import { LoanList } from '../components/loan-list';
import { AppliedInPayrollList } from '../components/applied-in-payroll-list';
import { EmployeeScopePanel } from '../components/collapsible-employee-panel';

function component(tree: unknown, type: unknown): { props: Record<string, any> } { // eslint-disable-line @typescript-eslint/no-explicit-any
  if (Array.isArray(tree)) {
    for (const child of tree) { try { return component(child, type); } catch { /* next child */ } }
  } else if (tree && typeof tree === 'object') {
    const element = tree as { type: unknown; props?: Record<string, unknown> };
    if (element.type === type) return element as ReturnType<typeof component>;
    for (const child of Object.values(element.props ?? {})) { try { return component(child, type); } catch { /* next prop */ } }
  }
  throw new Error('component not found');
}
const cycleLabels = { regular: 'Monthly payroll', off_cycle: 'Off cycle', bonus: 'Bonus', adjustment: 'Adjustment' };

describe('Loans server pages over the complete scoped population', () => {
  let base: Base;
  let foreign: Base;
  const ids: string[] = [];
  const loans: string[] = [];
  let otherCompany: string;
  let otherEmploymentId: string;
  let foreignLoan: string;
  beforeAll(async () => {
    await migrateTestDb(); await resetDb(); base = await seedBase(); foreign = await seedBase();
    session.value = adminCtx(base);
    const batch = await createBatch(adminCtx(base), { companyId: base.companyId, payPeriod: '2026-05' });
    // More than a page, with the unique searched/ended employee deliberately beyond the first 25.
    for (let i = 0; i < 31; i++) {
      const employee = await hireEmployee(adminCtx(base), { person: { fullName: `Worker ${String(i).padStart(2, '0')}`, primaryEmail: `worker${i}@loans.test` }, companyId: base.companyId, departmentId: base.deptA, employmentType: 'full_time', hiredOn: '2026-01-01' });
      ids.push(employee.employmentId);
      const loan = await createLoan(adminCtx(base), { employmentId: employee.employmentId, loanType: 'personal', principal: 100 + i, interestRate: 0, interestMethod: 'none', durationMonths: 1, startDate: '2026-01-01', notes: i === 30 ? 'Literal 100%_special' : undefined });
      loans.push(loan.id);
      await owner.db.update(schema.loanRepayment).set({ status: 'applied', appliedBatchId: batch.batchId, appliedAmount: String(40 + i), appliedAt: new Date('2026-05-25T00:00:00Z') }).where(eq(schema.loanRepayment.loanId, loan.id));
    }
    await owner.db.update(schema.employment).set({ terminatedOn: '2026-04-30' }).where(eq(schema.employment.id, ids[30]));
    const [co] = await owner.db.insert(schema.company).values({ tenantId: base.tenantId, legalName: 'Other company' }).returning();
    otherCompany = co.id;
    const [dep] = await owner.db.insert(schema.department).values({ tenantId: base.tenantId, companyId: co.id, name: 'Other department' }).returning();
    const otherEmp = await hireEmployee(adminCtx(base), { person: { fullName: 'Other Company Worker', primaryEmail: 'other@loans.test' }, companyId: co.id, departmentId: dep.id, employmentType: 'full_time', hiredOn: '2026-01-01' });
    otherEmploymentId = otherEmp.employmentId;
    await createLoan(adminCtx(base), { employmentId: otherEmp.employmentId, loanType: 'personal', principal: 9999, interestRate: 0, interestMethod: 'none', durationMonths: 1, startDate: '2026-01-01' });
    const foreignEmp = await hireEmployee(adminCtx(foreign), { person: { fullName: 'Foreign Secret', primaryEmail: 'foreign@loans.test' }, companyId: foreign.companyId, departmentId: foreign.deptA, employmentType: 'full_time', hiredOn: '2026-01-01' });
    foreignLoan = (await createLoan(adminCtx(foreign), { employmentId: foreignEmp.employmentId, loanType: 'personal', principal: 99999, interestRate: 0, interestMethod: 'none', durationMonths: 1, startDate: '2026-01-01' })).id;
  }, 60_000);
  afterAll(closeAll);

  it('returns non-overlapping pages and global counts, with monetary sort before LIMIT', async () => {
    const p = { companyIds: [base.companyId], sort: 'principal', dir: 'desc' };
    const first = await listLoansPage(adminCtx(base), p);
    const next = await listLoansPage(adminCtx(base), { ...p, page: '1' });
    expect(first.rows).toHaveLength(25); expect(next.rows).toHaveLength(6);
    expect(first.state.total).toBe(31); expect(next.state.total).toBe(31);
    expect(first.rows[0].principal).toBe(130); expect(next.rows[0].principal).toBe(105);
    expect(new Set([...first.rows, ...next.rows].map((row) => row.id)).size).toBe(31);
    expect(next.state.from).toBe(26); expect(next.state.to).toBe(31);
  });
  it('searches beyond the initial page and treats SQL wildcards literally', async () => {
    for (const query of ['Worker 30', '100%_special', '130']) {
      const page = await listLoansPage(adminCtx(base), { companyIds: [base.companyId], query });
      expect(page.rows.map((row) => row.id)).toEqual([loans[30]]); expect(page.state.total).toBe(1);
    }
    expect((await listLoansPage(adminCtx(base), { companyIds: [base.companyId], query: '%' })).state.total).toBe(1);
  });
  it('enforces explicit company scope, tenant RLS, empty scope and employee narrowing before counting', async () => {
    const all = await listLoansPage(adminCtx(base), { companyIds: [base.companyId, foreign.companyId], size: 'all' });
    expect(all.state.total).toBe(31); expect(all.rows.map((row) => row.id)).not.toContain(foreignLoan);
    expect((await listLoansPage(adminCtx(base), { companyIds: [], size: 'all' })).state.total).toBe(0);
    expect((await listLoansPage(adminCtx(base), { companyIds: [otherCompany], employmentId: ids[30] })).state.total).toBe(0);
    const selected = await listLoansPage(adminCtx(base), { companyIds: [base.companyId], employmentId: ids[30] });
    expect(selected.rows.map((row) => row.id)).toEqual([loans[30]]);
    await expect(listLoansPage({ ...adminCtx(base), roles: ['employee'] }, { companyIds: [base.companyId] })).rejects.toThrow('administrator');
  });
  it('pages actual applied amounts and searches translated cycles across the full history', async () => {
    const p = { companyIds: [base.companyId], cycleLabels, sort: 'amount', dir: 'desc' };
    const first = await listAppliedLoanRepaymentsPage(adminCtx(base), p);
    const next = await listAppliedLoanRepaymentsPage(adminCtx(base), { ...p, page: '1' });
    expect(first.rows).toHaveLength(25); expect(next.rows).toHaveLength(6); expect(first.state.total).toBe(31);
    expect(first.rows[0].amount).toBe('70.00'); expect(next.rows[0].amount).toBe('45.00');
    expect(new Set([...first.rows, ...next.rows].map((row) => row.id)).size).toBe(31);
    expect((await listAppliedLoanRepaymentsPage(adminCtx(base), { ...p, query: 'Monthly payroll' })).state.total).toBe(31);
    expect((await listAppliedLoanRepaymentsPage(adminCtx(base), { ...p, query: 'Worker 30' })).rows.map((r) => r.employmentId)).toEqual([ids[30]]);
    expect((await listAppliedLoanRepaymentsPage(adminCtx(foreign), { ...p })).state.total).toBe(0);
    expect((await listAppliedLoanRepaymentsPage(adminCtx(base), { ...p, companyIds: [] })).state.total).toBe(0);
  });
  it('server page serializes bounded tables/picker and resolves an ended selection beyond its first results', async () => {
    const initial = await LoansPage({ searchParams: Promise.resolve({}) });
    expect(component(initial, LoanList).props.loans).toHaveLength(25);
    expect(component(initial, LoanList).props.serverPage.state.total).toBe(32);
    expect(component(initial, AppliedInPayrollList).props.rows).toHaveLength(25);
    expect(component(initial, EmployeeScopePanel).props.employees).toHaveLength(25);
    expect(component(initial, EmployeeScopePanel).props.employees.map((e: {employmentId:string}) => e.employmentId)).not.toContain(ids[30]);
    const selected = await LoansPage({ searchParams: Promise.resolve({ employmentId: ids[30], pickerQ: 'Worker 30', pickerStatus: 'ended' }) });
    const panel = component(selected, EmployeeScopePanel).props;
    expect(panel.selectedId).toBe(ids[30]); expect(panel.employees.map((e: {employmentId:string}) => e.employmentId)).toEqual([ids[30]]);
    expect(component(selected, LoanList).props.loans.map((r: {id:string}) => r.id)).toEqual([loans[30]]);
    expect(component(selected, AppliedInPayrollList).props.serverPage.state.total).toBe(1);
    const unknown = await LoansPage({ searchParams: Promise.resolve({ employmentId: randomUUID() }) });
    expect(component(unknown, EmployeeScopePanel).props.selectedId).toBeNull();
    expect(component(unknown, LoanList).props.serverPage.state.total).toBe(32);
  });
  it('preserves archived-company employee lookup without broadening the existing live-company loan book', async () => {
    await owner.db.update(schema.company).set({ archivedAt: new Date() }).where(eq(schema.company.id, otherCompany));
    try {
      const tree = await LoansPage({ searchParams: Promise.resolve({ employmentId: otherEmploymentId, pickerQ: 'Other Company Worker' }) });
      expect(component(tree, EmployeeScopePanel).props.selectedId).toBe(otherEmploymentId);
      expect(component(tree, EmployeeScopePanel).props.employees.map((e: {employmentId:string}) => e.employmentId)).toEqual([otherEmploymentId]);
      expect(component(tree, LoanList).props.serverPage.state.total).toBe(0);
    } finally { await owner.db.update(schema.company).set({ archivedAt: null }).where(eq(schema.company.id, otherCompany)); }
  });

});
