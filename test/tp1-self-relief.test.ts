/**
 * Self Personal Tax Relief — LHDN TP1 yearly self-service (ADR-0050, #1.1.3).
 *
 * Covers the capture service (draft/submit, per-year isolation, correction=latest-wins, validation, RLS
 * self vs peer), the DomainEvent + PDPA Layer-0 discipline, and the auto-feed into PCB/MTD: the delta
 * convention (§0.1/0.2 — no double-count, never grows ∑LP past the declared annual), multi-employment
 * paymaster routing (§0.5), provenance/refresh vs manual-override (§0.4), non-destructive update (§targeted
 * .update), and closed-batch immutability (§0.3).
 */
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import * as schema from '../db/schema';
import type { SessionContext } from '../db/client';
import { hireEmployee } from '../core/org';
import { setCompensation } from '../core/comp';
import { setStatutoryProfileMY } from '../localization/my/statutory';
import {
  createBatch,
  generatePayslips,
  prefillTp1FromSelfRelief,
  setPayrollDeductionInput,
  setPayrollInput,
} from '../core/payroll';
import { getTp1, listTp1Years, saveTp1Draft, submitTp1, TaxReliefError } from '../core/tax-relief';
import {
  adminCtx,
  closeAll,
  createAppUser,
  eventTypesFor,
  migrateTestDb,
  owner,
  resetDb,
  seedBase,
  type Base,
} from './harness';

const YEAR = 2026;

describe('ADR-0050 — TP1 self-relief', () => {
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

  const hire = (name: string, email: string) =>
    hireEmployee(adminCtx(base), {
      person: { fullName: name, primaryEmail: email },
      companyId: base.companyId,
      departmentId: base.deptA,
      employmentType: 'full_time',
      hiredOn: '2026-01-01',
    });

  async function employeeCtx(personId: string): Promise<SessionContext> {
    const uid = await createAppUser(base.tenantId, personId, 'employee');
    return { tenantId: base.tenantId, userId: uid, personId, roles: ['employee'] };
  }

  /** Read a single employment's payslip statutory block (pcb, lp) for a batch via the owner (bypass RLS). */
  async function slipStat(batchId: string, employmentId: string) {
    const [row] = await owner.db
      .select({ statutory: schema.payslip.statutory })
      .from(schema.payslip)
      .where(and(eq(schema.payslip.batchId, batchId), eq(schema.payslip.employmentId, employmentId)));
    return (row?.statutory ?? {}) as { pcb?: number; lp?: number };
  }

  async function inputRow(batchId: string, employmentId: string) {
    const [row] = await owner.db
      .select()
      .from(schema.payrollInput)
      .where(and(eq(schema.payrollInput.batchId, batchId), eq(schema.payrollInput.employmentId, employmentId)));
    return row;
  }

  // 7.1 — draft → submit; latest stored per year; getTp1 returns it.
  it('saves a draft, submits, and returns the latest row per year', async () => {
    const e = await hire('Solo', 'solo@acme.test');
    const ctx = await employeeCtx(e.personId);

    await saveTp1Draft(ctx, { assessmentYear: YEAR, tp1Amount: 1200 });
    let latest = await getTp1(ctx, { assessmentYear: YEAR });
    expect(latest?.status).toBe('draft');
    expect(latest?.tp1Amount).toBe(1200);

    await submitTp1(ctx, { assessmentYear: YEAR, tp1Amount: 1500 });
    latest = await getTp1(ctx, { assessmentYear: YEAR });
    expect(latest?.status).toBe('submitted');
    expect(latest?.tp1Amount).toBe(1500);
    expect(latest?.submittedAt).toBeTruthy();

    expect(await listTp1Years(ctx)).toEqual([YEAR]);
  });

  // 7.1b — editing the draft UPDATEs in place (one editable draft per year).
  it('updates the open draft in place rather than appending a second draft', async () => {
    const e = await hire('Draft', 'draft@acme.test');
    const ctx = await employeeCtx(e.personId);
    await saveTp1Draft(ctx, { assessmentYear: YEAR, tp1Amount: 100 });
    await saveTp1Draft(ctx, { assessmentYear: YEAR, tp1Amount: 200 });
    const drafts = await owner.db
      .select()
      .from(schema.tp1Relief)
      .where(and(eq(schema.tp1Relief.personId, e.personId), eq(schema.tp1Relief.status, 'draft')));
    expect(drafts).toHaveLength(1);
    expect(Number(drafts[0].tp1Amount)).toBe(200);
  });

  // 7.2 — per-year isolation: submitting/correcting 2026 leaves 2025 untouched.
  it('isolates per assessment year', async () => {
    const e = await hire('Years', 'years@acme.test');
    const ctx = await employeeCtx(e.personId);
    await submitTp1(ctx, { assessmentYear: 2025, tp1Amount: 800 });
    await submitTp1(ctx, { assessmentYear: 2026, tp1Amount: 1600 });
    // A correction in 2026 must not touch 2025.
    await submitTp1(ctx, { assessmentYear: 2026, tp1Amount: 1700 });

    expect((await getTp1(ctx, { assessmentYear: 2025 }))?.tp1Amount).toBe(800);
    expect((await getTp1(ctx, { assessmentYear: 2026 }))?.tp1Amount).toBe(1700);
    expect((await listTp1Years(ctx)).sort()).toEqual([2025, 2026]);
  });

  // 7.3 — correction = latest-wins; older row retained (history).
  it('a correction inserts a new submitted row; the older is retained', async () => {
    const e = await hire('Correct', 'correct@acme.test');
    const ctx = await employeeCtx(e.personId);
    await submitTp1(ctx, { assessmentYear: YEAR, tp1Amount: 1000 });
    await submitTp1(ctx, { assessmentYear: YEAR, tp1Amount: 2000 });

    expect((await getTp1(ctx, { assessmentYear: YEAR }))?.tp1Amount).toBe(2000);
    const all = await owner.db
      .select()
      .from(schema.tp1Relief)
      .where(and(eq(schema.tp1Relief.personId, e.personId), eq(schema.tp1Relief.status, 'submitted')));
    expect(all).toHaveLength(2); // history kept, nothing deleted/superseded
    expect(all.map((r) => Number(r.tp1Amount)).sort((a, b) => a - b)).toEqual([1000, 2000]);
  });

  // 7.4 — validation rejects negative / out-of-range.
  it('rejects a negative or out-of-range amount/year', async () => {
    const e = await hire('Valid', 'valid@acme.test');
    const ctx = await employeeCtx(e.personId);
    await expect(submitTp1(ctx, { assessmentYear: YEAR, tp1Amount: -5 })).rejects.toThrow(TaxReliefError);
    await expect(submitTp1(ctx, { assessmentYear: YEAR, tp1Amount: 5_000_000 })).rejects.toThrow(TaxReliefError);
    await expect(submitTp1(ctx, { assessmentYear: 1999, tp1Amount: 100 })).rejects.toThrow(TaxReliefError);
  });

  // 7.5 — RLS: employee A cannot read or write employee B's TP1 (USING + WITH CHECK).
  it('RLS confines read AND write to the caller (no cross-person access)', async () => {
    const a = await hire('Alice', 'alice@acme.test');
    const b = await hire('Bob', 'bob@acme.test');
    const ctxA = await employeeCtx(a.personId);
    const ctxB = await employeeCtx(b.personId);
    await submitTp1(ctxB, { assessmentYear: YEAR, tp1Amount: 999 });

    // A reading "their own" year sees nothing for B's data — A simply has no row (RLS read scope).
    expect(await getTp1(ctxA, { assessmentYear: YEAR })).toBeNull();

    // A cannot INSERT a row for B: the WITH CHECK clause rejects writing a row whose person_id is not
    // visible to A. (The service itself resolves person_id from ctx, so this proves the DB backstop.)
    await expect(crossPersonInsert(ctxA, b.personId)).rejects.toThrow();
  });

  // 7.6 + 7.10 — auto-feed end-to-end: the prefill produces the SAME (lower) PCB as keying the equivalent
  // manual tp1_deduction, and preserves the row's existing overtime/bonus/zakat (targeted .update).
  // Three identical employees in ONE January batch (no prior payslips ⇒ same cumulative context): A is
  // prefill-fed, B is manual-keyed with the same TP1, C has no relief. A.pcb must equal B.pcb (prefill ≡
  // manual) and both must be below C.pcb (relief lowers MTD) — the hand-computed golden against the
  // existing PCB engine without hardcoding LHDN magic numbers.
  it('feeds TP1 into PCB equivalently to a manual key, lowering MTD and preserving siblings', async () => {
    const a = adminCtx(base);
    const A = await hire('FeedA', 'feeda@acme.test');
    const B = await hire('FeedB', 'feedb@acme.test');
    const C = await hire('FeedC', 'feedc@acme.test');
    let ic = 12001;
    for (const e of [A, B, C]) {
      await setCompensation(a, { employmentId: e.employmentId, basicSalary: 8000, effectiveFrom: '2026-01-01' });
      await setStatutoryProfileMY(a, { personId: e.personId, icNumber: `9001010${ic++}` });
    }
    const ctxA = await employeeCtx(A.personId);
    await submitTp1(ctxA, { assessmentYear: YEAR, tp1Amount: 3000 });

    const { batchId } = await createBatch(a, { companyId: base.companyId, payPeriod: `${YEAR}-01` });
    // A: pre-existing earnings on the row, then the prefill — siblings must survive (7.10).
    await setPayrollInput(a, { batchId, employmentId: A.employmentId, overtimeAmount: 400, bonusAmount: 700, zakat: 50 });
    const r = await prefillTp1FromSelfRelief(a, { batchId });
    expect(r.applied).toBe(1); // only A has a submitted TP1
    const fedInput = await inputRow(batchId, A.employmentId);
    expect(Number(fedInput.tp1Deduction)).toBe(3000); // ∑LP=0 in Jan → full annual fed
    expect(fedInput.tp1Source).toBe('tp1_self');
    expect(Number(fedInput.overtimeAmount)).toBe(400); // 7.10 non-destructive
    expect(Number(fedInput.bonusAmount)).toBe(700);
    expect(Number(fedInput.zakat)).toBe(50);

    // B: identical earnings, but the SAME TP1 keyed manually.
    await setPayrollInput(a, { batchId, employmentId: B.employmentId, overtimeAmount: 400, bonusAmount: 700, zakat: 50, tp1Deduction: 3000 });
    // C: identical earnings, no relief.
    await setPayrollInput(a, { batchId, employmentId: C.employmentId, overtimeAmount: 400, bonusAmount: 700, zakat: 50 });
    await generatePayslips(a, { batchId });

    const pcbA = Number((await slipStat(batchId, A.employmentId)).pcb);
    const pcbB = Number((await slipStat(batchId, B.employmentId)).pcb);
    const pcbC = Number((await slipStat(batchId, C.employmentId)).pcb);
    expect(pcbA).toBe(pcbB); // prefill ≡ manual key (identical statutory inputs ⇒ identical MTD)
    expect(pcbA).toBeLessThan(pcbC); // relief lowers PCB
    expect(Number((await slipStat(batchId, A.employmentId)).lp)).toBe(3000);
  });

  // 7.7 — mid-year adoption / no double-count: prior months already carry manual LP in ∑LP, so the prefill
  // feeds the DELTA, making the year's ∑LP+LP₁ equal the declared annual, not more.
  it('feeds the delta against ∑LP already accumulated (no double-count)', async () => {
    const a = adminCtx(base);
    const subject = await hire('Mid', 'mid@acme.test');
    await setCompensation(a, { employmentId: subject.employmentId, basicSalary: 8000, effectiveFrom: '2026-01-01' });
    await setStatutoryProfileMY(a, { personId: subject.personId, icNumber: '900101012002' });
    const ctx = await employeeCtx(subject.personId);

    // Jan + Feb run with RM500/mo manual TP1 already stamped → ∑LP = 1000.
    for (const m of ['01', '02']) {
      const { batchId } = await createBatch(a, { companyId: base.companyId, payPeriod: `${YEAR}-${m}` });
      await setPayrollInput(a, { batchId, employmentId: subject.employmentId, overtimeAmount: 0, tp1Deduction: 500 });
      await generatePayslips(a, { batchId });
    }

    // Now the employee declares an annual TP1 of 1800. March prefill should feed 1800 − 1000 = 800.
    await submitTp1(ctx, { assessmentYear: YEAR, tp1Amount: 1800 });
    const { batchId: march } = await createBatch(a, { companyId: base.companyId, payPeriod: `${YEAR}-03` });
    await prefillTp1FromSelfRelief(a, { batchId: march });
    expect(Number((await inputRow(march, subject.employmentId)).tp1Deduction)).toBe(800);
    await generatePayslips(a, { batchId: march });

    // ∑LP across the year now equals the declared annual exactly (500 + 500 + 800 = 1800), not 1000+1800.
    const lpSum = (
      await owner.db
        .select({ statutory: schema.payslip.statutory })
        .from(schema.payslip)
        .where(eq(schema.payslip.employmentId, subject.employmentId))
    ).reduce((sum, r) => sum + Number((r.statutory as { lp?: number }).lp ?? 0), 0);
    expect(lpSum).toBe(1800);
  });

  // 7.8 — multi-employment: relief written ONLY to designated_paymaster_employment_id, not duplicated.
  it('routes to the designated paymaster only, not the second employment', async () => {
    const a = adminCtx(base);
    const subject = await hire('Multi', 'multi@acme.test');
    await setCompensation(a, { employmentId: subject.employmentId, basicSalary: 5000, effectiveFrom: '2026-01-01' });
    await setStatutoryProfileMY(a, { personId: subject.personId, icNumber: '900101012003' });
    // Second concurrent employment in the SAME company so both land in one batch.
    const [e2] = await owner.db
      .insert(schema.employment)
      .values({ tenantId: base.tenantId, personId: subject.personId, companyId: base.companyId, hiredOn: '2026-01-01' })
      .returning({ id: schema.employment.id });
    await setCompensation(a, { employmentId: e2.id, basicSalary: 5000, effectiveFrom: '2026-01-01' });
    // Designate the first employment as the paymaster.
    await owner.db
      .update(schema.person)
      .set({ designatedPaymasterEmploymentId: subject.employmentId })
      .where(eq(schema.person.id, subject.personId));

    const ctx = await employeeCtx(subject.personId);
    await submitTp1(ctx, { assessmentYear: YEAR, tp1Amount: 2400 });

    const { batchId } = await createBatch(a, { companyId: base.companyId, payPeriod: `${YEAR}-01` });
    const r = await prefillTp1FromSelfRelief(a, { batchId });
    expect(r.applied).toBe(1);
    expect(Number((await inputRow(batchId, subject.employmentId)).tp1Deduction)).toBe(2400);
    // The second employment must have NO TP1 fed (no row, or zero).
    const other = await inputRow(batchId, e2.id);
    expect(other == null || Number(other.tp1Deduction) === 0).toBe(true);
  });

  // 7.9 — provenance/refresh: a corrected TP1 refreshes a prefill-set row; a manual override survives.
  it('refreshes a prefill-set row but leaves a manual override untouched', async () => {
    const a = adminCtx(base);
    const subject = await hire('Prov', 'prov@acme.test');
    await setCompensation(a, { employmentId: subject.employmentId, basicSalary: 8000, effectiveFrom: '2026-01-01' });
    await setStatutoryProfileMY(a, { personId: subject.personId, icNumber: '900101012004' });
    const ctx = await employeeCtx(subject.personId);
    await submitTp1(ctx, { assessmentYear: YEAR, tp1Amount: 1000 });

    const { batchId } = await createBatch(a, { companyId: base.companyId, payPeriod: `${YEAR}-01` });

    // (a) First prefill sets a tp1_self row; a corrected declaration + re-prefill refreshes it.
    await prefillTp1FromSelfRelief(a, { batchId });
    expect(Number((await inputRow(batchId, subject.employmentId)).tp1Deduction)).toBe(1000);
    await submitTp1(ctx, { assessmentYear: YEAR, tp1Amount: 1500 });
    await prefillTp1FromSelfRelief(a, { batchId });
    const refreshed = await inputRow(batchId, subject.employmentId);
    expect(Number(refreshed.tp1Deduction)).toBe(1500); // refreshed
    expect(refreshed.tp1Source).toBe('tp1_self');

    // (b) An admin manual override resets provenance to manual (sticky) — a re-prefill leaves it alone.
    await setPayrollDeductionInput(a, { batchId, employmentId: subject.employmentId, tp1Deduction: 222 });
    expect((await inputRow(batchId, subject.employmentId)).tp1Source).toBeNull();
    const re = await prefillTp1FromSelfRelief(a, { batchId });
    expect(re.skipped).toBe(1);
    expect(Number((await inputRow(batchId, subject.employmentId)).tp1Deduction)).toBe(222); // survived
  });

  // 7.11 — closed-batch immutability: the prefill refuses a non-draft batch.
  it('refuses to feed a non-draft batch', async () => {
    const a = adminCtx(base);
    const subject = await hire('Closed', 'closed@acme.test');
    await setCompensation(a, { employmentId: subject.employmentId, basicSalary: 6000, effectiveFrom: '2026-01-01' });
    await setStatutoryProfileMY(a, { personId: subject.personId, icNumber: '900101012005' });
    const ctx = await employeeCtx(subject.personId);
    await submitTp1(ctx, { assessmentYear: YEAR, tp1Amount: 1000 });
    const { batchId } = await createBatch(a, { companyId: base.companyId, payPeriod: `${YEAR}-01` });
    await generatePayslips(a, { batchId }); // → processed (not draft)
    await expect(prefillTp1FromSelfRelief(a, { batchId })).rejects.toThrow();
  });

  // 7.12 — event coverage + PDPA Layer-0: tp1.* events land, and the cleartext amount is ABSENT from the
  // persisted domain_event payload.
  it('appends tp1.draft.saved / tp1.submitted with NO cleartext amount in the payload', async () => {
    const e = await hire('Pdpa', 'pdpa@acme.test');
    const ctx = await employeeCtx(e.personId);
    const { id: draftId } = await saveTp1Draft(ctx, { assessmentYear: YEAR, tp1Amount: 4242 });
    const { id: subId } = await submitTp1(ctx, { assessmentYear: YEAR, tp1Amount: 7373 });

    expect(await eventTypesFor(base.tenantId, draftId)).toContain('tp1.draft.saved');
    expect(await eventTypesFor(base.tenantId, subId)).toContain('tp1.submitted');

    // PDPA Layer-0: the secret amounts must not appear anywhere in the persisted event payloads.
    const events = await owner.db
      .select({ payload: schema.domainEvent.payload })
      .from(schema.domainEvent)
      .where(eq(schema.domainEvent.tenantId, base.tenantId));
    const blob = JSON.stringify(events.map((r) => r.payload));
    expect(blob).not.toContain('4242');
    expect(blob).not.toContain('7373');
  });

  // helper: a raw cross-person insert under a session ctx, to prove the WITH CHECK clause blocks it.
  async function crossPersonInsert(ctx: SessionContext, otherPersonId: string) {
    const { withTenant } = await import('../db/client');
    return withTenant(ctx, async (tx) => {
      await tx
        .insert(schema.tp1Relief)
        .values({ tenantId: ctx.tenantId, personId: otherPersonId, assessmentYear: YEAR, status: 'draft', tp1Amount: '1.00' });
    });
  }
});
