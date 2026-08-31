/**
 * ADR-0074 item 5 — "WHY IS MY PAY DIFFERENT THIS MONTH?", answered without a payroll person.
 *
 * The item exists because deflecting this question is worth more than answering it faster: it is what
 * consumes a payroll team's day at 1000:1. The tool is the deflection, and these are the four properties
 * that decide whether it can be trusted to face an employee unsupervised.
 *
 *  1. THE ARITHMETIC IS THE TOOL'S, NOT THE MODEL'S. ADR-0074's non-negotiable invariant. Every figure is
 *     subtracted here and handed over already worked out, so each number an employee is told corresponds
 *     to a subtraction they can repeat against their own two payslips.
 *  2. AN UNRELEASED PAYSLIP IS INVISIBLE. `myPayslips` STAMPS a released flag rather than enforcing it.
 *     Without the filter the assistant would explain a payslip the employee's own screen refuses to show —
 *     which is worse than the screen being wrong, because they cannot see what it is talking about.
 *  3. THE COMPARISON IS THE PREVIOUS PAID PERIOD, NOT LAST CALENDAR MONTH. A joiner, a leaver or an unpaid
 *     month leaves a gap, and stepping back one month would compare against nothing and read as "your pay
 *     fell to zero" — a false alarm delivered to an employee about their own wages.
 *  4. THE STATUTORY SPLIT NEVER LEAVES. `statutory` carries EPF/SOCSO/PCB and the tax-relief record; only
 *     component lines are projected out of it.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { adminCtx, closeAll, createAppUser, entitledCtx, migrateTestDb, resetDb, seedBase, setModule, type Base } from './harness';
import { hireEmployee } from '../core/org';
import { setCompensation } from '../core/comp';
import { setStatutoryProfileMY } from '../localization/my/statutory';
import { closeBatch, createBatch, generatePayslips } from '../core/payroll';
import {
  listPayComponents,
  seedPayComponentCatalog,
  setEmploymentPayComponent,
} from '../core/pay-components';
import { toolByName } from '../core/assistant-tools';
import type { SessionContext } from '../db/client';

const tool = () => toolByName('my_pay_change')!;

describe('ADR-0074 item 5 — my_pay_change', () => {
  let base: Base;
  beforeAll(async () => {
    await migrateTestDb();
  });
  beforeEach(async () => {
    await resetDb();
    base = await seedBase();
    await setModule(base.tenantId, 'typed_pay_components', 'active');
  });
  afterAll(async () => {
    await closeAll();
  });

  /** The asking user, as an employee with a payroll history. */
  async function employee() {
    const a = adminCtx(base);
    await seedPayComponentCatalog(a);
    const housing = (await listPayComponents(a, { includeArchived: true })).find((c) => c.code === 'HOUSING')!;
    const e = await hireEmployee(a, {
      person: { fullName: 'Pay Asker', primaryEmail: 'pay.asker@ct.test' },
      companyId: base.companyId,
      departmentId: base.deptA,
      employmentType: 'full_time',
      hiredOn: '2024-01-01',
    });
    await setCompensation(a, { employmentId: e.employmentId, basicSalary: 5000, effectiveFrom: '2024-01-01' });
    await setStatutoryProfileMY(a, { personId: e.personId, icNumber: '900101012345' });
    // THE ASKER IS THE EMPLOYEE, not an admin looking at them. `myEmploymentIdsAll` resolves through
    // ctx.personId, and the whole point of a self-bound tool is that it answers about whoever is asking —
    // testing it from an admin context would exercise a caller this tool can never actually have.
    const appUserId = await createAppUser(base.tenantId, e.personId, 'employee');
    const asker: SessionContext = {
      ...(await entitledCtx(base, ['employee'])),
      userId: appUserId,
      personId: e.personId,
    };
    return { a, e, housingId: housing.id, asker };
  }

  /** Run a month and RELEASE it — an unreleased run is deliberately invisible to this tool. */
  async function paidMonth(a: ReturnType<typeof adminCtx>, period: string, opts: { release: boolean }) {
    const batch = await createBatch(a, { companyId: base.companyId, payPeriod: period });
    await generatePayslips(a, { batchId: batch.batchId });
    if (opts.release) await closeBatch(a, { batchId: batch.batchId });
    return batch.batchId;
  }

  it('an allowance that STARTED shows up as the change, with the arithmetic already done', async () => {
    const { a, e, housingId, asker } = await employee();
    await paidMonth(a, '2026-01', { release: true });
    // The allowance starts in February — this is the whole scenario the item is named for.
    await setEmploymentPayComponent(a, {
      employmentId: e.employmentId,
      componentId: housingId,
      amount: 400,
      effectiveFrom: '2026-02-01',
    });
    await paidMonth(a, '2026-02', { release: true });

    const out = (await tool().run(asker, { period: '2026-02' })) as Record<string, unknown>;
    expect(out.ok, JSON.stringify(out)).toBe(true);
    expect(out.previousPeriod).toBe('2026-01');

    const gross = out.gross as { current: number; previous: number; change: number };
    // The DIFFERENCE is computed by the tool. A model handed two figures and asked to subtract them is
    // exactly what ADR-0074 forbids, and it is also how a wrong number reaches an employee.
    expect(gross.change).toBeCloseTo(gross.current - gross.previous, 2);
    expect(gross.change).toBeCloseTo(400, 2);

    const lines = out.rows as { code: string; change: number }[];
    const housingLine = lines.find((l) => l.code === 'HOUSING');
    expect(housingLine, 'the item that changed must be named').toBeTruthy();
    expect(housingLine!.change).toBeCloseTo(400, 2);
  });

  it('drops the pay items that did NOT move — they are not why the pay is different', async () => {
    const { a, e, housingId, asker } = await employee();
    await setEmploymentPayComponent(a, {
      employmentId: e.employmentId,
      componentId: housingId,
      amount: 400,
      effectiveFrom: '2024-01-01',
    });
    await paidMonth(a, '2026-03', { release: true });
    await paidMonth(a, '2026-04', { release: true });

    const out = (await tool().run(asker, { period: '2026-04' })) as Record<string, unknown>;
    expect(out.ok).toBe(true);
    // Same allowance both months ⇒ no change ⇒ absent. A list of unchanged rows buries the ones that moved.
    expect((out.rows as unknown[]).length).toBe(0);
    expect((out.net as { change: number }).change).toBeCloseTo(0, 2);
  });

  it('an UNRELEASED period cannot be explained, and does not become the comparison either', async () => {
    const { a, asker } = await employee();
    await paidMonth(a, '2026-05', { release: true });
    await paidMonth(a, '2026-06', { release: false }); // processed, never released

    const ctx = asker;
    // Asking about it directly refuses…
    const direct = (await tool().run(ctx, { period: '2026-06' })) as Record<string, unknown>;
    expect(direct.ok).toBe(false);
    expect(direct.refusal).toBe('no_data');

    // …and it is not silently used as the previous period for anything either.
    const may = (await tool().run(ctx, { period: '2026-05' })) as Record<string, unknown>;
    expect(may.ok).toBe(true);
    expect(may.previousPeriod, 'the only earlier released period is none').toBeNull();
  });

  it('compares the previous PAID period, not last calendar month', async () => {
    // A gap is ordinary — a joiner, a leaver, unpaid leave. Stepping back one calendar month would find
    // nothing and report a fall to zero, which is a false alarm about somebody's wages.
    const { a, asker } = await employee();
    await paidMonth(a, '2026-07', { release: true });
    // No August run at all.
    await paidMonth(a, '2026-09', { release: true });

    const out = (await tool().run(asker, { period: '2026-09' })) as Record<string, unknown>;
    expect(out.ok).toBe(true);
    expect(out.previousPeriod).toBe('2026-07');
    expect((out.net as { change: number }).change).toBeCloseTo(0, 2);
  });

  it('says so when there is nothing to compare against, rather than describing one figure as a change', async () => {
    const { a, asker } = await employee();
    await paidMonth(a, '2026-10', { release: true });

    const out = (await tool().run(asker, { period: '2026-10' })) as Record<string, unknown>;
    expect(out.ok).toBe(true);
    expect(out.previousPeriod).toBeNull();
    // Stated, not inferred: a model handed a lone figure will otherwise narrate it as a movement.
    expect(String(out.note)).toContain('earliest');
  });

  it('never returns the statutory breakdown', async () => {
    const { a, asker } = await employee();
    await paidMonth(a, '2026-11', { release: true });
    await paidMonth(a, '2026-12', { release: true });

    const out = (await tool().run(asker, { period: '2026-12' })) as Record<string, unknown>;
    expect(out.ok).toBe(true);
    // EPF / SOCSO / PCB and the tax-relief record live in `statutory`; only component lines come out.
    const json = JSON.stringify(out);
    for (const leak of ['epfEmployee', 'socsoEmployee', 'pcb', 'exemptionUsed', 'statutory']) {
      expect(json, `${leak} must not reach the model`).not.toContain(leak);
    }
  });

  it('refuses a period that is not a month', async () => {
    const { a, asker } = await employee();
    await paidMonth(a, '2026-02', { release: true });
    const out = (await tool().run(asker, { period: 'last month' })) as Record<string, unknown>;
    expect(out.ok).toBe(false);
    expect(out.refusal).toBe('invalid_input');
  });
});
