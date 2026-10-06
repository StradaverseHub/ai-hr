/**
 * 4fffe638 (r392) — a Fixed Transaction links to a CONFIGURED Payroll Cycle (Payroll > Settings > Payroll
 * Cycles), not just a run-type label.
 *
 * What is pinned, and why each matters:
 *  - Add with "Mid-Month" in a company that ALSO has "Off-cycle" and "Advance Salary" (three off_cycle
 *    cycles) stores THAT cycle's id and every reader shows "Mid-Month". Resolving by run type instead would
 *    pick whichever off_cycle row came first and the NAME assertion is what catches it.
 *  - Another company's cycle, an inactive cycle, and a non-existent id are refused with a typed error and
 *    nothing is written.
 *  - The Edit screen offers exactly the employee's company's ACTIVE cycles; none from another company.
 *  - An edit that does not touch the cycle keeps the cycle and run type the row had — even though the
 *    select is always submitted (CLAUDE.md §8) and even when that cycle has since been made inactive. A
 *    touched edit moves both.
 *  - The 0514 backfill's one-match rule, by count AND by id, and re-runnable.
 *  - KERNEL PARITY: a row linked to the Bonus cycle pays the same on a REGULAR run as an unlinked row.
 *    core/payroll.ts does not read the link and this round does not change it.
 *  - The import links under the same one-match rule, and the delete guard refuses a cycle referenced only
 *    by a fixed transaction with a typed error instead of a raw foreign-key failure.
 */
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const { redirect, scope } = vi.hoisted(() => ({
  redirect: vi.fn((_url: string) => undefined),
  scope: { s: null as unknown, scopeIds: [] as string[] },
}));
vi.mock('next/navigation', () => ({
  redirect,
  notFound: () => {
    throw new Error('NEXT_NOT_FOUND');
  },
}));
vi.mock('next/cache', () => ({ revalidatePath: vi.fn(() => undefined), revalidateTag: vi.fn(() => undefined) }));
vi.mock('@/lib/scope', () => ({ scopedAdmin: vi.fn(async () => scope) }));
// Keys, not sentences: an assertion names the key the screen uses, with its values appended.
vi.mock('next-intl/server', () => ({
  getTranslations: async () => (k: string, v?: Record<string, unknown>) => (v ? `${k}:${JSON.stringify(v)}` : k),
  getLocale: async () => 'en',
}));
vi.mock('next-intl', () => ({
  useTranslations: () => (k: string) => k,
  useLocale: () => 'en',
}));

import { renderToStaticMarkup } from 'react-dom/server';
import * as schema from '../db/schema';
import type { SessionContext } from '../db/client';
import { hireEmployee } from '../core/org';
import { setCompensation } from '../core/comp';
import { setStatutoryProfileMY } from '../localization/my/statutory';
import { createBatch, generatePayslips } from '../core/payroll';
import {
  FixedTransactionCycleError,
  getEmploymentPayComponent,
  listEmploymentPayComponents,
  listPayComponents,
  seedPayComponentCatalog,
  setEmploymentPayComponent,
} from '../core/pay-components';
import {
  PayrollCycleInUseError,
  deletePayrollCycle,
  seedPayrollCycleCatalog,
  setPayrollCycleActive,
  upsertPayrollCycle,
} from '../core/payroll-cycle';
import { listFixedTransactionsAcross } from '../core/payroll-view';
import { commitTxnImport, type TxnImportRecord } from '../core/payroll-txn-import';
import { createFixedTransactionAction, updateFixedTransactionAction } from '../app/payroll/transactions/fixed/actions';
import FixedTransactionDetailPage from '../app/payroll/transactions/fixed/[id]/page';
import { adminCtx, closeAll, entitledCtx, migrateTestDb, owner, resetDb, seedBase, setModule, type Base } from './harness';

const ROOT = path.resolve(__dirname, '..');
const MIGRATION = path.join(ROOT, 'db', 'migrations', '0514_fixed_transaction_payroll_cycle.sql');

const fd = (o: Record<string, string>) => {
  const f = new FormData();
  for (const [k, v] of Object.entries(o)) f.set(k, v);
  return f;
};

let base: Base;
let companyB: string;
let deptB: string;

async function codeId(ctx: SessionContext, code: string): Promise<string> {
  return (await listPayComponents(ctx)).find((c) => c.code === code)!.id;
}

/** company → cycle name → id, read as the owner. */
async function cyclesOf(companyId: string): Promise<Record<string, string>> {
  const rows = await owner.db
    .select({ id: schema.payrollCycle.id, name: schema.payrollCycle.name })
    .from(schema.payrollCycle)
    .where(eq(schema.payrollCycle.companyId, companyId));
  return Object.fromEntries(rows.map((r) => [r.name, r.id]));
}

const hire = (ctx: SessionContext, name: string, companyId = base.companyId, departmentId = base.deptA, hiredOn = '2026-01-01') =>
  hireEmployee(ctx, {
    person: { fullName: name, primaryEmail: `${name.toLowerCase().replace(/\s+/g, '')}${randomUUID().slice(0, 6)}@acme.test` },
    companyId,
    departmentId,
    employmentType: 'full_time',
    hiredOn,
  });

/** All non-superseded rows for an employment, oldest first (owner read). */
async function liveRows(employmentId: string) {
  return owner.db
    .select()
    .from(schema.employmentPayComponent)
    .where(
      and(
        eq(schema.employmentPayComponent.employmentId, employmentId),
        sql`${schema.employmentPayComponent.supersededAt} IS NULL`,
      ),
    )
    .orderBy(schema.employmentPayComponent.validFrom);
}

beforeAll(async () => {
  await migrateTestDb();
});
beforeEach(async () => {
  await resetDb();
  base = await seedBase();
  const [c] = await owner.db
    .insert(schema.company)
    .values({ tenantId: base.tenantId, legalName: 'Beta Sdn Bhd' })
    .returning({ id: schema.company.id });
  companyB = c.id;
  const [d] = await owner.db
    .insert(schema.department)
    .values({ tenantId: base.tenantId, companyId: companyB, name: 'Beta Ops' })
    .returning({ id: schema.department.id });
  deptB = d.id;
  const a = adminCtx(base);
  await seedPayComponentCatalog(a);
  // Both companies get the default six: Monthly, Bonus, Off-cycle, Adjustment, Advance Salary, Mid-Month
  // — three of them off_cycle.
  await seedPayrollCycleCatalog(a, base.companyId);
  await seedPayrollCycleCatalog(a, companyB);
  redirect.mockClear();
  scope.s = a;
  scope.scopeIds = [base.companyId, companyB];
});
afterAll(async () => {
  await closeAll();
});

describe('4fffe638 — Add links the exact configured cycle', () => {
  it('Add with Mid-Month (beside Off-cycle and Advance Salary) stores THAT id, and the list and Transaction View show "Mid-Month"', async () => {
    const a = adminCtx(base);
    const emp = await hire(a, 'Mid Month');
    const cyc = await cyclesOf(base.companyId);
    // The premise: three off_cycle cycles in this company, so a run-type lookup is ambiguous.
    const offCycle = await owner.db
      .select({ id: schema.payrollCycle.id })
      .from(schema.payrollCycle)
      .where(and(eq(schema.payrollCycle.companyId, base.companyId), eq(schema.payrollCycle.runType, 'off_cycle')));
    expect(offCycle.length).toBe(3);

    await createFixedTransactionAction(
      fd({
        employmentId: emp.employmentId,
        componentId: await codeId(a, 'ALLOWANCE'),
        payrollCycleId: cyc['Mid-Month'],
        amount: '150',
        effectiveFrom: '2026-01-01',
      }),
    );
    expect(redirect).toHaveBeenCalledWith(expect.stringContaining('toast=saved'));

    const rows = await liveRows(emp.employmentId);
    expect(rows).toHaveLength(1);
    expect(rows[0].payrollCycleId).toBe(cyc['Mid-Month']);
    // The run type comes from the cycle row, not from the client (nothing posted one).
    expect(rows[0].runType).toBe('off_cycle');

    const list = await listEmploymentPayComponents(a, emp.employmentId);
    expect(list.map((r) => r.payrollCycleName)).toEqual(['Mid-Month']);
    const view = await listFixedTransactionsAcross(a, { companyIds: [base.companyId], employmentId: emp.employmentId });
    expect(view.map((r) => r.payrollCycleName)).toEqual(['Mid-Month']);
  });

  it('refuses another company\'s cycle, an inactive cycle and an unknown id — typed error, nothing written', async () => {
    const a = adminCtx(base);
    const emp = await hire(a, 'Refused');
    const allow = await codeId(a, 'ALLOWANCE');
    const mine = await cyclesOf(base.companyId);
    const theirs = await cyclesOf(companyB);
    await setPayrollCycleActive(a, { id: mine['Advance Salary'], active: false });

    const attempt = (payrollCycleId: string) =>
      setEmploymentPayComponent(a, { employmentId: emp.employmentId, componentId: allow, amount: 100, effectiveFrom: '2026-01-01', payrollCycleId });

    const other = await attempt(theirs['Mid-Month']).catch((e) => e);
    expect(other).toBeInstanceOf(FixedTransactionCycleError);
    expect((other as FixedTransactionCycleError).reason).toBe('company_mismatch');
    const archived = await attempt(mine['Advance Salary']).catch((e) => e);
    expect(archived).toBeInstanceOf(FixedTransactionCycleError);
    expect((archived as FixedTransactionCycleError).reason).toBe('archived');
    const missing = await attempt(randomUUID()).catch((e) => e);
    expect(missing).toBeInstanceOf(FixedTransactionCycleError);
    expect((missing as FixedTransactionCycleError).reason).toBe('not_found');

    expect(await liveRows(emp.employmentId)).toHaveLength(0);

    // And the action maps it to the localised key rather than raw English.
    await createFixedTransactionAction(
      fd({ employmentId: emp.employmentId, componentId: allow, payrollCycleId: theirs['Monthly'], amount: '100', effectiveFrom: '2026-01-01' }),
    );
    expect(redirect).toHaveBeenCalledWith(expect.stringContaining('error=cycleInvalid'));
    expect(await liveRows(emp.employmentId)).toHaveLength(0);
  });

  it('the people-detail editor path (no cycle sent) still writes an unlinked, untagged row', async () => {
    const a = adminCtx(base);
    const emp = await hire(a, 'Personnel Path');
    await setEmploymentPayComponent(a, { employmentId: emp.employmentId, componentId: await codeId(a, 'ALLOWANCE'), amount: 100, effectiveFrom: '2026-01-01' });
    const [row] = await liveRows(emp.employmentId);
    expect(row.payrollCycleId).toBeNull();
    expect(row.runType).toBeNull();
  });
});

describe('4fffe638 — the Edit screen and the untouched-edit rule', () => {
  const render = async (id: string, employmentId: string) =>
    renderToStaticMarkup(
      (await FixedTransactionDetailPage({
        params: Promise.resolve({ id }),
        searchParams: Promise.resolve({ employmentId }),
      })) as never,
    );
  /** The <option>s of the payrollCycleId select, as [value, label, selected]. */
  const cycleOptions = (html: string) => {
    const m = html.match(/<select[^>]*name="payrollCycleId"[^>]*>([\s\S]*?)<\/select>/);
    expect(m, 'the payrollCycleId select is rendered').not.toBeNull();
    return [...m![1].matchAll(/<option([^>]*)value="([^"]*)"([^>]*)>([^<]*)<\/option>/g)].map((o) => ({
      value: o[2],
      label: o[4],
      selected: /selected/.test(o[1] + o[3]),
    }));
  };

  it('offers exactly the employee\'s company\'s ACTIVE cycles, in order, none from another company', async () => {
    const a = adminCtx(base);
    const emp = await hire(a, 'Options');
    const mine = await cyclesOf(base.companyId);
    const theirs = await cyclesOf(companyB);
    await setPayrollCycleActive(a, { id: mine['Adjustment'], active: false });
    const { id } = await setEmploymentPayComponent(a, {
      employmentId: emp.employmentId, componentId: await codeId(a, 'ALLOWANCE'), amount: 100, effectiveFrom: '2026-01-01', payrollCycleId: mine['Monthly'],
    });

    const opts = cycleOptions(await render(id, emp.employmentId)).filter((o) => o.value !== '');
    const expected = await owner.db
      .select({ id: schema.payrollCycle.id })
      .from(schema.payrollCycle)
      .where(and(eq(schema.payrollCycle.companyId, base.companyId), sql`${schema.payrollCycle.archivedAt} IS NULL`))
      .orderBy(schema.payrollCycle.sortOrder, schema.payrollCycle.name);
    expect(expected.length).toBeGreaterThanOrEqual(2);
    expect(opts.map((o) => o.value)).toEqual(expected.map((r) => r.id));
    expect(opts.map((o) => o.value)).not.toContain(mine['Adjustment']);
    for (const foreign of Object.values(theirs)) expect(opts.map((o) => o.value)).not.toContain(foreign);
    expect(opts.find((o) => o.selected)?.value).toBe(mine['Monthly']);
    expect(opts.find((o) => o.selected)?.label).toBe('Monthly');
  });

  it('an UNTOUCHED edit keeps cycle and run type although the select posts another id; a TOUCHED edit moves both', async () => {
    const a = adminCtx(base);
    const emp = await hire(a, 'Untouched');
    const cyc = await cyclesOf(base.companyId);
    const { id } = await setEmploymentPayComponent(a, {
      employmentId: emp.employmentId, componentId: await codeId(a, 'ALLOWANCE'), amount: 100, effectiveFrom: '2026-01-01', payrollCycleId: cyc['Mid-Month'],
    });

    // The select is always submitted; here it carries Bonus, but the flag says the operator never touched it.
    await updateFixedTransactionAction(
      fd({ employmentId: emp.employmentId, id, amount: '200', effectiveFrom: '2026-03-01', payrollCycleId: cyc['Bonus'], cycleTouched: '0' }),
    );
    expect(redirect).toHaveBeenLastCalledWith(expect.stringContaining('toast=saved'));
    let rows = await liveRows(emp.employmentId);
    expect(rows.map((r) => [r.validFrom, r.amount, r.payrollCycleId, r.runType])).toEqual([
      ['2026-01-01', '100.00', cyc['Mid-Month'], 'off_cycle'],
      ['2026-03-01', '200.00', cyc['Mid-Month'], 'off_cycle'],
    ]);

    await updateFixedTransactionAction(
      fd({ employmentId: emp.employmentId, id: rows[1].id, amount: '200', effectiveFrom: '2026-05-01', payrollCycleId: cyc['Bonus'], cycleTouched: '1' }),
    );
    rows = await liveRows(emp.employmentId);
    expect(rows.map((r) => [r.validFrom, r.payrollCycleId, r.runType])).toEqual([
      ['2026-01-01', cyc['Mid-Month'], 'off_cycle'],
      ['2026-03-01', cyc['Mid-Month'], 'off_cycle'],
      ['2026-05-01', cyc['Bonus'], 'bonus'],
    ]);
  });

  it('a row linked to a cycle since made INACTIVE shows it selected and marked inactive, and an untouched save keeps it', async () => {
    const a = adminCtx(base);
    const emp = await hire(a, 'Inactive Kept');
    const cyc = await cyclesOf(base.companyId);
    const { id } = await setEmploymentPayComponent(a, {
      employmentId: emp.employmentId, componentId: await codeId(a, 'ALLOWANCE'), amount: 100, effectiveFrom: '2026-01-01', payrollCycleId: cyc['Mid-Month'],
    });
    await setPayrollCycleActive(a, { id: cyc['Mid-Month'], active: false });

    const sel = cycleOptions(await render(id, emp.employmentId)).find((o) => o.selected);
    expect(sel?.value).toBe(cyc['Mid-Month']);
    expect(sel?.label).toContain('fixed.cycleInactive');
    expect(sel?.label).toContain('Mid-Month');

    await updateFixedTransactionAction(
      fd({ employmentId: emp.employmentId, id, amount: '300', effectiveFrom: '2026-02-01', payrollCycleId: cyc['Mid-Month'], cycleTouched: '0' }),
    );
    const rows = await liveRows(emp.employmentId);
    expect(rows.map((r) => [r.validFrom, r.payrollCycleId])).toEqual([
      ['2026-01-01', cyc['Mid-Month']],
      ['2026-02-01', cyc['Mid-Month']],
    ]);
    // The read model still names it.
    expect((await getEmploymentPayComponent(a, { id: rows[1].id, employmentId: emp.employmentId }))?.payrollCycleName).toBe('Mid-Month');
  });
});

describe('4fffe638 — the 0514 backfill (one-match rule)', () => {
  /** The backfill statement exactly as the migration ships it: everything after the last breakpoint. */
  const backfillSql = () => {
    const src = fs.readFileSync(MIGRATION, 'utf8');
    const parts = src.split('--> statement-breakpoint');
    const stmt = parts[parts.length - 1];
    expect(stmt).toContain('UPDATE "employment_pay_component"');
    expect(stmt.length).toBeGreaterThan(200);
    return stmt;
  };

  it('links every regular row and an off_cycle row with ONE active match; leaves the ambiguous off_cycle row and the null row alone; re-runnable', async () => {
    const a = adminCtx(base);
    const allow = await codeId(a, 'ALLOWANCE');
    const housing = await codeId(a, 'HOUSING');
    const mine = await cyclesOf(base.companyId);
    const theirs = await cyclesOf(companyB);
    // Company B is left with ONE active off_cycle cycle, so its off_cycle row is unambiguous.
    await setPayrollCycleActive(a, { id: theirs['Advance Salary'], active: false });
    await setPayrollCycleActive(a, { id: theirs['Mid-Month'], active: false });

    const eA1 = await hire(a, 'Backfill A1');
    const eA2 = await hire(a, 'Backfill A2');
    const eA3 = await hire(a, 'Backfill A3');
    const eB1 = await hire(a, 'Backfill B1', companyB, deptB);
    const raw = async (employmentId: string, componentId: string, runType: 'regular' | 'off_cycle' | null, supersededAt: Date | null = null) => {
      const [r] = await owner.db
        .insert(schema.employmentPayComponent)
        .values({ tenantId: base.tenantId, employmentId, componentId, amount: '100', validFrom: '2026-01-01', runType, supersededAt })
        .returning({ id: schema.employmentPayComponent.id });
      return r.id;
    };
    const regularLive = await raw(eA1.employmentId, allow, 'regular');
    const regularSuperseded = await raw(eA1.employmentId, housing, 'regular', new Date());
    const ambiguousOff = await raw(eA2.employmentId, allow, 'off_cycle');
    const untagged = await raw(eA3.employmentId, allow, null);
    const oneMatchOff = await raw(eB1.employmentId, allow, 'off_cycle');

    const run = () => owner.db.execute(sql.raw(backfillSql()));
    const read = async () =>
      Object.fromEntries(
        (
          await owner.db
            .select({ id: schema.employmentPayComponent.id, c: schema.employmentPayComponent.payrollCycleId })
            .from(schema.employmentPayComponent)
            .where(inArray(schema.employmentPayComponent.id, [regularLive, regularSuperseded, ambiguousOff, untagged, oneMatchOff]))
        ).map((r) => [r.id, r.c]),
      );

    await run();
    const after = await read();
    expect(after).toEqual({
      [regularLive]: mine['Monthly'],
      [regularSuperseded]: mine['Monthly'],
      [ambiguousOff]: null,
      [untagged]: null,
      [oneMatchOff]: theirs['Off-cycle'],
    });
    expect(Object.values(after).filter((v) => v != null)).toHaveLength(3);

    await run();
    expect(await read()).toEqual(after);
  });
});

describe('4fffe638 — kernel parity: the link does not route pay', () => {
  it('a fixed row linked to the BONUS cycle pays on a REGULAR run exactly what an unlinked row pays', async () => {
    const a = adminCtx(base);
    const cyc = await cyclesOf(base.companyId);
    const basicId = await codeId(a, 'BASIC');
    const allowId = await codeId(a, 'ALLOWANCE');
    const make = async (name: string, ic: string, payrollCycleId: string | null) => {
      const e = await hire(a, name);
      await setCompensation(a, { employmentId: e.employmentId, basicSalary: 3000, monthlyAllowance: 0, effectiveFrom: '2026-01-01' });
      await setStatutoryProfileMY(a, { personId: e.personId, icNumber: ic });
      await setEmploymentPayComponent(a, { employmentId: e.employmentId, componentId: basicId, amount: 3000, effectiveFrom: '2026-01-01' });
      await setEmploymentPayComponent(a, {
        employmentId: e.employmentId, componentId: allowId, amount: 450, effectiveFrom: '2026-01-01', prorateOverride: false, payrollCycleId,
      });
      return e.employmentId;
    };
    const linked = await make('Parity Linked', '900101011234', cyc['Bonus']);
    const unlinked = await make('Parity Plain', '900202022345', null);
    expect((await liveRows(linked)).find((r) => r.componentId === allowId)?.runType).toBe('bonus');

    await setModule(base.tenantId, 'typed_pay_components', 'active');
    const on = await entitledCtx(base);
    const { batchId } = await createBatch(on, { companyId: base.companyId, payPeriod: '2026-05' });
    await generatePayslips(on, { batchId });
    const slips = await owner.db.select().from(schema.payslip).where(eq(schema.payslip.batchId, batchId));
    const L = slips.find((p) => p.employmentId === linked)!;
    const U = slips.find((p) => p.employmentId === unlinked)!;
    // Paid at all (not two equal zeros), and paid identically.
    expect(L.allowance).toBe('450.00');
    expect(L.allowance).toBe(U.allowance);
    expect(L.grossPay).toBe(U.grossPay);
  });
});

describe('4fffe638 — import one-match rule and the delete guard', () => {
  it('the import links regular → Monthly and leaves an ambiguous off_cycle row unlinked (run type kept)', async () => {
    const a = adminCtx(base);
    const cyc = await cyclesOf(base.companyId);
    const e1 = await hire(a, 'Import Regular');
    const e2 = await hire(a, 'Import Off');
    const codeOf = async (employmentId: string) =>
      (await owner.db.select({ c: schema.employment.employeeCode }).from(schema.employment).where(eq(schema.employment.id, employmentId)))[0].c ?? '';
    const rec = (employee_id: string, payroll_cycle: string): TxnImportRecord => ({
      employee_id, employee_name: '', pay_item_code: 'ALLOWANCE', pay_item: '', amount: '100', payroll_cycle,
      start_date: '2026-08-01', end_date: '', remarks: '',
    });
    const res = await commitTxnImport(a, {
      kind: 'fixed',
      scopeIds: [base.companyId],
      records: [rec(await codeOf(e1.employmentId), 'regular'), rec(await codeOf(e2.employmentId), 'off_cycle')],
    });
    expect(res.failed).toEqual([]);
    expect(res.written).toBe(2);
    const [r1] = await liveRows(e1.employmentId);
    const [r2] = await liveRows(e2.employmentId);
    expect([r1.payrollCycleId, r1.runType]).toEqual([cyc['Monthly'], 'regular']);
    expect([r2.payrollCycleId, r2.runType]).toEqual([null, 'off_cycle']);
  });

  it('refuses to delete a cycle referenced ONLY by a fixed transaction (typed in-use error); deletes it once unreferenced', async () => {
    const a = adminCtx(base);
    const emp = await hire(a, 'Delete Guard');
    const { id: cycleId } = await upsertPayrollCycle(a, { companyId: base.companyId, name: 'Quarterly Bonus', runType: 'bonus' });
    // No run of any kind exists, so the batch half of the guard counts zero.
    expect((await owner.db.select().from(schema.payrollBatch).where(eq(schema.payrollBatch.companyId, base.companyId)))).toHaveLength(0);
    const { id: rowId } = await setEmploymentPayComponent(a, {
      employmentId: emp.employmentId, componentId: await codeId(a, 'ALLOWANCE'), amount: 100, effectiveFrom: '2026-01-01', payrollCycleId: cycleId,
    });

    const err = await deletePayrollCycle(a, cycleId).catch((e) => e);
    expect(err).toBeInstanceOf(PayrollCycleInUseError);
    expect((err as PayrollCycleInUseError).by).toBe('transactions');
    expect((err as PayrollCycleInUseError).refs).toBe(1);
    expect(await cyclesOf(base.companyId)).toHaveProperty('Quarterly Bonus', cycleId);

    // Control: once nothing links to it, the same delete succeeds.
    await owner.db.delete(schema.employmentPayComponent).where(eq(schema.employmentPayComponent.id, rowId));
    await expect(deletePayrollCycle(a, cycleId)).resolves.toEqual({ id: cycleId });
  });
});
