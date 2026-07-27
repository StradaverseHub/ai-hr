/**
 * ADR-0069 — Configurable Payroll Cycle master. CRUD + integrity, the DomainEvent substrate, the RLS split
 * (tenant-wide read, admin-for-payroll write via can_admin_payroll_for), the two app-level validations
 * (case-insensitive duplicate name; only one active regular-mapped cycle), and the delete-guard that
 * blocks deleting a cycle matched against EXISTING payroll_batch rows by run_type — proving the historical-
 * data case, not just new-row tracing. Plus the wizard flag-filter rule (visibility gated by the
 * `multi_cycle_payroll` MODULE ENTITLEMENT) exercised through the real service.
 *
 * ADR-0077 slice 3 — the wizard/kernel gate moved from the MULTI_CYCLE_PAYROLL_ENABLED deployment flag
 * into `tenant_module`, so the three tests that care about it now write a ROW (setModule) and read it
 * back through `entitledCtx` + the real `isModuleEnabled` predicate. `adminCtx` cannot carry the grant:
 * its snapshot is `legacyEnabledModulesIn(process.env)`, a point-in-time copy taken before the row is
 * written, and test/env.ts deletes the flag — so under it `multi_cycle_payroll` reads DISABLED whatever
 * rows the tenant holds. The afterEach that deleted the env var is gone: resetDb truncates
 * tenant_module and seedBase seeds no row for this code, so OFF is the baseline by construction.
 */
import { and, eq } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import * as schema from '../db/schema';
import {
  adminCtx,
  closeAll,
  entitledCtx,
  eventTypesFor,
  migrateTestDb,
  owner,
  resetDb,
  seedBase,
  setModule,
  type Base,
} from './harness';
import { isModuleEnabled } from '../core/entitlements';
import { createCompany } from '../core/admin';
import { hireEmployee } from '../core/org';
import { setCompensation } from '../core/comp';
import { setStatutoryProfileMY } from '../localization/my/statutory';
import { createAdditionalRun, createBatch, generatePayslips } from '../core/payroll';
import {
  DEFAULT_PAYROLL_CYCLES,
  copyPayrollCycleToCompanies,
  deletePayrollCycle,
  getActivePayrollCycle,
  listPayrollCycles,
  seedPayrollCycleCatalog,
  setPayrollCycleActive,
  upsertPayrollCycle,
  PayrollCycleDuplicateNameError,
  PayrollCycleInUseError,
  PayrollCycleRegularConflictError,
} from '../core/payroll-cycle';
import { type SessionContext } from '../db/client';

let b: Base;

/** A payroll admin (hr_admin) scoped to a company — carries the grant so authz + RLS see it. */
async function adminFor(companyId: string | null): Promise<SessionContext> {
  const [u] = await owner.db
    .insert(schema.appUser)
    .values({ tenantId: b.tenantId, workosUserId: `user_${randomUUID()}`, personId: null })
    .returning({ id: schema.appUser.id });
  await owner.db.insert(schema.roleAssignment).values({ tenantId: b.tenantId, appUserId: u.id, companyId, role: 'hr_admin' });
  return { tenantId: b.tenantId, userId: u.id, grants: [{ role: 'hr_admin', companyId }] };
}

/** A non-admin employee — used to prove tenant-wide READ works and WRITE is blocked. */
async function employeeCtx(): Promise<SessionContext> {
  const [u] = await owner.db
    .insert(schema.appUser)
    .values({ tenantId: b.tenantId, workosUserId: `user_${randomUUID()}`, personId: null })
    .returning({ id: schema.appUser.id });
  await owner.db.insert(schema.roleAssignment).values({ tenantId: b.tenantId, appUserId: u.id, companyId: null, role: 'employee' });
  return { tenantId: b.tenantId, userId: u.id, grants: [{ role: 'employee', companyId: null }] };
}

beforeAll(async () => {
  await migrateTestDb();
});
afterAll(async () => {
  await closeAll();
});
beforeEach(async () => {
  await resetDb();
  // No `multi_cycle_payroll` grant here, and no cleanup hook either: `seedBase` seeds NO row for that
  // code (it narrows the parity set by the live env, and test/env.ts deletes the flag) and a missing
  // row is DISABLED (C7), while `resetDb` truncates `tenant_module` between tests. So OFF is the
  // baseline by construction, and the three tests that need it ON state their own grant inline.
  b = await seedBase();
});

describe('payroll cycle master (ADR-0069)', () => {
  it('seeds the default catalog idempotently, ordered by sortOrder then name', async () => {
    const a = adminCtx(b);
    const r1 = await seedPayrollCycleCatalog(a, b.companyId);
    expect(r1.created).toBe(DEFAULT_PAYROLL_CYCLES.length);
    // Re-seed is a no-op (idempotent by name).
    const r2 = await seedPayrollCycleCatalog(a, b.companyId);
    expect(r2.created).toBe(0);

    const cycles = await listPayrollCycles(a, b.companyId);
    expect(cycles.map((c) => c.name)).toEqual(DEFAULT_PAYROLL_CYCLES.map((c) => c.name)); // sortOrder preserves seed order
    // The two off_cycle presets carry their remarks label (the delete-guard traces history by it).
    const advance = cycles.find((c) => c.name === 'Advance Salary');
    expect(advance?.runType).toBe('off_cycle');
    expect(advance?.remarks).toBe('Advance Salary');
    const regular = cycles.find((c) => c.name === 'Monthly');
    expect(regular?.runType).toBe('regular');
  });

  it('creates, updates (name/runType/remarks/sortOrder) and lists', async () => {
    const a = adminCtx(b);
    const { id } = await upsertPayrollCycle(a, { companyId: b.companyId, name: 'Year-End Bonus', runType: 'bonus', sortOrder: 5 });
    const [row] = await owner.db.select().from(schema.payrollCycle).where(eq(schema.payrollCycle.id, id));
    expect(row.name).toBe('Year-End Bonus');
    expect(row.runType).toBe('bonus');
    expect(row.sortOrder).toBe(5);
    expect(row.archivedAt).toBeNull();

    await upsertPayrollCycle(a, { id, companyId: b.companyId, name: 'Annual Bonus', runType: 'bonus', remarks: 'note', sortOrder: 2 });
    const [u] = await owner.db.select().from(schema.payrollCycle).where(eq(schema.payrollCycle.id, id));
    expect(u.name).toBe('Annual Bonus');
    expect(u.remarks).toBe('note');
    expect(u.sortOrder).toBe(2);
  });

  it('rejects a case-insensitive duplicate name in the same company; a different company may reuse it', async () => {
    const a = adminCtx(b);
    await upsertPayrollCycle(a, { companyId: b.companyId, name: 'Special', runType: 'off_cycle' });
    await expect(upsertPayrollCycle(a, { companyId: b.companyId, name: 'special', runType: 'bonus' })).rejects.toBeInstanceOf(
      PayrollCycleDuplicateNameError,
    );
    // A different company may reuse the name (per-company uniqueness).
    const { id: coB } = await createCompany(a, { legalName: 'Cycle Co B Sdn Bhd' });
    const { id } = await upsertPayrollCycle(a, { companyId: coB, name: 'Special', runType: 'off_cycle' });
    expect(id).toBeTruthy();
  });

  it('allows at most one ACTIVE regular-mapped cycle per company (create + update + reactivate)', async () => {
    const a = adminCtx(b);
    await upsertPayrollCycle(a, { companyId: b.companyId, name: 'Monthly', runType: 'regular' });
    // A second active regular is rejected on create.
    await expect(upsertPayrollCycle(a, { companyId: b.companyId, name: 'Monthly 2', runType: 'regular' })).rejects.toBeInstanceOf(
      PayrollCycleRegularConflictError,
    );
    // A non-regular cycle can be created, then updating it to regular is rejected (would make a 2nd active regular).
    const { id: off } = await upsertPayrollCycle(a, { companyId: b.companyId, name: 'Off', runType: 'off_cycle' });
    await expect(upsertPayrollCycle(a, { id: off, companyId: b.companyId, name: 'Off', runType: 'regular' })).rejects.toBeInstanceOf(
      PayrollCycleRegularConflictError,
    );
    // Deactivate the original regular; NOW a second regular can be created.
    const [reg] = await owner.db.select().from(schema.payrollCycle).where(and(eq(schema.payrollCycle.companyId, b.companyId), eq(schema.payrollCycle.name, 'Monthly')));
    await setPayrollCycleActive(a, { id: reg.id, active: false });
    const { id: reg2 } = await upsertPayrollCycle(a, { companyId: b.companyId, name: 'New Monthly', runType: 'regular' });
    expect(reg2).toBeTruthy();
    // Re-activating the first regular is now rejected (New Monthly is the active one).
    await expect(setPayrollCycleActive(a, { id: reg.id, active: true })).rejects.toBeInstanceOf(PayrollCycleRegularConflictError);
  });

  it('activate/deactivate include/exclude from activeOnly queries', async () => {
    const a = adminCtx(b);
    const { id } = await upsertPayrollCycle(a, { companyId: b.companyId, name: 'Toggle', runType: 'bonus' });
    expect((await listPayrollCycles(a, b.companyId, { activeOnly: true })).map((c) => c.id)).toContain(id);
    await setPayrollCycleActive(a, { id, active: false });
    expect((await listPayrollCycles(a, b.companyId, { activeOnly: true })).map((c) => c.id)).not.toContain(id);
    // Still visible in the unfiltered list.
    expect((await listPayrollCycles(a, b.companyId)).map((c) => c.id)).toContain(id);
    await setPayrollCycleActive(a, { id, active: true });
    expect((await listPayrollCycles(a, b.companyId, { activeOnly: true })).map((c) => c.id)).toContain(id);
  });

  it('delete-guard blocks deletion of a cycle referenced by EXISTING payroll history (matched by run_type)', async () => {
    // `createAdditionalRun` below is gated on the `multi_cycle_payroll` entitlement, so grant the ROW —
    // and resolve the session AFTER it, because a snapshot is a point-in-time read.
    await setModule(b.tenantId, 'multi_cycle_payroll', 'active');
    const a = await entitledCtx(b);
    await seedPayrollCycleCatalog(a, b.companyId);
    // Build real payroll history: a regular run (creates the pay_period) + a bonus run.
    const e = await hireEmployee(a, {
      person: { fullName: 'Cyc Emp', primaryEmail: 'cyc@acme.test' },
      companyId: b.companyId,
      departmentId: b.deptA,
      employmentType: 'full_time',
      hiredOn: '2025-01-01',
    });
    await setCompensation(a, { employmentId: e.employmentId, basicSalary: 5000, monthlyAllowance: 0, effectiveFrom: '2025-01-01' });
    await setStatutoryProfileMY(a, { personId: e.personId, icNumber: '900101011234' });
    const reg = await createBatch(a, { companyId: b.companyId, payPeriod: '2026-05' });
    await generatePayslips(a, { batchId: reg.batchId });
    await createAdditionalRun(a, { companyId: b.companyId, payPeriod: '2026-05', runType: 'bonus' });

    const cycles = await listPayrollCycles(a, b.companyId);
    const monthly = cycles.find((c) => c.name === 'Monthly')!; // runType regular — a regular batch exists
    const bonus = cycles.find((c) => c.name === 'Bonus')!; // runType bonus — a bonus batch exists
    const adjustment = cycles.find((c) => c.name === 'Adjustment')!; // runType adjustment — NO batch

    await expect(deletePayrollCycle(a, monthly.id)).rejects.toBeInstanceOf(PayrollCycleInUseError);
    await expect(deletePayrollCycle(a, bonus.id)).rejects.toBeInstanceOf(PayrollCycleInUseError);
    // An unreferenced cycle deletes fine.
    await deletePayrollCycle(a, adjustment.id);
    expect((await listPayrollCycles(a, b.companyId)).map((c) => c.id)).not.toContain(adjustment.id);
  });

  it('delete-guard: an off_cycle preset only owns batches carrying its own remarks label', async () => {
    // Same gate as the test above: the off_cycle batch this test traces is created by the entitled
    // `createAdditionalRun` path, so grant the row first and resolve the snapshot after it.
    await setModule(b.tenantId, 'multi_cycle_payroll', 'active');
    const a = await entitledCtx(b);
    await seedPayrollCycleCatalog(a, b.companyId);
    const e = await hireEmployee(a, {
      person: { fullName: 'Preset Emp', primaryEmail: 'preset@acme.test' },
      companyId: b.companyId,
      departmentId: b.deptA,
      employmentType: 'full_time',
      hiredOn: '2025-01-01',
    });
    await setCompensation(a, { employmentId: e.employmentId, basicSalary: 5000, monthlyAllowance: 0, effectiveFrom: '2025-01-01' });
    await setStatutoryProfileMY(a, { personId: e.personId, icNumber: '900101011234' });
    const reg = await createBatch(a, { companyId: b.companyId, payPeriod: '2026-06' });
    await generatePayslips(a, { batchId: reg.batchId });
    // An off_cycle batch labelled 'Advance Salary'.
    await createAdditionalRun(a, { companyId: b.companyId, payPeriod: '2026-06', runType: 'off_cycle', remarks: 'Advance Salary' });

    const cycles = await listPayrollCycles(a, b.companyId);
    const advance = cycles.find((c) => c.name === 'Advance Salary')!; // remarks 'Advance Salary' — a batch exists
    const midMonth = cycles.find((c) => c.name === 'Mid-Month')!; // remarks 'Mid-Month' — NO matching batch

    await expect(deletePayrollCycle(a, advance.id)).rejects.toBeInstanceOf(PayrollCycleInUseError);
    // Mid-Month has no batch with its label → deletes fine (distinct presets don't block each other).
    await deletePayrollCycle(a, midMonth.id);
    expect((await listPayrollCycles(a, b.companyId)).map((c) => c.id)).not.toContain(midMonth.id);
  });

  it('getActivePayrollCycle resolves an active row for its company; rejects archived / cross-company', async () => {
    const a = adminCtx(b);
    const { id } = await upsertPayrollCycle(a, { companyId: b.companyId, name: 'Resolve', runType: 'off_cycle', remarks: 'X' });
    const ok = await getActivePayrollCycle(a, id, b.companyId);
    expect(ok?.runType).toBe('off_cycle');
    expect(ok?.remarks).toBe('X');
    // Archived → null.
    await setPayrollCycleActive(a, { id, active: false });
    expect(await getActivePayrollCycle(a, id, b.companyId)).toBeNull();
    // Reactivate, then a wrong company → null.
    await setPayrollCycleActive(a, { id, active: true });
    const { id: coB } = await createCompany(a, { legalName: 'Resolve Co B Sdn Bhd' });
    expect(await getActivePayrollCycle(a, id, coB)).toBeNull();
  });

  it('appends payroll-cycle.created / updated / activated / deactivated / deleted events (substrate)', async () => {
    const a = adminCtx(b);
    const { id } = await upsertPayrollCycle(a, { companyId: b.companyId, name: 'Ev', runType: 'bonus' });
    await upsertPayrollCycle(a, { id, companyId: b.companyId, name: 'Ev2', runType: 'bonus' });
    await setPayrollCycleActive(a, { id, active: false });
    await setPayrollCycleActive(a, { id, active: true });
    await deletePayrollCycle(a, id);
    const types = await eventTypesFor(b.tenantId, id);
    expect(types).toEqual(
      expect.arrayContaining([
        'payroll-cycle.created',
        'payroll-cycle.updated',
        'payroll-cycle.deactivated',
        'payroll-cycle.activated',
        'payroll-cycle.deleted',
      ]),
    );
  });

  it('RLS: read is TENANT-WIDE (a non-admin can SELECT cycles) but WRITE is admin-for-payroll only', async () => {
    const a = adminCtx(b);
    const { id } = await upsertPayrollCycle(a, { companyId: b.companyId, name: 'RlsCycle', runType: 'off_cycle' });

    // Tenant-wide read: a plain employee can SEE the cycle (the wizard dropdown reads it under any session).
    const emp = await employeeCtx();
    expect((await listPayrollCycles(emp, b.companyId)).map((c) => c.id)).toContain(id);

    // Write scoping: an admin scoped to ANOTHER company cannot create under company A, nor update A's row.
    const { id: coB } = await createCompany(a, { legalName: 'Rls Co B Sdn Bhd' });
    const adminB = await adminFor(coB);
    await expect(upsertPayrollCycle(adminB, { companyId: b.companyId, name: 'Hack', runType: 'bonus' })).rejects.toThrow();
    await upsertPayrollCycle(adminB, { id, companyId: b.companyId, name: 'Hacked', runType: 'off_cycle' }).catch(() => {});
    const [row] = await owner.db.select().from(schema.payrollCycle).where(eq(schema.payrollCycle.id, id));
    expect(row.name).toBe('RlsCycle');
  });

  it('GRANT regression: a real ai_hr_app payroll admin can INSERT…RETURNING, read, and update (not fail-closed)', async () => {
    const adminA = await adminFor(b.companyId);
    const { id } = await upsertPayrollCycle(adminA, { companyId: b.companyId, name: 'GrantCycle', runType: 'bonus' });
    expect(id).toBeTruthy();
    expect((await listPayrollCycles(adminA, b.companyId)).map((c) => c.id)).toContain(id);
    await upsertPayrollCycle(adminA, { id, companyId: b.companyId, name: 'GrantCycle2', runType: 'bonus' });
    expect((await listPayrollCycles(adminA, b.companyId)).find((c) => c.id === id)?.name).toBe('GrantCycle2');
  });

  it('description (Processing Behaviour note) round-trips create → list → update; updated event carries before/after', async () => {
    const a = adminCtx(b);
    const { id } = await upsertPayrollCycle(a, {
      companyId: b.companyId,
      name: 'Noted',
      runType: 'bonus',
      description: 'Paid after board approval.',
    });
    expect((await listPayrollCycles(a, b.companyId)).find((c) => c.id === id)?.description).toBe('Paid after board approval.');
    expect((await getActivePayrollCycle(a, id, b.companyId))?.description).toBe('Paid after board approval.');

    await upsertPayrollCycle(a, { id, companyId: b.companyId, name: 'Noted', runType: 'bonus', description: 'Paid twice a year.' });
    expect((await listPayrollCycles(a, b.companyId)).find((c) => c.id === id)?.description).toBe('Paid twice a year.');

    // Clearing to empty normalises to null.
    await upsertPayrollCycle(a, { id, companyId: b.companyId, name: 'Noted', runType: 'bonus', description: '   ' });
    expect((await listPayrollCycles(a, b.companyId)).find((c) => c.id === id)?.description).toBeNull();

    // The .updated event payload carries description in before/after.
    const [ev] = await owner.db
      .select()
      .from(schema.domainEvent)
      .where(and(eq(schema.domainEvent.aggregateId, id), eq(schema.domainEvent.eventType, 'payroll-cycle.updated')))
      .orderBy(schema.domainEvent.sequence);
    const payload = ev.payload as { before: { description: string | null }; after: { description: string | null } };
    expect(payload.after).toHaveProperty('description');
    expect(payload.before).toHaveProperty('description');
  });

  it('copy-to-companies clones the definition into target companies; source untouched', async () => {
    const a = adminCtx(b);
    const { id: coB } = await createCompany(a, { legalName: 'Copy Target B Sdn Bhd' });
    const { id: coC } = await createCompany(a, { legalName: 'Copy Target C Sdn Bhd' });
    const { id: src } = await upsertPayrollCycle(a, {
      companyId: b.companyId,
      name: 'Shared Bonus',
      runType: 'bonus',
      remarks: 'lbl',
      description: 'Group-wide bonus run.',
      sortOrder: 7,
    });

    const { results } = await copyPayrollCycleToCompanies(a, { id: src, companyIds: [coB, coC] });
    expect(results.every((r) => r.outcome === 'created')).toBe(true);

    for (const co of [coB, coC]) {
      const clone = (await listPayrollCycles(a, co)).find((c) => c.name === 'Shared Bonus');
      expect(clone).toBeTruthy();
      expect(clone?.runType).toBe('bonus');
      expect(clone?.remarks).toBe('lbl');
      expect(clone?.description).toBe('Group-wide bonus run.');
      expect(clone?.sortOrder).toBe(7);
      expect(clone?.companyId).toBe(co);
    }
    // Source company's row is unchanged and NOT duplicated.
    expect((await listPayrollCycles(a, b.companyId)).filter((c) => c.name === 'Shared Bonus')).toHaveLength(1);
  });

  it('copy skips a live duplicate name and a regular-conflict target; other targets still succeed', async () => {
    const a = adminCtx(b);
    // 361e3b15: createCompany now auto-seeds the standard cycle catalog (incl. a 'Monthly' regular cycle), so
    // this test builds its EXACT duplicate / regular-conflict / free fixtures on companies inserted directly
    // (empty), exactly as the copy-skip behaviour under test requires. The assertions below are unchanged.
    const [dc] = await owner.db.insert(schema.company).values({ tenantId: b.tenantId, legalName: 'Dup Co Sdn Bhd' }).returning({ id: schema.company.id });
    const [rc] = await owner.db.insert(schema.company).values({ tenantId: b.tenantId, legalName: 'Reg Co Sdn Bhd' }).returning({ id: schema.company.id });
    const [fc] = await owner.db.insert(schema.company).values({ tenantId: b.tenantId, legalName: 'Free Co Sdn Bhd' }).returning({ id: schema.company.id });
    const dupCo = dc.id;
    const regCo = rc.id;
    const freeCo = fc.id;

    // Regular source cycle to copy.
    const { id: src } = await upsertPayrollCycle(a, { companyId: b.companyId, name: 'Monthly', runType: 'regular' });
    // dupCo already has a LIVE cycle with the same name.
    await upsertPayrollCycle(a, { companyId: dupCo, name: 'Monthly', runType: 'off_cycle' });
    // regCo already has an active regular cycle under a different name.
    await upsertPayrollCycle(a, { companyId: regCo, name: 'Payroll', runType: 'regular' });

    const { results } = await copyPayrollCycleToCompanies(a, { id: src, companyIds: [dupCo, regCo, freeCo] });
    const by = Object.fromEntries(results.map((r) => [r.companyId, r.outcome]));
    expect(by[dupCo]).toBe('skipped_duplicate');
    expect(by[regCo]).toBe('skipped_regular_conflict');
    expect(by[freeCo]).toBe('created');
    // freeCo got the clone.
    expect((await listPayrollCycles(a, freeCo)).some((c) => c.name === 'Monthly' && c.runType === 'regular')).toBe(true);
  });

  it('copy appends one payroll-cycle.created per clone (with copiedFromCycleId) and one .copied summary on the source', async () => {
    const a = adminCtx(b);
    const { id: coB } = await createCompany(a, { legalName: 'Ev Copy B Sdn Bhd' });
    const { id: src } = await upsertPayrollCycle(a, { companyId: b.companyId, name: 'EvCopy', runType: 'bonus' });
    const { results } = await copyPayrollCycleToCompanies(a, { id: src, companyIds: [coB] });
    const cloneId = results.find((r) => r.outcome === 'created')?.id!;

    // The clone carries a created event with provenance.
    const [created] = await owner.db
      .select()
      .from(schema.domainEvent)
      .where(and(eq(schema.domainEvent.aggregateId, cloneId), eq(schema.domainEvent.eventType, 'payroll-cycle.created')));
    expect((created.payload as { copiedFromCycleId?: string }).copiedFromCycleId).toBe(src);

    // The source carries a single .copied summary event listing the target/outcome.
    const [copied] = await owner.db
      .select()
      .from(schema.domainEvent)
      .where(and(eq(schema.domainEvent.aggregateId, src), eq(schema.domainEvent.eventType, 'payroll-cycle.copied')));
    const targets = (copied.payload as { targets: { companyId: string; outcome: string }[] }).targets;
    expect(targets).toEqual([{ companyId: coB, outcome: 'created', newCycleId: cloneId }]);
  });

  it('RLS: an admin without can_admin_payroll_for on a target company cannot copy into it (insert fails closed)', async () => {
    const adminA = await adminFor(b.companyId);
    // A company the admin does NOT administer (created via owner so no grant to adminA).
    const [coX] = await owner.db
      .insert(schema.company)
      .values({ tenantId: b.tenantId, legalName: 'Unadministered Co Sdn Bhd' })
      .returning({ id: schema.company.id });
    const { id: src } = await upsertPayrollCycle(adminA, { companyId: b.companyId, name: 'RlsCopy', runType: 'bonus' });
    await expect(copyPayrollCycleToCompanies(adminA, { id: src, companyIds: [coX.id] })).rejects.toThrow();
    // Nothing was written into the un-administered company.
    expect(await owner.db.select().from(schema.payrollCycle).where(eq(schema.payrollCycle.companyId, coX.id))).toHaveLength(0);
  });

  it('wizard flag-filter: with multi_cycle_payroll off, only regular-mapped cycles are exposed even when non-regular are active', async () => {
    // The service returns the full active list; the wizard filter is the entitlement rule. Assert the
    // rule the wizard applies (app/payroll/process/page.tsx:40 —
    // `const multiCycle = isModuleEnabled(s, 'multi_cycle_payroll')`) using the REAL predicate against
    // a REAL snapshot, so the branch is decided by the tenant's row rather than by re-reading whatever
    // this test just wrote into the environment (which is what the pre-slice-3 version did).
    const a = adminCtx(b);
    await seedPayrollCycleCatalog(a, b.companyId);
    const active = await listPayrollCycles(a, b.companyId, { activeOnly: true });
    expect(active.length).toBe(DEFAULT_PAYROLL_CYCLES.length); // all active

    // Gate OFF = NO row (C7: a missing row is disabled, and that is a different state from an explicit
    // status='disabled' row). Stated explicitly rather than leaning on seedBase's omission, so the
    // disabled state this half asserts is written where it is asserted.
    await setModule(b.tenantId, 'multi_cycle_payroll', null);
    const off = await entitledCtx(b);
    const multiCycle = isModuleEnabled(off, 'multi_cycle_payroll');
    expect(multiCycle).toBe(false); // the gate really is closed — not a filter that happens to match
    const shown = multiCycle ? active : active.filter((c) => c.runType === 'regular');
    expect(shown.every((c) => c.runType === 'regular')).toBe(true);
    expect(shown.map((c) => c.name)).toEqual(['Monthly']); // only the one regular-mapped cycle

    // With the module ON, the full active list is shown (no code change — the same list).
    await setModule(b.tenantId, 'multi_cycle_payroll', 'active');
    const on = await entitledCtx(b);
    const multiOn = isModuleEnabled(on, 'multi_cycle_payroll');
    expect(multiOn).toBe(true); // the grant really did open the gate
    const shownOn = multiOn ? active : active.filter((c) => c.runType === 'regular');
    expect(shownOn.length).toBe(DEFAULT_PAYROLL_CYCLES.length);
  });
});
