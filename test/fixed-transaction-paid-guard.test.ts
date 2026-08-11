/**
 * 2aed39d4 — a recurring payroll item follows the PAY RUN'S STATUS: it can be changed and removed while
 * the runs that cover it are draft or processed, and only freezes once a run covering it is CLOSED.
 *
 * ⚠️ THIS FILE REVERSES WHAT IT USED TO ASSERT. IT IS THE SAME GUARD, WITH THE OPPOSITE TRIGGER.
 *
 * f1123afd wrote this file to prove the opposite rule: removal refused as soon as any PROCESSED payslip
 * carried the item. The reporter's expected-behaviour point 7 asks for the reverse, explicitly and with a
 * worked example — "a fixed transaction shall still be allowed to be deleted after payroll has been
 * processed, provided the payroll period is not yet closed … HR Admin may discover that a fixed
 * transaction was entered incorrectly after payroll processing" — with a status table that says
 * Processed/Not Closed: Delete Y, Reprocess Y; Closed: Delete N. Their newer and more explicit
 * instruction wins. (Sibling board item 2f889bae proposes making the old rule STRICTER still; that
 * proposal is superseded by this one and must not be built on top of it.)
 *
 * WHY THE OLD TEST WAS NOT WORTH KEEPING ALONGSIDE. It was not a rule, it was a coin flip. There is no
 * payslip LINE table: the per-item detail lives in `payslip.statutory.componentLines` / `recordLines`,
 * which the kernel only began stamping on 2026-08-01 (feedback 862ed0ad). Slips older than that carry no
 * line list, so the guard could not see them and ALLOWED the removal — the last test in the old file
 * pinned exactly that hole. Roughly half the live items a processed payslip covered were removable and
 * half were not, with nothing on screen to say which. Batch status is recorded for every run ever made,
 * so the new rule applies uniformly.
 *
 * NOTHING IS CLOSED ON PRODUCTION (22 batches, all `processed`, none carrying `closed_at`, re-measured
 * 2026-08-11), which is precisely why this rule has to be proved here rather than observed there.
 */
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import * as schema from '../db/schema';
import type { SessionContext } from '../db/client';
import { hireEmployee } from '../core/org';
import { setCompensation } from '../core/comp';
import { setStatutoryProfileMY } from '../localization/my/statutory';
import { closeBatch, createBatch, generatePayslips } from '../core/payroll';
import {
  FixedTransactionPaidError,
  archiveEmploymentPayComponent,
  endEmploymentPayComponent,
  listEmploymentPayComponents,
  listPayComponents,
  seedPayComponentCatalog,
  setEmploymentPayComponent,
  updateEmploymentPayComponent,
} from '../core/pay-components';
import {
  adminCtx,
  closeAll,
  entitledCtx,
  migrateTestDb,
  owner,
  resetDb,
  seedBase,
  setModule,
  type Base,
} from './harness';

/** Grant `typed_pay_components` and hand back a context that can SEE the grant (point-in-time snapshot).
 *  Without it the kernel sources earnings from compensation + payroll_input and stamps NO componentLines,
 *  so the payslips these tests produce would not itemise anything and the file would prove less. */
async function typedComponentsCtx(b: Base): Promise<SessionContext> {
  await setModule(b.tenantId, 'typed_pay_components', 'active');
  return entitledCtx(b);
}

describe('2aed39d4 — a recurring item freezes on a CLOSED run, not on a processed one', () => {
  let base: Base;
  beforeAll(async () => {
    await migrateTestDb();
  });
  beforeEach(async () => {
    await resetDb();
    base = await seedBase();
  });
  afterAll(async () => {
    await closeAll();
  });

  const codeId = async (ctx: SessionContext, code: string) =>
    (await listPayComponents(ctx)).find((c) => c.code === code)!.id;

  /** One employee, paid BASIC + one recurring ALLOWANCE, with a PROCESSED run for `period`. */
  async function payAnAllowance(period = '2026-05') {
    const a = adminCtx(base);
    await seedPayComponentCatalog(a);
    const e = await hireEmployee(a, {
      person: { fullName: 'Paid Item', primaryEmail: 'paiditem@acme.test' },
      companyId: base.companyId,
      departmentId: base.deptA,
      employmentType: 'full_time',
      hiredOn: '2026-01-01',
    });
    await setCompensation(a, { employmentId: e.employmentId, basicSalary: 1000, monthlyAllowance: 0, effectiveFrom: '2026-01-01' });
    await setStatutoryProfileMY(a, { personId: e.personId, icNumber: '900101011234' });
    await setEmploymentPayComponent(a, {
      employmentId: e.employmentId,
      componentId: await codeId(a, 'BASIC'),
      amount: 1000,
      effectiveFrom: '2026-01-01',
    });
    const { id } = await setEmploymentPayComponent(a, {
      employmentId: e.employmentId,
      componentId: await codeId(a, 'ALLOWANCE'),
      amount: 500,
      effectiveFrom: '2026-01-01',
      prorateOverride: false,
    });
    const { batchId } = await createBatch(a, { companyId: base.companyId, payPeriod: period });
    await generatePayslips(await typedComponentsCtx(base), { batchId });
    return { a, employmentId: e.employmentId, personId: e.personId, id, batchId };
  }

  const slipOf = async (batchId: string) => {
    const [ps] = await owner.db.select().from(schema.payslip).where(eq(schema.payslip.batchId, batchId));
    return ps;
  };

  it('the item really was paid on the processed run — the allowance below is not being allowed through on absent evidence', async () => {
    // Stated as its own assertion because everything else here depends on the run having actually paid
    // the item. If the fixture ever stops paying it, the "removal is allowed" cases would be green for
    // an entirely different and uninteresting reason.
    const { batchId } = await payAnAllowance();
    const st = (await slipOf(batchId)).statutory as { componentLines?: { code: string }[] };
    expect(st.componentLines?.map((l) => l.code)).toContain('ALLOWANCE');
    const [batch] = await owner.db.select().from(schema.payrollBatch).where(eq(schema.payrollBatch.id, batchId));
    expect(batch.status).toBe('processed');
    expect(batch.closedAt).toBeNull();
  });

  it('ALLOWS removal of an item paid on a PROCESSED run — the reporter\'s point 7', async () => {
    const { a, employmentId, id } = await payAnAllowance();
    await expect(archiveEmploymentPayComponent(a, { id, employmentId })).resolves.toMatchObject({ id });
    // Gone from the screen, and gone from any reprocess of that run.
    expect((await listEmploymentPayComponents(a, employmentId)).some((r) => r.id === id)).toBe(false);
    const events = await owner.db
      .select({ t: schema.domainEvent.eventType })
      .from(schema.domainEvent)
      .where(eq(schema.domainEvent.eventType, 'employment-pay-component.archived'));
    expect(events).toHaveLength(1);
  });

  it('REFUSES removal once the covering run is CLOSED, names the period, and changes nothing', async () => {
    const { a, employmentId, id, batchId } = await payAnAllowance();
    await closeBatch(a, { batchId });

    const err = await archiveEmploymentPayComponent(a, { id, employmentId }).catch((x) => x);
    expect(err).toBeInstanceOf(FixedTransactionPaidError);
    expect(err).toMatchObject({ code: 'ALLOWANCE', payPeriod: '2026-05' });

    // Refused BEFORE any write: the row is untouched and still on the screen.
    const [row] = await owner.db
      .select()
      .from(schema.employmentPayComponent)
      .where(eq(schema.employmentPayComponent.id, id));
    expect(row.supersededAt).toBeNull();
    expect((await listEmploymentPayComponents(a, employmentId)).some((r) => r.id === id)).toBe(true);
    // And no `archived` event was appended for a removal that did not happen.
    const events = await owner.db
      .select({ t: schema.domainEvent.eventType })
      .from(schema.domainEvent)
      .where(eq(schema.domainEvent.eventType, 'employment-pay-component.archived'));
    expect(events).toHaveLength(0);
  });

  it('THE REFUSAL IS PINNING THE CLOSED-RUN RULE, not RLS or the not-found guard', async () => {
    // A refusal test can pass for the wrong reason: a prior round found a whole file still green with the
    // guard removed, because it was pinning RLS. So the SAME row, the SAME caller and the SAME id are
    // exercised twice — once with the run closed (refused) and once with it processed (allowed). Only the
    // batch status differs between the two halves, so only the batch status can explain the difference.
    const closedCase = await payAnAllowance();
    await closeBatch(closedCase.a, { batchId: closedCase.batchId });
    await expect(
      archiveEmploymentPayComponent(closedCase.a, { id: closedCase.id, employmentId: closedCase.employmentId }),
    ).rejects.toBeInstanceOf(FixedTransactionPaidError);

    await resetDb();
    base = await seedBase();
    const openCase = await payAnAllowance();
    await expect(
      archiveEmploymentPayComponent(openCase.a, { id: openCase.id, employmentId: openCase.employmentId }),
    ).resolves.toMatchObject({ id: openCase.id });
  });

  it('the alternative the refusal names still works: ending it from a date after the closed month', async () => {
    // The refusal is only defensible because this path exists. Ending the item stops future payment and
    // leaves the closed run exactly as it was.
    const { a, employmentId, id, batchId } = await payAnAllowance();
    await closeBatch(a, { batchId });
    await expect(
      endEmploymentPayComponent(a, { id, employmentId, effectiveTo: '2026-05-31' }),
    ).resolves.toMatchObject({ id });
    const [row] = await owner.db
      .select()
      .from(schema.employmentPayComponent)
      .where(eq(schema.employmentPayComponent.id, id));
    expect(row.validTo).toBe('2026-05-31');
    expect(row.supersededAt).toBeNull();
  });

  it('EDITING an item on a processed run is allowed; editing INTO a closed month is refused', async () => {
    const { a, employmentId, id, batchId } = await payAnAllowance();
    // Processed: versioning from a later date goes through, exactly as before.
    await expect(
      updateEmploymentPayComponent(a, { id, employmentId, amount: 600, effectiveFrom: '2026-06-01' }),
    ).resolves.toMatchObject({ id: expect.any(String) });

    await closeBatch(a, { batchId });
    // Closed: a new value dated INSIDE the closed month is refused. (The row edited above now starts
    // 2026-06-01, so this is about the target month, not about which row is being touched.)
    const later = (await listEmploymentPayComponents(a, employmentId)).find((r) => r.code === 'ALLOWANCE' && r.validTo == null)!;
    await expect(
      updateEmploymentPayComponent(a, { id: later.id, employmentId, amount: 700, effectiveFrom: '2026-05-15' }),
    ).rejects.toBeInstanceOf(FixedTransactionPaidError);
  });

  it('an item that was never covered by any run is removable, and so is one on a DRAFT batch', async () => {
    const a = adminCtx(base);
    await seedPayComponentCatalog(a);
    const e = await hireEmployee(a, {
      person: { fullName: 'Never Paid', primaryEmail: 'neverpaid@acme.test' },
      companyId: base.companyId,
      departmentId: base.deptA,
      employmentType: 'full_time',
      hiredOn: '2026-01-01',
    });
    const { id } = await setEmploymentPayComponent(a, {
      employmentId: e.employmentId,
      componentId: await codeId(a, 'ALLOWANCE'),
      amount: 500,
      effectiveFrom: '2026-01-01',
    });
    // A DRAFT batch covering the window is explicitly not a refusal (the reporter's status table).
    await createBatch(a, { companyId: base.companyId, payPeriod: '2026-05' });
    await expect(archiveEmploymentPayComponent(a, { id, employmentId: e.employmentId })).resolves.toMatchObject({ id });
    expect((await listEmploymentPayComponents(a, e.employmentId)).some((r) => r.id === id)).toBe(false);
  });

  it('the rule is per ROW WINDOW, not "this employee has a closed run"', async () => {
    // A second recurring item whose window starts after the closed month must stay removable. A guard
    // that froze the whole screen for anyone with one closed run would be worse than no guard.
    const { a, employmentId, batchId } = await payAnAllowance();
    await closeBatch(a, { batchId });
    const { id: otherId } = await setEmploymentPayComponent(a, {
      employmentId,
      componentId: await codeId(a, 'DEDUCTION'),
      amount: 20,
      effectiveFrom: '2026-09-01',
    });
    await expect(archiveEmploymentPayComponent(a, { id: otherId, employmentId })).resolves.toMatchObject({
      id: otherId,
    });
  });

  it('a payslip with NO stored line detail no longer decides anything', async () => {
    // THE OLD HOLE, CLOSED. Payslips generated before feedback 862ed0ad (2026-08-01) carry no
    // `componentLines` key, and the previous guard read exactly that key — so those runs were invisible
    // to it and every item they paid was removable. Simulated here by stripping the key, which is the
    // shape those older slips really have. The batch status is unaffected by the strip, so the refusal
    // still fires: the rule no longer depends on evidence that only exists for recent runs.
    const { a, employmentId, id, batchId } = await payAnAllowance();
    const slip = await slipOf(batchId);
    const { componentLines: _dropped, ...withoutLines } = slip.statutory as Record<string, unknown>;
    await owner.db
      .update(schema.payslip)
      .set({ statutory: withoutLines })
      .where(eq(schema.payslip.id, slip.id));
    await closeBatch(a, { batchId });

    await expect(archiveEmploymentPayComponent(a, { id, employmentId })).rejects.toBeInstanceOf(
      FixedTransactionPaidError,
    );
  });
});
