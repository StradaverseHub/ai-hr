/**
 * ADR-0035 1B (#17) — per-company payroll scheduling config. Upsert + round-trip; day-of-month values are
 * validated (out-of-range / blank ⇒ null = month-end); each write appends a DomainEvent; config is keyed
 * per company (company A's settings never appear under company B). RLS mirrors company_bank_profile.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import * as schema from '../db/schema';
import { adminCtx, closeAll, eventTypesFor, latestEventPayload, migrateTestDb, owner, resetDb, seedBase, type Base } from './harness';
import { getPayrollConfig, setPayrollConfig } from '../core/payroll-config';
import { resolveProbationMonths } from '../core/org';

let b: Base;

beforeAll(async () => {
  await migrateTestDb();
});
beforeEach(async () => {
  await resetDb();
  b = await seedBase();
});
afterAll(async () => {
  await closeAll();
});

describe('ADR-0035 1B — company payroll config', () => {
  it('upserts + round-trips, validates day-of-month, and logs events', async () => {
    const a = adminCtx(b);
    const { id } = await setPayrollConfig(a, { companyId: b.companyId, cutOffDay: 25, payDay: 28, paymentBasis: 'monthly' });
    let cfg = await getPayrollConfig(a, b.companyId);
    expect(cfg).toMatchObject({ cutOffDay: 25, payDay: 28, paymentBasis: 'monthly' });

    // Update with out-of-range + blank ⇒ null (month-end); unknown basis ⇒ 'monthly'.
    await setPayrollConfig(a, { companyId: b.companyId, cutOffDay: 0, payDay: '', paymentBasis: 'weekly' });
    cfg = await getPayrollConfig(a, b.companyId);
    expect(cfg).toMatchObject({ cutOffDay: null, payDay: null, paymentBasis: 'monthly' });

    // A valid day survives.
    await setPayrollConfig(a, { companyId: b.companyId, cutOffDay: 31 });
    expect((await getPayrollConfig(a, b.companyId))?.cutOffDay).toBe(31);

    expect(await eventTypesFor(b.tenantId, id)).toEqual([
      'company.payroll-config.created',
      'company.payroll-config.updated',
      'company.payroll-config.updated',
    ]);
  });

  it('round-trips the four per-purpose cut-off days + non-monthly basis, and folds them into the event payload', async () => {
    const a = adminCtx(b);
    const { id } = await setPayrollConfig(a, {
      companyId: b.companyId,
      overtimeCutOffDay: 20,
      claimCutOffDay: 15,
      unpaidLeaveCutOffDay: 25,
      attendanceCutOffDay: 28,
      paymentBasis: 'daily',
    });
    expect(await getPayrollConfig(a, b.companyId)).toMatchObject({
      overtimeCutOffDay: 20,
      claimCutOffDay: 15,
      unpaidLeaveCutOffDay: 25,
      attendanceCutOffDay: 28,
      paymentBasis: 'daily',
    });

    // The created event payload spreads the normalised values verbatim (substrate coverage).
    const payload = await latestEventPayload(b.tenantId, id, 'company.payroll-config.created');
    expect(payload).toMatchObject({
      companyId: b.companyId,
      overtimeCutOffDay: 20,
      claimCutOffDay: 15,
      unpaidLeaveCutOffDay: 25,
      attendanceCutOffDay: 28,
      paymentBasis: 'daily',
    });
  });

  it('validates cut-off days (out-of-range / blank ⇒ null, 31 survives) and non-monthly basis', async () => {
    const a = adminCtx(b);
    // 31 is accepted (month-length-agnostic; null = month-end, same as cutOffDay); 'hourly' survives.
    await setPayrollConfig(a, { companyId: b.companyId, overtimeCutOffDay: 31, paymentBasis: 'hourly' });
    expect(await getPayrollConfig(a, b.companyId)).toMatchObject({ overtimeCutOffDay: 31, paymentBasis: 'hourly' });

    // Out-of-range (0, 32) and blank ⇒ null; unknown basis ('weekly') still ⇒ 'monthly'.
    await setPayrollConfig(a, {
      companyId: b.companyId,
      overtimeCutOffDay: 0,
      claimCutOffDay: 32,
      unpaidLeaveCutOffDay: '',
      attendanceCutOffDay: null,
      paymentBasis: 'weekly',
    });
    expect(await getPayrollConfig(a, b.companyId)).toMatchObject({
      overtimeCutOffDay: null,
      claimCutOffDay: null,
      unpaidLeaveCutOffDay: null,
      attendanceCutOffDay: null,
      paymentBasis: 'monthly',
    });
  });

  it('does NOT enforce cross-field cut-off ordering — a nonsensical ordering stores without error', async () => {
    // Deliberate non-validation (documented): attendance cut-off after pay day is stored as-is.
    const a = adminCtx(b);
    await setPayrollConfig(a, { companyId: b.companyId, payDay: 1, attendanceCutOffDay: 28 });
    expect(await getPayrollConfig(a, b.companyId)).toMatchObject({ payDay: 1, attendanceCutOffDay: 28 });
  });

  it('keys config per company — A does not leak into B', async () => {
    const a = adminCtx(b);
    const [c2] = await owner.db
      .insert(schema.company)
      .values({ tenantId: b.tenantId, legalName: 'Acme Two Sdn Bhd' })
      .returning({ id: schema.company.id });

    await setPayrollConfig(a, { companyId: b.companyId, cutOffDay: 20 });
    expect((await getPayrollConfig(a, b.companyId))?.cutOffDay).toBe(20);
    expect(await getPayrollConfig(a, c2.id)).toBeNull();
  });

  // ── Configurable default probation months (ADR-0068) ─────────────────────────
  it('round-trips probationMonths, rejects <= 0 → null, and a NULL config reads back as default 3 (via resolveProbationMonths)', async () => {
    const a = adminCtx(b);
    // A positive integer persists (no arbitrary upper clamp).
    await setPayrollConfig(a, { companyId: b.companyId, probationMonths: 6 });
    expect((await getPayrollConfig(a, b.companyId))?.probationMonths).toBe(6);
    await setPayrollConfig(a, { companyId: b.companyId, probationMonths: 24 });
    expect((await getPayrollConfig(a, b.companyId))?.probationMonths).toBe(24);

    // <= 0 and blank ⇒ null (= default 3, resolved at compute time). No upper clamp is applied.
    await setPayrollConfig(a, { companyId: b.companyId, probationMonths: 0 });
    expect((await getPayrollConfig(a, b.companyId))?.probationMonths).toBeNull();
    await setPayrollConfig(a, { companyId: b.companyId, probationMonths: '' });
    expect((await getPayrollConfig(a, b.companyId))?.probationMonths).toBeNull();

    // resolveProbationMonths maps null/legacy → 3, and honours any positive value.
    expect(resolveProbationMonths(null)).toBe(3);
    expect(resolveProbationMonths(undefined)).toBe(3);
    expect(resolveProbationMonths(0)).toBe(3);
    expect(resolveProbationMonths(6)).toBe(6);
  });

  it('saving probationMonths leaves the cut-off days UNTOUCHED (clobber-upsert regression guard)', async () => {
    const a = adminCtx(b);
    // First set the schedule + cut-offs.
    await setPayrollConfig(a, {
      companyId: b.companyId,
      cutOffDay: 25,
      payDay: 28,
      overtimeCutOffDay: 20,
      claimCutOffDay: 15,
    });
    // A subsequent save must thread the SAME cut-off values through (the single-form writer), so cut-off
    // days stay intact when probationMonths is set alongside them (the plan's clobber hazard).
    await setPayrollConfig(a, {
      companyId: b.companyId,
      cutOffDay: 25,
      payDay: 28,
      overtimeCutOffDay: 20,
      claimCutOffDay: 15,
      probationMonths: 6,
    });
    expect(await getPayrollConfig(a, b.companyId)).toMatchObject({
      cutOffDay: 25,
      payDay: 28,
      overtimeCutOffDay: 20,
      claimCutOffDay: 15,
      probationMonths: 6,
    });
  });
});
