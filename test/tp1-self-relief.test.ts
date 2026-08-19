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
import type { Tp1LegacyCategories } from '../db/schema';
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
import {
  approveTp1ForPerson,
  getTp1ForPerson,
  getTp1,
  listTp1Years,
  saveTp1Draft,
  submitTp1,
  TaxReliefError,
} from '../core/tax-relief';
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

  /**
   * 7ad37961 — SUBMITTED NO LONGER FEEDS PAYROLL; APPROVED DOES.
   *
   * Section F of the official LHDN TP1 is the EMPLOYER'S CONSENT, and consent is what turns an
   * employee's claim into an instruction to payroll — so `prefillTp1FromSelfRelief` reads only APPROVED
   * declarations, effective from their approved deduction month. Every case below that asserts something
   * about the FEED was written when submitting was the whole workflow, so each now approves the
   * declaration it submitted. The assertions about the feed itself are UNCHANGED: same amounts, same
   * deltas, same routing, same provenance. What moved is the state the row has to be in first.
   *
   * IT GOES THROUGH THE REAL SERVICE, not a raw UPDATE, so these cases still exercise the gate they now
   * depend on — a test that hand-stamped the column would pass even if approval were broken.
   *
   * (Rows that already existed in production are stamped by migration 0449, not by this.)
   */
  async function approveLatest(admin: SessionContext, personId: string, assessmentYear: number) {
    const row = await getTp1ForPerson(admin, { personId, assessmentYear });
    if (!row) throw new Error('nothing to approve');
    await approveTp1ForPerson(admin, { personId, id: row.id, approvedMonth: 1, approvedYear: assessmentYear });
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
    await approveLatest(a, A.personId, YEAR);

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
    await approveLatest(a, subject.personId, YEAR);
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
    await approveLatest(a, subject.personId, YEAR);

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
    await approveLatest(a, subject.personId, YEAR);

    const { batchId } = await createBatch(a, { companyId: base.companyId, payPeriod: `${YEAR}-01` });

    // (a) First prefill sets a tp1_self row; a corrected declaration + re-prefill refreshes it.
    await prefillTp1FromSelfRelief(a, { batchId });
    expect(Number((await inputRow(batchId, subject.employmentId)).tp1Deduction)).toBe(1000);
    // A correction is a NEW submitted row, so it needs its own consent before it can feed — which is the
    // point of the gate: an employee cannot raise their own relief mid-year without the employer.
    await submitTp1(ctx, { assessmentYear: YEAR, tp1Amount: 1500 });
    await approveLatest(a, subject.personId, YEAR);
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

  // ── a2f1fa24 — structured per-category breakdown (PDF→interactive form conversion) ──
  //
  // The declaration now carries a per-category breakdown mirroring the paper LHDN TP1. The invariant that
  // MUST hold: `tp1Amount` stays the server-computed round2 SUM of the categories (the ONLY value PCB sees),
  // so the monthly MTD math is byte-identical whether the same total arrived as a scalar or a breakdown.
  describe('per-category breakdown', () => {
    // C.1 — the roll-up: tp1Amount is the sum of the categories, categories are persisted + returned.
    it('rolls the categories into tp1Amount and returns the breakdown', async () => {
      const e = await hire('Cat', 'cat@acme.test');
      const ctx = await employeeCtx(e.personId);
      await submitTp1(ctx, {
        assessmentYear: YEAR,
        categories: { individual: 9000, spouse: 0, children: 4000, medicalInsurance: 1200.5, lifestyle: 2500 },
      });
      const latest = await getTp1(ctx, { assessmentYear: YEAR });
      expect(latest?.tp1Amount).toBe(16700.5); // 9000 + 4000 + 1200.5 + 2500
      // 7ad37961 — `Tp1Categories` is now a UNION (legacy eight-key | TP1-2026 catalogue), so the read
      // side narrows. This fixture submits the LEGACY shape on purpose: the assertion is that a row
      // written the old way still round-trips exactly as it did, which is the whole compatibility claim.
      const legacy = latest?.categories as Tp1LegacyCategories | undefined;
      expect(legacy?.individual).toBe(9000);
      expect(legacy?.medicalInsurance).toBe(1200.5);
      // Unsupplied categories default to 0 (empty = 0, per the plan).
      expect(legacy?.parent).toBe(0);
      expect(legacy?.education).toBe(0);
    });

    // C.2 — the client total is never trusted: only the categories drive tp1Amount.
    it('ignores any client-sent total and computes tp1Amount from categories', async () => {
      const e = await hire('Trust', 'trust@acme.test');
      const ctx = await employeeCtx(e.personId);
      // A hostile/stale tp1Amount is present but categories win.
      await submitTp1(ctx, { assessmentYear: YEAR, tp1Amount: 999999, categories: { individual: 500, lifestyle: 300 } });
      expect((await getTp1(ctx, { assessmentYear: YEAR }))?.tp1Amount).toBe(800);
    });

    // C.3 — a remarks note is stored on the row (free text), rounding is 2dp.
    it('stores remarks and rounds each category to 2dp', async () => {
      const e = await hire('Rem', 'rem@acme.test');
      const ctx = await employeeCtx(e.personId);
      await submitTp1(ctx, { assessmentYear: YEAR, categories: { lifestyle: 100.005, remarks: '  claims Q4  ' } });
      const latest = await getTp1(ctx, { assessmentYear: YEAR });
      expect(latest?.categories?.remarks).toBe('claims Q4'); // trimmed
      expect(latest?.tp1Amount).toBe(100.01); // round2
    });

    // C.4 — per-category non-negative validation.
    it('rejects a negative category amount', async () => {
      const e = await hire('Neg', 'neg@acme.test');
      const ctx = await employeeCtx(e.personId);
      await expect(
        submitTp1(ctx, { assessmentYear: YEAR, categories: { lifestyle: -1 } }),
      ).rejects.toThrow(TaxReliefError);
    });

    // C.5 — sourced cap enforcement (individual RM9000, spouse RM4000). Categories WITHOUT a sourced cap
    // (medical/lifestyle/parent/education/other) are non-negative-only — a large value is accepted.
    it('enforces the sourced individual/spouse caps but not the unsourced ones', async () => {
      const e = await hire('Cap', 'cap@acme.test');
      const ctx = await employeeCtx(e.personId);
      await expect(
        submitTp1(ctx, { assessmentYear: YEAR, categories: { individual: 9001 } }),
      ).rejects.toThrow(TaxReliefError);
      await expect(
        submitTp1(ctx, { assessmentYear: YEAR, categories: { spouse: 4001 } }),
      ).rejects.toThrow(TaxReliefError);
      // No sourced cap on lifestyle yet (ADR-0008) → a large value is allowed.
      await expect(
        submitTp1(ctx, { assessmentYear: YEAR, categories: { lifestyle: 50000 } }),
      ).resolves.toBeTruthy();
    });

    // C.6 — draft edit-in-place then submit-creates-new-row STILL holds with categories (history kept).
    it('keeps the append-only shape with categories (draft in place, submit appends)', async () => {
      const e = await hire('Hist', 'hist@acme.test');
      const ctx = await employeeCtx(e.personId);
      await saveTp1Draft(ctx, { assessmentYear: YEAR, categories: { individual: 100 } });
      await saveTp1Draft(ctx, { assessmentYear: YEAR, categories: { individual: 200, lifestyle: 50 } });
      const drafts = await owner.db
        .select()
        .from(schema.tp1Relief)
        .where(and(eq(schema.tp1Relief.personId, e.personId), eq(schema.tp1Relief.status, 'draft')));
      expect(drafts).toHaveLength(1); // updated in place
      expect(Number(drafts[0].tp1Amount)).toBe(250);
      await submitTp1(ctx, { assessmentYear: YEAR, categories: { individual: 300 } });
      const submitted = await owner.db
        .select()
        .from(schema.tp1Relief)
        .where(and(eq(schema.tp1Relief.personId, e.personId), eq(schema.tp1Relief.status, 'submitted')));
      expect(submitted).toHaveLength(1);
      expect((await getTp1(ctx, { assessmentYear: YEAR }))?.status).toBe('submitted');
    });

    // C.7 — BYTE-STABILITY (the don't-break-PCB gate): a submitted breakdown whose SUM equals a scalar
    // declaration must produce the IDENTICAL fed tp1_deduction, lp, and pcb. Categories never reach the
    // kernel — only the sum does — so the MTD is unchanged. Routed through submitTp1 and then APPROVED (only
    // approved rows feed the prefill, 7ad37961). Two identical employees in ONE Jan batch: A declares via categories summing to
    // 3000, B keys the same 3000 manually; A.pcb must equal B.pcb to the cent.
    it('a category breakdown that sums to X yields the identical PCB as scalar X', async () => {
      const a = adminCtx(base);
      const A = await hire('CatFeedA', 'catfeeda@acme.test');
      const B = await hire('CatFeedB', 'catfeedb@acme.test');
      let ic = 13001;
      for (const e of [A, B]) {
        await setCompensation(a, { employmentId: e.employmentId, basicSalary: 8000, effectiveFrom: '2026-01-01' });
        await setStatutoryProfileMY(a, { personId: e.personId, icNumber: `9002020${ic++}` });
      }
      // A declares a breakdown summing to exactly 3000 (the golden case's TP1).
      const ctxA = await employeeCtx(A.personId);
      await submitTp1(ctxA, { assessmentYear: YEAR, categories: { individual: 1500, medicalInsurance: 1000, lifestyle: 500 } });
      expect((await getTp1(ctxA, { assessmentYear: YEAR }))?.tp1Amount).toBe(3000);
      await approveLatest(a, A.personId, YEAR);

      const { batchId } = await createBatch(a, { companyId: base.companyId, payPeriod: `${YEAR}-01` });
      const r = await prefillTp1FromSelfRelief(a, { batchId });
      expect(r.applied).toBe(1);
      expect(Number((await inputRow(batchId, A.employmentId)).tp1Deduction)).toBe(3000); // ∑LP=0 in Jan

      // B keys the SAME total manually.
      await setPayrollInput(a, { batchId, employmentId: B.employmentId, overtimeAmount: 0, tp1Deduction: 3000 });
      await generatePayslips(a, { batchId });

      const statA = await slipStat(batchId, A.employmentId);
      const statB = await slipStat(batchId, B.employmentId);
      expect(Number(statA.lp)).toBe(3000);
      expect(Number(statA.pcb)).toBe(Number(statB.pcb)); // byte-identical MTD — categories never reach PCB
    });

    // C.8 — BACKWARD COMPATIBILITY: a legacy scalar-only row (categories NULL) still reads and still
    // prefills into PCB exactly as before. Proven by inserting a raw scalar row (no categories) and feeding it.
    it('a legacy scalar-only row (categories NULL) still reads and prefills', async () => {
      const a = adminCtx(base);
      const subject = await hire('Legacy', 'legacy@acme.test');
      await setCompensation(a, { employmentId: subject.employmentId, basicSalary: 8000, effectiveFrom: '2026-01-01' });
      await setStatutoryProfileMY(a, { personId: subject.personId, icNumber: '900303013099' });
      // Raw insert of a legacy row WITHOUT categories (mimics a pre-a2f1fa24 row) — and stamped exactly
      // as MIGRATION 0449 leaves such a row: status 'approved', approved_month 1, no approver. That is
      // the shape every declaration in production has the moment this round deploys, so this fixture is
      // now also the regression guard for the backfill: if the grandfathering were dropped, this case
      // fails with the relief silently gone, which is precisely the production symptom.
      await owner.db.insert(schema.tp1Relief).values({
        tenantId: base.tenantId,
        personId: subject.personId,
        assessmentYear: YEAR,
        status: 'approved',
        tp1Amount: '2000.00',
        submittedAt: new Date(),
        approvedAt: new Date(),
        approvedMonth: 1,
        approvedYear: YEAR,
      });
      const ctx = await employeeCtx(subject.personId);
      const latest = await getTp1(ctx, { assessmentYear: YEAR });
      expect(latest?.tp1Amount).toBe(2000);
      expect(latest?.categories).toBeNull(); // legacy row → no breakdown, reads fine

      const { batchId } = await createBatch(a, { companyId: base.companyId, payPeriod: `${YEAR}-01` });
      await prefillTp1FromSelfRelief(a, { batchId });
      expect(Number((await inputRow(batchId, subject.employmentId)).tp1Deduction)).toBe(2000);
    });

    // C.9 — event coverage + PDPA Layer-0 with categories: the tp1.* events land and the category amounts
    // are ABSENT from the persisted event payloads (only field names are logged).
    it('logs tp1.submitted with categories field name but NO cleartext category amount', async () => {
      const e = await hire('CatPdpa', 'catpdpa@acme.test');
      const ctx = await employeeCtx(e.personId);
      const { id } = await submitTp1(ctx, { assessmentYear: YEAR, categories: { lifestyle: 7654, individual: 3210 } });
      expect(await eventTypesFor(base.tenantId, id)).toContain('tp1.submitted');
      const events = await owner.db
        .select({ payload: schema.domainEvent.payload })
        .from(schema.domainEvent)
        .where(eq(schema.domainEvent.tenantId, base.tenantId));
      const blob = JSON.stringify(events.map((r) => r.payload));
      expect(blob).toContain('categories'); // the field NAME is logged

      // DO NOT SUBSTRING-SEARCH THE BLOB FOR THE AMOUNTS. That is what this test used to do, and it
      // produced a FALSE RED GATE on 2026-08-09: the tenant-wide payload set contains random UUIDs,
      // UUIDs are hex, and hex contains every decimal digit — so `companyId` came back as
      // "907524b4-...-b4c0f7765446", whose tail literally contains "7654". The test file had not been
      // touched since 2026-07-06 and passed on re-run; the collision is luck, roughly one gate in a
      // few hundred, and it will recur. Compare LEAF VALUES instead, which a UUID can never equal,
      // and keep a substring scan only for leaves that are not UUID-shaped so an amount embedded in a
      // message string ("charged 7654") is still caught.
      const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
      const leaves: unknown[] = [];
      const walk = (v: unknown): void => {
        if (v === null || v === undefined) return;
        if (Array.isArray(v)) return v.forEach(walk);
        if (typeof v === 'object') return Object.values(v as Record<string, unknown>).forEach(walk);
        leaves.push(v);
      };
      events.forEach((r) => walk(r.payload));
      for (const amount of [7654, 3210]) {
        expect(leaves, `${amount} logged as a value`).not.toContain(amount);
        expect(leaves, `${amount} logged as a string`).not.toContain(String(amount));
        const embedded = leaves.filter(
          (l) => typeof l === 'string' && !UUID.test(l) && l.includes(String(amount)),
        );
        expect(embedded, `${amount} embedded in a logged string`).toEqual([]);
      }
    });
  });
});
