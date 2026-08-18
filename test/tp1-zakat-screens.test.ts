/**
 * Separated TP1 Relief / Zakat screens (approved plan, ADR-0050 §0.4).
 *
 * The VALUE-preservation guards already live in payroll-transaction-submodule.test.ts (lines 53-83). This
 * file adds the genuinely-new guards the split needs:
 *  (a) PROVENANCE regression — a zakat-only save must NOT poison a live tp1_self relief's provenance, so the
 *      TP1 self-relief prefill keeps auto-tracking it. Without the step-1 core fix this fails.
 *  (b) A TP1 edit still resets provenance to manual (null) — we did not over-preserve.
 *  (c) Single-field zakat semantics — a zakat-only deduction write must not zero the sibling TP1 value
 *      (the Number(...)||0 copy trap). Feedback d435673e removed the Zakat write-screen action
 *      (saveZakatAction), so this now asserts the core setPayrollDeductionInput contract directly.
 *  (d) Legacy-row edge — a zakat-only save over a row whose tp1_source is a non-null, non-'tp1_self' value
 *      reads back correctly and does not throw.
 */
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import * as schema from '../db/schema';
import { hireEmployee } from '../core/org';
import { setCompensation } from '../core/comp';
import { setStatutoryProfileMY } from '../localization/my/statutory';
import { createBatch, setPayrollDeductionInput, prefillTp1FromSelfRelief } from '../core/payroll';
import { adminCtx, closeAll, migrateTestDb, owner, resetDb, seedBase, type Base } from './harness';

describe('Separated TP1/Zakat screens — provenance + single-field semantics', () => {
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

  async function hireWithBatch() {
    const a = adminCtx(base);
    const e = await hireEmployee(a, {
      person: { fullName: 'Prov', primaryEmail: 'prov@acme.test' },
      companyId: base.companyId,
      departmentId: base.deptA,
      employmentType: 'full_time',
      hiredOn: '2026-01-01',
    });
    await setCompensation(a, {
      employmentId: e.employmentId,
      basicSalary: 5000,
      monthlyAllowance: 0,
      effectiveFrom: '2026-01-01',
    });
    await setStatutoryProfileMY(a, { personId: e.personId, icNumber: '900101011234' });
    const { batchId } = await createBatch(a, { companyId: base.companyId, payPeriod: '2026-05' });
    return { a, personId: e.personId, employmentId: e.employmentId, batchId };
  }

  const readRow = async (batchId: string, employmentId: string) => {
    const [row] = await owner.db
      .select()
      .from(schema.payrollInput)
      .where(
        and(eq(schema.payrollInput.batchId, batchId), eq(schema.payrollInput.employmentId, employmentId)),
      );
    return row;
  };

  it('(a) zakat-only save preserves a tp1_self relief value AND its provenance (self-relief still refreshes)', async () => {
    const { a, personId, employmentId, batchId } = await hireWithBatch();
    // An APPROVED annual TP1 declaration for this person for the batch's assessment year (2026).
    //
    // 7ad37961 — this fixture said 'submitted' until the employer-consent workflow landed. Section F of
    // the official TP1 is what turns a claim into an instruction to payroll, so the prefill now reads
    // approved rows only, effective from their approved month. The claim THIS case makes — that a
    // zakat-only save preserves the relief and its provenance — is untouched; only the state the
    // declaration starts in moved, and it starts in the state migration 0445 leaves every existing row.
    await owner.db.insert(schema.tp1Relief).values({
      tenantId: base.tenantId,
      personId,
      assessmentYear: 2026,
      tp1Amount: '3000',
      status: 'approved',
      approvedAt: new Date(),
      approvedMonth: 1,
      approvedYear: 2026,
    });
    // Prefill sets tp1_deduction from the declaration and stamps tp1_source='tp1_self'.
    const first = await prefillTp1FromSelfRelief(a, { batchId });
    expect(first.applied).toBe(1);
    const seeded = await readRow(batchId, employmentId);
    expect(seeded.tp1Source).toBe('tp1_self');
    expect(Number(seeded.tp1Deduction)).toBe(3000);

    // Edit ONLY zakat. The core fix must leave tp1_source='tp1_self' (not null) and tp1_deduction unchanged.
    await setPayrollDeductionInput(a, { batchId, employmentId, zakat: 90 });
    const afterZakat = await readRow(batchId, employmentId);
    expect(afterZakat.tp1Source).toBe('tp1_self'); // NOT poisoned to null
    expect(Number(afterZakat.tp1Deduction)).toBe(3000);
    expect(Number(afterZakat.zakat)).toBe(90);

    // Because provenance survived, the self-relief prefill still treats the row as auto-tracked and refreshes
    // it (applied, not skipped). Without the step-1 fix, tp1_source would be null → manual override → skipped.
    const second = await prefillTp1FromSelfRelief(a, { batchId });
    expect(second.applied).toBe(1);
    expect(second.skipped).toBe(0);
  });

  it('(b) a TP1 edit still resets provenance to manual (null) — did not over-preserve', async () => {
    const { a, personId, employmentId, batchId } = await hireWithBatch();
    // APPROVED, not merely submitted — see case (a) above for why that changed in 7ad37961.
    await owner.db.insert(schema.tp1Relief).values({
      tenantId: base.tenantId,
      personId,
      assessmentYear: 2026,
      tp1Amount: '3000',
      status: 'approved',
      approvedAt: new Date(),
      approvedMonth: 1,
      approvedYear: 2026,
    });
    await prefillTp1FromSelfRelief(a, { batchId });
    expect((await readRow(batchId, employmentId)).tp1Source).toBe('tp1_self');

    // A real TP1 edit is a manual override → tp1_source stamped null (unchanged legacy behaviour).
    await setPayrollDeductionInput(a, { batchId, employmentId, tp1Deduction: 1234 });
    const row = await readRow(batchId, employmentId);
    expect(row.tp1Source).toBeNull();
    expect(Number(row.tp1Deduction)).toBe(1234);

    // Now the self-relief prefill treats it as a sticky manual override and SKIPS it.
    const res = await prefillTp1FromSelfRelief(a, { batchId });
    expect(res.skipped).toBe(1);
    expect(res.applied).toBe(0);
    expect(Number((await readRow(batchId, employmentId)).tp1Deduction)).toBe(1234); // untouched
  });

  it('(c) a zakat-only deduction write does not zero or alter TP1 — single-field copy-trap guard', async () => {
    const { a, employmentId, batchId } = await hireWithBatch();
    // Seed a TP1 value via a real TP1 edit.
    await setPayrollDeductionInput(a, { batchId, employmentId, tp1Deduction: 250 });
    expect(Number((await readRow(batchId, employmentId)).tp1Deduction)).toBe(250);

    // A zakat-only write (tp1Deduction left undefined) must preserve the TP1 value, not zero it — this is the
    // contract the (now-removed) saveZakatAction relied on and the batch-grid zakat write still relies on.
    await setPayrollDeductionInput(a, { batchId, employmentId, zakat: 75 });

    const row = await readRow(batchId, employmentId);
    expect(Number(row.tp1Deduction)).toBe(250); // NOT zeroed by the untouched field
    expect(Number(row.zakat)).toBe(75);
  });

  it('(d) zakat-only save over a legacy row (non-null, non-tp1_self tp1_source) reads back and does not throw', async () => {
    const { employmentId, batchId } = await hireWithBatch();
    // Seed a row directly whose tp1_source is a legacy/unknown non-null value (pre-provenance data).
    await owner.db.insert(schema.payrollInput).values({
      tenantId: base.tenantId,
      batchId,
      employmentId,
      overtimeAmount: '100',
      bonusAmount: '200',
      tp1Deduction: '500',
      tp1Source: 'legacy_unknown',
      zakat: '0',
    });

    const a = adminCtx(base);
    await expect(setPayrollDeductionInput(a, { batchId, employmentId, zakat: 60 })).resolves.toBeTruthy();
    const row = await readRow(batchId, employmentId);
    // zakat-only preserve: TP1 value AND the legacy provenance survive; earnings survive.
    expect(Number(row.zakat)).toBe(60);
    expect(Number(row.tp1Deduction)).toBe(500);
    expect(row.tp1Source).toBe('legacy_unknown');
    expect(Number(row.overtimeAmount)).toBe(100);
    expect(Number(row.bonusAmount)).toBe(200);
  });
});
