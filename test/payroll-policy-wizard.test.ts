/**
 * 61d77e82 — Payroll Policies wizard redesign, service-level guarantees for the two net-new data touches:
 *   • Policy Code (nullable text column): persisted on create/update, carried by copy, absent ⇒ NULL (legacy).
 *   • Draft status: createPolicy(status:'draft') is stored but NEVER assignable (listAssignablePolicies excludes
 *     it) and NEVER computed (resolveAssignedPolicy returns null for a draft, so the kernel falls back to the
 *     monthly default). Activating a draft makes it assignable/computable again.
 * The UI re-layout (9-step wizard) reuses the SAME field names + configFromForm, so the golden calc matrix
 * (payroll-policy-config.test.ts) already proves the calculation is byte-identical; this file covers only the
 * additive service surface.
 */
import { and, eq } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import * as schema from '../db/schema';
import { withTenant } from '../db/client';
import { hireEmployee } from '../core/org';
import {
  assignPolicy,
  copyPolicy,
  createPolicy,
  getPolicy,
  listAssignablePolicies,
  resolveAssignedPolicy,
  setStatus,
  updatePolicy,
} from '../core/payroll-policy';
import { adminCtx, closeAll, eventTypesFor, migrateTestDb, resetDb, seedBase, type Base } from './harness';

let b: Base;

const hire = (name: string) =>
  hireEmployee(adminCtx(b), {
    person: { fullName: name, primaryEmail: `ppw_${randomUUID().slice(0, 8)}@t.local` },
    companyId: b.companyId,
    departmentId: b.deptA,
    employmentType: 'full_time',
    hiredOn: '2024-01-01',
  });

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

describe('61d77e82 — Policy Code + Draft status', () => {
  it('persists a Policy Code on create and carries it through copy; absent ⇒ NULL (legacy behaviour)', async () => {
    const a = adminCtx(b);
    const { id } = await createPolicy(a, { companyId: b.companyId, name: 'Coded', code: 'STD-MTH', policyType: 'monthly' });
    expect((await getPolicy(a, id))?.code).toBe('STD-MTH');

    // Copy preserves the code.
    const { id: copyId } = await copyPolicy(a, { sourceId: id, name: 'Coded (copy)' });
    expect((await getPolicy(a, copyId))?.code).toBe('STD-MTH');

    // No code supplied ⇒ NULL (today's exact behaviour, byte-identical).
    const { id: bare } = await createPolicy(a, { companyId: b.companyId, name: 'Uncoded', policyType: 'monthly' });
    expect((await getPolicy(a, bare))?.code).toBeNull();
  });

  it('updates the Policy Code and clears it back to NULL', async () => {
    const a = adminCtx(b);
    const { id } = await createPolicy(a, { companyId: b.companyId, name: 'Editable', code: 'OLD', policyType: 'monthly' });
    await updatePolicy(a, { id, code: 'NEW' });
    expect((await getPolicy(a, id))?.code).toBe('NEW');
    await updatePolicy(a, { id, code: null });
    expect((await getPolicy(a, id))?.code).toBeNull();
  });

  it('creates a draft policy that is never assignable and never computed, until activated', async () => {
    const a = adminCtx(b);
    const { id } = await createPolicy(a, { companyId: b.companyId, name: 'Draft policy', policyType: 'monthly', status: 'draft' });
    expect((await getPolicy(a, id))?.status).toBe('draft');

    // A draft is excluded from the assignable dropdown (only active policies are assignable).
    const assignable = await listAssignablePolicies(a, b.companyId);
    expect(assignable.map((p) => p.id)).not.toContain(id);

    // Even when directly assigned, a draft never computes — resolveAssignedPolicy returns null (monthly default).
    const e = await hire('DraftWorker');
    await assignPolicy(a, { employmentId: e.employmentId, policyId: id });
    const resolvedDraft = await withTenant(a, (tx) => resolveAssignedPolicy(tx, e.employmentId));
    expect(resolvedDraft).toBeNull();

    // Activating it makes it both assignable and computable.
    await setStatus(a, { id, status: 'active' });
    expect((await listAssignablePolicies(a, b.companyId)).map((p) => p.id)).toContain(id);
    const resolvedActive = await withTenant(a, (tx) => resolveAssignedPolicy(tx, e.employmentId));
    expect(resolvedActive?.id).toBe(id);
  });

  it('records code + status in the created event payload (substrate)', async () => {
    const a = adminCtx(b);
    const { id } = await createPolicy(a, { companyId: b.companyId, name: 'Substrate', code: 'SUB-1', policyType: 'monthly', status: 'draft' });
    await updatePolicy(a, { id, code: 'SUB-2', status: 'active' });
    expect(await eventTypesFor(b.tenantId, id)).toEqual(
      expect.arrayContaining(['payroll-policy.created', 'payroll-policy.updated']),
    );
    // The created event payload carries the draft status + code, so audit/replay see the Save-Draft path.
    const [created] = await withTenant(a, (tx) =>
      tx
        .select({ payload: schema.domainEvent.payload })
        .from(schema.domainEvent)
        .where(and(eq(schema.domainEvent.aggregateId, id), eq(schema.domainEvent.eventType, 'payroll-policy.created')))
        .limit(1),
    );
    expect(created?.payload).toMatchObject({ code: 'SUB-1', status: 'draft' });
  });
});
