/**
 * f1123afd — a recurring payroll item cannot be REMOVED after it has already been paid on a processed
 * payslip.
 *
 * THE ASYMMETRY THIS CLOSES. `deleteIndividualTxn` has always loaded the owning batch and refused a write
 * that is not allowed on it. `archiveEmploymentPayComponent` checked only that the row existed and then
 * set `supersededAt` — no payslip check at all. Measured on production 2026-08-05: 34 recurring items (33
 * live), 50 payslips, 21 processed runs and not one draft or closed one. So recurring items HAVE been
 * paid, and every one of them could be removed.
 *
 * WHAT COUNTS AS EVIDENCE, AND WHAT DELIBERATELY DOES NOT. The guard reads the PAYSLIP'S OWN STORED
 * FIGURES — `statutory.componentLines` / `statutory.recordLines`, the per-item detail the kernel stamps —
 * and never re-derives eligibility from today's catalog configuration. A payslip is a historical document.
 * The last test in this file pins the KNOWN LIMITATION of that choice rather than hiding it: a payslip
 * generated before that detail was stored (feedback 862ed0ad, 2026-08-01) carries no line list, so the
 * guard cannot see it and the removal is allowed. Refusing on the absence of evidence would block every
 * removal on a system whose payslips predate the stamping, and "probably in that payslip" is not a basis
 * for refusing an admin action.
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
 *  so there would be no stored evidence for the guard to read and the file would prove nothing. */
async function typedComponentsCtx(b: Base): Promise<SessionContext> {
  await setModule(b.tenantId, 'typed_pay_components', 'active');
  return entitledCtx(b);
}

describe('f1123afd — a paid recurring item cannot be removed', () => {
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

  /** One employee, paid BASIC + one recurring ALLOWANCE, with a processed run for `period`. */
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

  it('the payslip really does record WHICH component produced the money — the guard is not guessing', async () => {
    // Stated as its own assertion because everything below depends on it. If this ever stops being true
    // the guard silently stops firing, and a green suite would say nothing.
    const { batchId } = await payAnAllowance();
    const st = (await slipOf(batchId)).statutory as { componentLines?: { code: string }[] };
    expect(st.componentLines?.map((l) => l.code)).toContain('ALLOWANCE');
  });

  it('REFUSES removal of an item paid on a processed payslip, and changes nothing', async () => {
    const { a, employmentId, id } = await payAnAllowance();

    await expect(archiveEmploymentPayComponent(a, { id, employmentId })).rejects.toBeInstanceOf(
      FixedTransactionPaidError,
    );
    // Named, so the message can say which item and which month rather than "cannot be removed".
    await expect(archiveEmploymentPayComponent(a, { id, employmentId })).rejects.toMatchObject({
      code: 'ALLOWANCE',
      payPeriod: '2026-05',
    });

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

  it('the alternative the refusal names still works: ending it from a date', async () => {
    // The refusal is only defensible because this path exists. Ending the item stops future payment and
    // leaves the payslip it was already paid on exactly as it was.
    const { a, employmentId, id } = await payAnAllowance();
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

  it('EDITING a paid item is still allowed — versioning preserves what was paid, removal does not', async () => {
    // The guard is on REMOVAL only, and that distinction is the whole design: an edit closes the current
    // value from a new date and opens a new row, so the paid history survives. Blocking it too would make
    // a paid item permanently unchangeable, which nobody asked for and which the effective-dated model
    // already solves.
    const { a, employmentId, id } = await payAnAllowance();
    await expect(
      updateEmploymentPayComponent(a, { id, employmentId, amount: 600, effectiveFrom: '2026-06-01' }),
    ).resolves.toMatchObject({ id: expect.any(String) });
  });

  it('a CLOSED run counts as paid too', async () => {
    const { a, employmentId, id, batchId } = await payAnAllowance();
    await closeBatch(a, { batchId });
    await expect(archiveEmploymentPayComponent(a, { id, employmentId })).rejects.toBeInstanceOf(
      FixedTransactionPaidError,
    );
  });

  it('an item that was NEVER paid is still removable, byte-identically to before', async () => {
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
    await expect(archiveEmploymentPayComponent(a, { id, employmentId: e.employmentId })).resolves.toMatchObject({ id });
    expect((await listEmploymentPayComponents(a, e.employmentId)).some((r) => r.id === id)).toBe(false);
  });

  it('the guard is per PAY ITEM, not "this employee has a payslip"', async () => {
    // A second recurring item the run never paid must stay removable even though a processed payslip
    // exists for the same employee. "Somebody was paid something that month" is not evidence about THIS
    // item, and a guard that treated it as such would freeze the whole screen.
    const { a, employmentId } = await payAnAllowance();
    const { id: otherId } = await setEmploymentPayComponent(a, {
      employmentId,
      componentId: await codeId(a, 'DEDUCTION'),
      amount: 20,
      // Starts AFTER the run that has already been processed, so it cannot have been on that payslip.
      effectiveFrom: '2026-09-01',
    });
    await expect(archiveEmploymentPayComponent(a, { id: otherId, employmentId })).resolves.toMatchObject({
      id: otherId,
    });
  });

  it('an item whose window does not cover the paid month is still removable', async () => {
    // The window is read from the ROW'S OWN dates — its identity — to attribute a stored line to THIS row
    // rather than a sibling for the same code. An item that only starts in September was not what the May
    // payslip paid, even though the code matches.
    const { a, employmentId } = await payAnAllowance();
    const { id: laterId } = await setEmploymentPayComponent(a, {
      employmentId,
      componentId: await codeId(a, 'ALLOWANCE'),
      amount: 700,
      effectiveFrom: '2026-09-01',
    });
    await expect(archiveEmploymentPayComponent(a, { id: laterId, employmentId })).resolves.toMatchObject({
      id: laterId,
    });
  });

  it('KNOWN LIMITATION, pinned on purpose: a payslip with no stored line detail cannot be checked', async () => {
    // Payslips generated before feedback 862ed0ad (2026-08-01) carry no `componentLines` key — the kernel
    // says so itself: the detail "was never stored before, so the runs already completed cannot be
    // itemised retrospectively". Simulated here by stripping the key from the stored jsonb, which is
    // exactly the shape those older slips have.
    //
    // The removal is then ALLOWED. That is the deliberate choice, and this test exists so the choice is
    // visible in the suite rather than only in a comment: if someone later decides absence of evidence
    // should refuse, they have to change this test and say why.
    const { a, employmentId, id, batchId } = await payAnAllowance();
    const slip = await slipOf(batchId);
    const { componentLines: _dropped, ...withoutLines } = slip.statutory as Record<string, unknown>;
    await owner.db
      .update(schema.payslip)
      .set({ statutory: withoutLines })
      .where(eq(schema.payslip.id, slip.id));

    await expect(archiveEmploymentPayComponent(a, { id, employmentId })).resolves.toMatchObject({ id });
  });
});
