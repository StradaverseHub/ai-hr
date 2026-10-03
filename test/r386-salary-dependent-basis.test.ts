import { randomUUID } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { SessionContext } from '../db/client';
import * as schema from '../db/schema';
import { setCompensation } from '../core/comp';
import { hireEmployee } from '../core/org';
import { requirePackFor } from '../localization/registry';
import {
  backPayRunDetail, calculateBackPay, closeBatch, createBatch, deriveIndividualTxnAmount,
  detectArrears, generatePayslips, upsertPayComponent,
} from '../packs/payroll/service';
import { closeAll, entitledCtx, migrateTestDb, owner, resetDb, seedBase, type Base } from './harness';

describe('r386 dependent salary consumers and immutable saved selection basis', () => {
  let base: Base;
  let ctx: SessionContext;
  let ic = 890000;
  beforeAll(migrateTestDb);
  beforeEach(async () => { await resetDb(); base = await seedBase(); ctx = await entitledCtx(base); });
  afterAll(closeAll);

  async function salaryHistory() {
    const employee = await hireEmployee(ctx, {
      person: { fullName: 'Synthetic Salary Basis', primaryEmail: `${randomUUID()}@r386-basis.test` },
      companyId: base.companyId, departmentId: base.deptA, employmentType: 'full_time', hiredOn: '2026-08-01',
    });
    await requirePackFor('MY').statutory.set(ctx, { personId: employee.personId, icNumber: `900101${++ic}` });
    await setCompensation(ctx, { employmentId: employee.employmentId, basicSalary: 10000, effectiveFrom: '2026-08-01' });
    await setCompensation(ctx, { employmentId: employee.employmentId, basicSalary: 15000, effectiveFrom: '2026-11-01' });
    const history = await owner.db.select().from(schema.compensation)
      .where(eq(schema.compensation.employmentId, employee.employmentId)).orderBy(schema.compensation.validFrom);
    expect(history.map(row => [row.basicSalary, row.validFrom, row.validTo])).toEqual([
      ['10000.00', '2026-08-01', '2026-11-01'], ['15000.00', '2026-11-01', null],
    ]);
    return { employee, history };
  }

  async function slipOf(batchId: string) {
    const rows = await owner.db.select().from(schema.payslip).where(eq(schema.payslip.batchId, batchId));
    expect(rows).toHaveLength(1);
    return rows[0];
  }

  it('actual percentage transaction derivation follows its pay month, not the open future salary', async () => {
    const { employee } = await salaryHistory();
    await upsertPayComponent(ctx, { code: 'R386PCT', name: 'Synthetic Percentage', kind: 'allowance',
      includedInEpf: false, includedInSocsoEis: false, includedInPcb: true, includedInHrdfBase: false,
      isNonPayable: false, prorates: false, rule: { kind: 'formula', start: { ref: 'basic' }, terms: [{ op: '*', operand: { ref: 'number', value: 0.1 } }] } });
    const [component] = await owner.db.select().from(schema.payComponent)
      .where(and(eq(schema.payComponent.tenantId, base.tenantId), eq(schema.payComponent.code, 'R386PCT')));
    for (const [period, expected] of [['2026-08', 1000], ['2026-10', 1000], ['2026-11', 1500]] as const) {
      expect(await deriveIndividualTxnAmount(ctx, { componentId: component.id, employmentId: employee.employmentId,
        companyId: base.companyId, payPeriod: period, quantity: null, unit: null }))
        .toMatchObject({ derived: true, amount: expected, code: 'R386PCT', ruleKind: 'formula' });
    }
  });

  type StampVariant = 'valid' | 'legacy' | 'null' | 'empty' | 'version' | 'reference' | 'id' | 'future' | 'impossibleDate' | 'amount' | 'zero' | 'mode';

  async function paidAugust(variant: StampVariant) {
    const fixture = await salaryHistory();
    const { batchId } = await createBatch(ctx, { companyId: base.companyId, payPeriod: '2026-08' });
    await generatePayslips(ctx, { batchId });
    const generated = await slipOf(batchId);
    expect(generated.basicSalary).toBe('10000.00');
    const saved = generated.statutory as Record<string, unknown>;
    expect(saved.salaryBasis).toEqual({ version: 1, referenceDate: '2026-08-31',
      compensationId: fixture.history[0].id, effectiveFrom: '2026-08-01', basicSalary: '10000.00', payMode: 'monthly' });
    if (variant !== 'valid') {
      const statutory = { ...saved };
      const stamp = { ...(saved.salaryBasis as Record<string, unknown>) };
      if (variant === 'legacy') delete statutory.salaryBasis;
      else {
        const overrides: Record<string, unknown> = {
          null: null, empty: {}, version: { ...stamp, version: 2 },
          reference: { ...stamp, referenceDate: '2026-11-30' }, id: { ...stamp, compensationId: 'not-an-id' },
          future: { ...stamp, effectiveFrom: '2026-11-01' }, impossibleDate: { ...stamp, effectiveFrom: '2026-02-31' }, amount: { ...stamp, basicSalary: 'NaN' },
          zero: { ...stamp, basicSalary: '0.00' }, mode: { ...stamp, payMode: 'invalid-mode' },
        };
        statutory.salaryBasis = overrides[variant];
      }
      // Synthetic legacy/corruption fixture ONLY, before closing: production results are never mutated here.
      await owner.db.update(schema.payslip).set({ statutory }).where(eq(schema.payslip.id, generated.id));
    }
    await closeBatch(ctx, { batchId });
    const closed = await slipOf(batchId);
    expect(fixture.history.every(row => row.recordedAt.getTime() <= closed.createdAt.getTime()),
      'the future November salary must really have been visible when August was processed').toBe(true);
    return { ...fixture, batchId, closed };
  }

  async function appendBackdatedCorrection(fixture: Awaited<ReturnType<typeof paidAugust>>) {
    // The public salary writer appends after the current open revision. This synthetic SQL inserts a
    // middle historical correction while retaining November's future revision; it is fixture setup,
    // not a claim that the present salary form supports insertion between existing revisions.
    await owner.db.update(schema.compensation).set({ validTo: '2026-08-01' })
      .where(eq(schema.compensation.id, fixture.history[0].id));
    const [correction] = await owner.db.insert(schema.compensation).values({
      tenantId: base.tenantId, employmentId: fixture.employee.employmentId, basicSalary: '12000.00',
      monthlyAllowance: '0.00', payMode: 'monthly', paymentTerm: 'monthly', currency: 'MYR',
      validFrom: '2026-08-01', validTo: '2026-11-01',
      recordedAt: new Date(fixture.closed.createdAt.getTime() + 1000),
    }).returning();
    const detected = await detectArrears(ctx, { companyId: base.companyId });
    expect(detected).toHaveLength(1);
    expect(detected[0]).toMatchObject({ compensationId: correction.id, employmentId: fixture.employee.employmentId,
      newBasic: 12000, affectedPeriods: ['2026-08'] });
    return correction;
  }

  it('new saved effective salary baseline yields positive RM2000 arrears and leaves the closed result byte-identical', async () => {
    const fixture = await paidAugust('valid');
    const correction = await appendBackdatedCorrection(fixture);
    const result = await calculateBackPay(ctx, { companyId: base.companyId, targetPayPeriod: '2026-12', compensationIds: [correction.id] });
    expect(result.total).toBe(2000);
    const detail = await backPayRunDetail(ctx, result.runId);
    expect(detail!.rows).toHaveLength(1);
    expect(detail!.rows[0].byPeriod['2026-08']).toMatchObject({ old: 10000, new: 12000, diff: 2000 });
    expect(await slipOf(fixture.batchId)).toEqual(fixture.closed);
    expect((await slipOf(fixture.batchId)).statutory).toEqual(fixture.closed.statutory);
  });

  it('absent salaryBasis with a visible future baseline requires review without inventing a proration factor', async () => {
    const fixture = await paidAugust('legacy');
    expect(fixture.closed.statutory).not.toHaveProperty('salaryBasis');
    const visible = fixture.history.filter(row => row.recordedAt.getTime() <= fixture.closed.createdAt.getTime());
    expect(visible).toHaveLength(2);
    const legacyCandidate = [...visible].sort((left, right) => right.validFrom.localeCompare(left.validFrom))[0];
    expect(legacyCandidate).toMatchObject({ validFrom: '2026-11-01', basicSalary: '15000.00' });
    expect(legacyCandidate.validFrom > '2026-08-31').toBe(true);
    const correction = await appendBackdatedCorrection(fixture);
    const result = await calculateBackPay(ctx, { companyId: base.companyId, targetPayPeriod: '2026-12', compensationIds: [correction.id] });
    // Preserve the paid August result, but do not price NEW arrears from an uncertain future
    // denominator or silently infer an earlier salary input for an unstamped historical run.
    expect(result.lineCount).toBe(1);
    expect(result.total).toBe(0);
    const detail = await backPayRunDetail(ctx, result.runId);
    expect(detail!.rows).toHaveLength(1);
    expect(detail!.rows[0]).toMatchObject({ payCode: 'BASIC', needsReview: true, reviewReason: 'noBaselineSalary' });
    const [line] = await owner.db.select().from(schema.backPayLine).where(eq(schema.backPayLine.runId, result.runId));
    expect(line.newAmount).toBeNull();
    expect(line.difference).toBe('0.00');
    expect(await slipOf(fixture.batchId)).toEqual(fixture.closed);
    expect((await slipOf(fixture.batchId)).statutory).not.toHaveProperty('salaryBasis');
  });

  it('absent salaryBasis keeps ordinary nonfuture legacy reconstruction despite the later correction closing its old row', async () => {
    const fixture = await paidAugust('legacy');
    // Synthetic timing control: November's revision was recorded AFTER August was paid, so the
    // old RM10,000 row is the only visible legacy baseline. The new correction may close its validTo.
    await owner.db.update(schema.compensation).set({ recordedAt: new Date(fixture.closed.createdAt.getTime() + 2000) })
      .where(eq(schema.compensation.id, fixture.history[1].id));
    const correction = await appendBackdatedCorrection(fixture);
    const result = await calculateBackPay(ctx, { companyId: base.companyId, targetPayPeriod: '2026-12', compensationIds: [correction.id] });
    expect(result.total).toBe(2000);
    const detail = await backPayRunDetail(ctx, result.runId);
    expect(detail!.rows).toHaveLength(1);
    expect(detail!.rows[0]).toMatchObject({ payCode: 'BASIC', needsReview: false });
    expect(detail!.rows[0].byPeriod['2026-08']).toMatchObject({ old: 10000, new: 12000, diff: 2000 });
    expect(await slipOf(fixture.batchId)).toEqual(fixture.closed);
    expect((await slipOf(fixture.batchId)).statutory).not.toHaveProperty('salaryBasis');
  });

  it.each(['null', 'empty', 'version', 'reference', 'id', 'future', 'impossibleDate', 'amount', 'zero', 'mode'] as const)(
    'present unusable salaryBasis (%s) requires review instead of falling back to legacy money', async variant => {
      const fixture = await paidAugust(variant);
      expect(fixture.closed.statutory).toHaveProperty('salaryBasis');
      const correction = await appendBackdatedCorrection(fixture);
      const result = await calculateBackPay(ctx, { companyId: base.companyId, targetPayPeriod: '2026-12', compensationIds: [correction.id] });
      expect(result.lineCount).toBe(1);
      expect(result.total).toBe(0);
      const detail = await backPayRunDetail(ctx, result.runId);
      expect(detail!.rows).toHaveLength(1);
      expect(detail!.rows[0]).toMatchObject({ payCode: 'BASIC', needsReview: true, reviewReason: 'noBaselineSalary' });
      const [line] = await owner.db.select().from(schema.backPayLine).where(eq(schema.backPayLine.runId, result.runId));
      expect(line.newAmount).toBeNull();
      expect(line.difference).toBe('0.00');
      expect(await slipOf(fixture.batchId)).toEqual(fixture.closed);
    },
  );
});
