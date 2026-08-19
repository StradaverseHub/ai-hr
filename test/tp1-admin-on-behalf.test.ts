/**
 * Standardize TP1 Relief (item 0cde61f3) — HR admin-on-behalf on the SAME master record.
 *
 * The HR Payroll TP1 Relief screen now maintains the employee's ACTUAL LHDN TP1 declaration (the
 * tp1_relief master row), not a separate per-batch figure. These tests prove the substrate the rebuilt
 * screen stands on:
 *   (a) an admin reads/writes the SAME single row the employee reads — one declaration per person/year;
 *   (b) an admin submit is a submitted correction (latest-submitted wins) and then feeds payroll via prefill;
 *   (c) a non-admin cannot write another person's declaration (service gate + RLS backstop);
 *   (d) validation parity — the identical category caps and server-computed total apply on the admin path;
 *   (e) audit events carry actor = HR and PDPA Layer-0 field names only (never cleartext amounts).
 */
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import * as schema from '../db/schema';
import type { SessionContext } from '../db/client';
import { hireEmployee } from '../core/org';
import { setCompensation } from '../core/comp';
import { setStatutoryProfileMY } from '../localization/my/statutory';
import { createBatch, prefillTp1FromSelfRelief } from '../core/payroll';
import {
  approveTp1ForPerson,
  getTp1,
  getTp1ForPerson,
  listTp1YearsForPerson,
  saveTp1DraftForPerson,
  submitTp1,
  submitTp1ForPerson,
  TaxReliefError,
} from '../core/tax-relief';
import {
  adminCtx,
  closeAll,
  createAppUser,
  migrateTestDb,
  owner,
  resetDb,
  seedBase,
  type Base,
} from './harness';

const YEAR = 2026;

describe('Standardize TP1 — HR admin-on-behalf', () => {
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

  async function inputRow(batchId: string, employmentId: string) {
    const [row] = await owner.db
      .select()
      .from(schema.payrollInput)
      .where(and(eq(schema.payrollInput.batchId, batchId), eq(schema.payrollInput.employmentId, employmentId)));
    return row;
  }

  function tp1Rows(personId: string) {
    return owner.db.select().from(schema.tp1Relief).where(eq(schema.tp1Relief.personId, personId));
  }

  // (a) single source: admin writes → the employee reads the SAME row; exactly one master per person/year.
  it('admin writes the SAME tp1_relief row the employee reads (no duplicate store)', async () => {
    const e = await hire('Shared', 'shared@acme.test');
    const ctxE = await employeeCtx(e.personId);
    const admin = adminCtx(base);

    // HR submits on behalf.
    const { id: adminRowId } = await submitTp1ForPerson(admin, {
      personId: e.personId,
      assessmentYear: YEAR,
      categories: { individual: 9000, lifestyle: 500 },
    });

    // The employee's OWN self read returns the exact row HR wrote.
    const asEmployee = await getTp1(ctxE, { assessmentYear: YEAR });
    expect(asEmployee?.id).toBe(adminRowId);
    expect(asEmployee?.tp1Amount).toBe(9500);

    // The admin read returns that same row too.
    const asAdmin = await getTp1ForPerson(admin, { personId: e.personId, assessmentYear: YEAR });
    expect(asAdmin?.id).toBe(adminRowId);
    expect(asAdmin?.tp1Amount).toBe(9500);

    // Exactly one submitted row exists — no second/parallel store.
    const all = await tp1Rows(e.personId);
    expect(all.filter((r) => r.status === 'submitted')).toHaveLength(1);
  });

  // (a) bidirectional: an employee's edit is immediately what HR sees, and HR's correction is what the
  // employee then sees — proving both sides operate on one record.
  it('employee edit and HR correction converge on the one record (bidirectional sync)', async () => {
    const e = await hire('Sync', 'sync@acme.test');
    const ctxE = await employeeCtx(e.personId);
    const admin = adminCtx(base);

    // Employee declares first.
    await submitTp1(ctxE, { assessmentYear: YEAR, categories: { individual: 3000 } });
    expect((await getTp1ForPerson(admin, { personId: e.personId, assessmentYear: YEAR }))?.tp1Amount).toBe(3000);

    // HR corrects on behalf; the employee immediately sees HR's figure.
    await submitTp1ForPerson(admin, { personId: e.personId, assessmentYear: YEAR, categories: { individual: 3000, lifestyle: 1200 } });
    expect((await getTp1(ctxE, { assessmentYear: YEAR }))?.tp1Amount).toBe(4200);
  });

  // (b) admin submit = submitted correction (latest wins), then feeds payroll_input via prefill.
  it('admin submit is a submitted correction that latest-wins and then feeds PCB prefill', async () => {
    const admin = adminCtx(base);
    const e = await hire('Feed', 'feed@acme.test');
    await setCompensation(admin, { employmentId: e.employmentId, basicSalary: 8000, effectiveFrom: '2026-01-01' });
    await setStatutoryProfileMY(admin, { personId: e.personId, icNumber: '900101019001' });

    await submitTp1ForPerson(admin, { personId: e.personId, assessmentYear: YEAR, categories: { individual: 1000 } });
    // A second admin submit corrects it; latest-submitted wins, older retained (history).
    await submitTp1ForPerson(admin, { personId: e.personId, assessmentYear: YEAR, categories: { individual: 2500 } });
    expect((await getTp1ForPerson(admin, { personId: e.personId, assessmentYear: YEAR }))?.tp1Amount).toBe(2500);
    const submitted = (await tp1Rows(e.personId)).filter((r) => r.status === 'submitted');
    expect(submitted).toHaveLength(2); // append-only history

    // 7ad37961 — the correction is APPROVED before it can feed. Section F of the official TP1 is the
    // employer's consent, and consent is what turns a claim into an instruction to payroll. The two rows
    // above stay two rows: approval is a decision ABOUT the winning row, not a third declaration.
    const winner = (await getTp1ForPerson(admin, { personId: e.personId, assessmentYear: YEAR }))!;
    await approveTp1ForPerson(admin, {
      personId: e.personId,
      id: winner.id,
      approvedMonth: 1,
      approvedYear: YEAR,
      approverPosition: 'HR Manager',
    });
    expect((await tp1Rows(e.personId))).toHaveLength(2); // still two rows, one of them now approved

    // The monthly PCB feed still flows declaration → payroll via the unchanged prefill bridge.
    const { batchId } = await createBatch(admin, { companyId: base.companyId, payPeriod: `${YEAR}-01` });
    const r = await prefillTp1FromSelfRelief(admin, { batchId });
    expect(r.applied).toBe(1);
    expect(Number((await inputRow(batchId, e.employmentId)).tp1Deduction)).toBe(2500); // latest declaration
    expect((await inputRow(batchId, e.employmentId)).tp1Source).toBe('tp1_self');
  });

  // (c) a non-admin cannot maintain another person's declaration — the service gate throws.
  it('a non-admin cannot write another employee’s declaration (service gate)', async () => {
    const a = await hire('AliceA', 'alicea@acme.test');
    const b = await hire('BobB', 'bobb@acme.test');
    const ctxA = await employeeCtx(a.personId);

    await expect(
      submitTp1ForPerson(ctxA, { personId: b.personId, assessmentYear: YEAR, categories: { individual: 1 } }),
    ).rejects.toThrow(TaxReliefError);
    await expect(
      saveTp1DraftForPerson(ctxA, { personId: b.personId, assessmentYear: YEAR, categories: { individual: 1 } }),
    ).rejects.toThrow(TaxReliefError);
    await expect(
      getTp1ForPerson(ctxA, { personId: b.personId, assessmentYear: YEAR }),
    ).rejects.toThrow(TaxReliefError);

    // Nothing was written for B.
    expect(await tp1Rows(b.personId)).toHaveLength(0);
  });

  // (c) RLS backstop: even if the gate were bypassed, RLS WITH CHECK blocks a non-admin writing a peer.
  it('RLS blocks a non-admin raw write to another person’s tp1_relief', async () => {
    const a = await hire('AliceR', 'alicer@acme.test');
    const b = await hire('BobR', 'bobr@acme.test');
    const ctxA = await employeeCtx(a.personId);
    const { withTenant } = await import('../db/client');
    await expect(
      withTenant(ctxA, async (tx) => {
        await tx
          .insert(schema.tp1Relief)
          .values({ tenantId: ctxA.tenantId, personId: b.personId, assessmentYear: YEAR, status: 'draft', tp1Amount: '1.00' });
      }),
    ).rejects.toThrow();
  });

  // (d) validation parity — identical caps + server-computed total on the admin path.
  it('applies the identical category caps and server-computed total on the admin path', async () => {
    const admin = adminCtx(base);
    const e = await hire('Valid', 'validadmin@acme.test');

    // sourced caps enforced identically (individual RM9000, spouse RM4000).
    await expect(
      submitTp1ForPerson(admin, { personId: e.personId, assessmentYear: YEAR, categories: { individual: 9001 } }),
    ).rejects.toThrow(TaxReliefError);
    await expect(
      submitTp1ForPerson(admin, { personId: e.personId, assessmentYear: YEAR, categories: { spouse: 4001 } }),
    ).rejects.toThrow(TaxReliefError);
    // negative rejected.
    await expect(
      submitTp1ForPerson(admin, { personId: e.personId, assessmentYear: YEAR, categories: { lifestyle: -1 } }),
    ).rejects.toThrow(TaxReliefError);
    // year range enforced.
    await expect(
      submitTp1ForPerson(admin, { personId: e.personId, assessmentYear: 1999, categories: { individual: 1 } }),
    ).rejects.toThrow(TaxReliefError);

    // server sums the categories; a hostile client total is ignored.
    await submitTp1ForPerson(admin, {
      personId: e.personId,
      assessmentYear: YEAR,
      tp1Amount: 999999,
      categories: { individual: 500, lifestyle: 300 },
    });
    expect((await getTp1ForPerson(admin, { personId: e.personId, assessmentYear: YEAR }))?.tp1Amount).toBe(800);
  });

  // (e) audit: actor = HR, PDPA Layer-0 (field names only, never cleartext amounts).
  it('records HR as the actor and logs field names only (PDPA Layer-0)', async () => {
    const admin = adminCtx(base);
    const e = await hire('Audit', 'auditadmin@acme.test');
    const { id } = await submitTp1ForPerson(admin, {
      personId: e.personId,
      assessmentYear: YEAR,
      categories: { individual: 4242, lifestyle: 7373 },
    });

    const [ev] = await owner.db
      .select({ actorType: schema.domainEvent.actorType, actorId: schema.domainEvent.actorId, payload: schema.domainEvent.payload, eventType: schema.domainEvent.eventType })
      .from(schema.domainEvent)
      .where(and(eq(schema.domainEvent.tenantId, base.tenantId), eq(schema.domainEvent.aggregateId, id)));
    expect(ev.eventType).toBe('tp1.submitted');
    expect(ev.actorType).toBe('user');
    expect(ev.actorId).toBe(base.adminUserId); // HR administrator, not the subject employee
    const blob = JSON.stringify(ev.payload);
    expect(blob).toContain('categories'); // field NAME logged
    expect(blob).not.toContain('4242'); // amounts never in the event
    expect(blob).not.toContain('7373');
  });

  // read parity: listTp1YearsForPerson surfaces the same years the employee would see.
  it('listTp1YearsForPerson returns the selected employee’s declaration years', async () => {
    const admin = adminCtx(base);
    const e = await hire('Years', 'yearsadmin@acme.test');
    await submitTp1ForPerson(admin, { personId: e.personId, assessmentYear: 2025, categories: { individual: 1 } });
    await submitTp1ForPerson(admin, { personId: e.personId, assessmentYear: 2026, categories: { individual: 2 } });
    expect((await listTp1YearsForPerson(admin, { personId: e.personId })).sort()).toEqual([2025, 2026]);
  });
});
