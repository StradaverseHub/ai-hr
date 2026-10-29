/**
 * M11 — the claims kernel seams the mobile claims and the D12 approvals depend on, each optional and
 * backward-compatible (core/claims.ts):
 *
 *   (a) an optional trailing transaction on submitClaimWithAttachment, saveClaimDraft, submitDraftClaims,
 *       deleteClaimDraft, cancelClaim and decideClaim: with one, the write commits or rolls back WITH the caller's
 *       transaction (the mobile command receipt's); without one, unchanged. The Claims module gate still applies.
 *   (b) decideClaim's optional rejectReason, stamped on the rejection event; absent ⇒ the event is unchanged.
 *   (c) the mileage pricing branch shared by submit and previewMileageClaim: the preview is the stored amount.
 *   (d) claimRecordFacts: custom answers with their labels, filing time, decider, rejection reason, payout route.
 */
import { randomUUID } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import * as schema from '../db/schema';
import { withTenant, type SessionContext } from '../db/client';
import {
  archiveClaimFormField, cancelClaim, ClaimError, claimRecordFacts, createClaimFormField, createClaimType, decideClaim,
  deleteClaimDraft, listClaimsForEmployment, previewMileageClaim, saveClaimDraft, setClaimPolicy, setMileageRateTable,
  submitClaimWithAttachment, submitDraftClaims,
} from '../core/claims';
import { ModuleNotEnabledError } from '../core/entitlements';
import { hireEmployee } from '../core/org';
import { todayInKualaLumpur } from '../lib/hr-date';
import { adminCtx, closeAll, createAppUser, harnessSnapshot, migrateTestDb, owner, resetDb, seedBase, setModule, type Base } from './harness';

let base: Base;
const TODAY = todayInKualaLumpur();
const addDays = (iso: string, n: number) => new Date(Date.parse(`${iso}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
const RECENT = addDays(TODAY, -3);
class Rollback extends Error {}

async function hire(name: string, role: 'employee' | 'manager' = 'employee') {
  const e = await hireEmployee(adminCtx(base), { person: { fullName: name, primaryEmail: randomUUID() + '@m11k.test' }, companyId: base.companyId, departmentId: base.deptA, employmentType: 'full_time', hiredOn: '2024-01-01' });
  const userId = await createAppUser(base.tenantId, e.personId, role);
  const ctx: SessionContext = { tenantId: base.tenantId, userId, personId: e.personId, roles: [role], grants: [{ role, companyId: base.companyId }], entitlements: harnessSnapshot(base.tenantId) };
  return { ...e, ctx };
}
type Person = Awaited<ReturnType<typeof hire>>;
const statusOf = async (id: string) => (await owner.db.select({ s: schema.claimRequest.status }).from(schema.claimRequest).where(eq(schema.claimRequest.id, id)))[0]?.s ?? null;
const countClaims = async (employmentId: string) => (await owner.db.select({ id: schema.claimRequest.id }).from(schema.claimRequest).where(eq(schema.claimRequest.employmentId, employmentId))).length;
/** Run `fn` in a transaction that is then rolled back; the throw is swallowed. */
async function inRolledBack(ctx: SessionContext, fn: (tx: Parameters<Parameters<typeof withTenant>[1]>[0]) => Promise<unknown>) {
  await expect(withTenant(ctx, async (tx) => { await fn(tx); throw new Rollback(); })).rejects.toBeInstanceOf(Rollback);
}

let employee: Person, manager: Person, typeId: string;
beforeAll(migrateTestDb);
afterAll(closeAll);
beforeEach(async () => {
  await resetDb(); base = await seedBase();
  employee = await hire('Aina Employee'); manager = await hire('Mohan Manager', 'manager');
  ({ id: typeId } = await createClaimType(adminCtx(base), { code: 'MEAL', name: 'Meals', defaultTaxable: false, requiresReceipt: false }));
});
const fields = (over: Record<string, unknown> = {}) => ({ employmentId: employee.employmentId, claimTypeId: typeId, amount: 42.5, incurredOn: RECENT, ...over });

describe('(a) the optional receipt transaction', () => {
  it('each command commits or rolls back with the caller’s transaction', async () => {
    const e = employee.ctx;
    await inRolledBack(e, (tx) => submitClaimWithAttachment(e, fields(), null, tx));
    expect(await countClaims(employee.employmentId), 'a rolled-back submit leaves no claim').toBe(0);
    await inRolledBack(e, (tx) => saveClaimDraft(e, fields(), null, tx));
    expect(await countClaims(employee.employmentId), 'a rolled-back draft save leaves no draft').toBe(0);

    const { id: draft } = await saveClaimDraft(e, fields());
    await inRolledBack(e, (tx) => submitDraftClaims(e, { ids: [draft], employmentId: employee.employmentId }, tx));
    expect(await statusOf(draft)).toBe('draft');
    await inRolledBack(e, (tx) => deleteClaimDraft(e, draft, employee.employmentId, tx));
    expect(await statusOf(draft)).toBe('draft');

    const { id: pending } = await submitClaimWithAttachment(e, fields(), null);
    await inRolledBack(e, (tx) => cancelClaim(e, pending, employee.employmentId, tx));
    expect(await statusOf(pending)).toBe('pending');
    await inRolledBack(adminCtx(base), (tx) => decideClaim(adminCtx(base), { claimRequestId: pending, decision: 'approve' }, tx));
    expect(await statusOf(pending)).toBe('pending');

    // Committed with the caller's transaction when it commits.
    await withTenant(e, (tx) => submitDraftClaims(e, { ids: [draft], employmentId: employee.employmentId }, tx));
    expect(await statusOf(draft)).toBe('pending');
    await withTenant(e, (tx) => cancelClaim(e, draft, employee.employmentId, tx));
    expect(await statusOf(draft)).toBe('cancelled');
    // Without one, unchanged: its own transaction.
    await decideClaim(adminCtx(base), { claimRequestId: pending, decision: 'approve' });
    expect(await statusOf(pending)).toBe('approved');
  });

  it('the Claims module gate still refuses on a caller’s transaction', async () => {
    await setModule(base.tenantId, 'claims', 'disabled');
    const off: SessionContext = { ...employee.ctx, entitlements: harnessSnapshot(base.tenantId) };
    await expect(withTenant(off, (tx) => submitClaimWithAttachment(off, fields(), null, tx))).rejects.toBeInstanceOf(ModuleNotEnabledError);
    await expect(withTenant(off, (tx) => saveClaimDraft(off, fields(), null, tx))).rejects.toBeInstanceOf(ModuleNotEnabledError);
    expect(await countClaims(employee.employmentId)).toBe(0);
  });
});

describe('(b) decideClaim rejectReason', () => {
  const decisionEvents = (id: string) => owner.db.select({ type: schema.domainEvent.eventType, payload: schema.domainEvent.payload }).from(schema.domainEvent)
    .where(and(eq(schema.domainEvent.aggregateId, id), eq(schema.domainEvent.aggregateType, 'claim-request'))).orderBy(schema.domainEvent.sequence);

  it('stamps a trimmed reason on the rejection event; without one the event carries no payload, as before', async () => {
    const { id: a } = await submitClaimWithAttachment(employee.ctx, fields(), null);
    const { id: b } = await submitClaimWithAttachment(employee.ctx, fields({ incurredOn: addDays(RECENT, -1) }), null);
    await decideClaim(adminCtx(base), { claimRequestId: a, decision: 'reject', rejectReason: '  Not a business meal  ', deciderEmploymentId: manager.employmentId });
    await decideClaim(adminCtx(base), { claimRequestId: b, decision: 'reject' });
    expect((await decisionEvents(a)).find((e) => e.type === 'claim-request.rejected')?.payload).toEqual({ rejectReason: 'Not a business meal' });
    expect((await decisionEvents(b)).find((e) => e.type === 'claim-request.rejected')?.payload ?? null).toBeNull();
  });

  it('an approval ignores a reason: its event is the approval event it always was', async () => {
    const { id } = await submitClaimWithAttachment(employee.ctx, fields(), null);
    await decideClaim(adminCtx(base), { claimRequestId: id, decision: 'approve', rejectReason: 'ignored' });
    expect((await decisionEvents(id)).find((e) => e.type === 'claim-request.approved')?.payload).toEqual({ taxable: false, payoutMethod: 'reimbursement' });
  });
});

describe('(c) the mileage preview is the amount submit stores', () => {
  async function mileageType() {
    const { id } = await createClaimType(adminCtx(base), { code: 'MILE', name: 'Mileage', defaultTaxable: false, requiresReceipt: false, isMileage: true });
    return id;
  }
  it('banded: marginal pricing, the same figure and bands as the stored claim', async () => {
    const mile = await mileageType();
    await setMileageRateTable(adminCtx(base), { claimTypeId: mile, effectiveFrom: '2024-01-01', bands: [{ fromKm: 0, toKm: 500, ratePerKm: 0.6 }, { fromKm: 500, toKm: null, ratePerKm: 0.45 }] });
    const preview = await previewMileageClaim(employee.ctx, { employmentId: employee.employmentId, claimTypeId: mile, quantityKm: 700, incurredOn: RECENT });
    expect(preview).toEqual({ amount: '390.00', tableValidFrom: '2024-01-01', bands: [
      { fromKm: 0, toKm: 500, ratePerKm: 0.6, km: 500, amount: 300 }, { fromKm: 500, toKm: null, ratePerKm: 0.45, km: 200, amount: 90 },
    ] });
    const { id } = await submitClaimWithAttachment(employee.ctx, { employmentId: employee.employmentId, claimTypeId: mile, amount: 0, quantityKm: 700, incurredOn: RECENT }, null);
    const [row] = await owner.db.select({ amount: schema.claimRequest.amount, stamp: schema.claimRequest.mileageRateApplied }).from(schema.claimRequest).where(eq(schema.claimRequest.id, id));
    expect(row.amount).toBe(preview.amount);
    expect(row.stamp?.bands).toEqual(preview.bands);
  });

  it('legacy flat rate: the stored two-place text, unrounded arithmetic included', async () => {
    const mile = await mileageType();
    await setClaimPolicy(adminCtx(base), { claimTypeId: mile, annualBudget: null, perClaimCap: null, effectiveFrom: '2024-01-01', rateConfig: { kind: 'mileage_flat', ratePerKm: 0.333 } });
    const preview = await previewMileageClaim(employee.ctx, { employmentId: employee.employmentId, claimTypeId: mile, quantityKm: 12.5, incurredOn: RECENT });
    expect(preview).toEqual({ amount: (0.333 * 12.5).toFixed(2), bands: null, tableValidFrom: null });
    const { id } = await submitClaimWithAttachment(employee.ctx, { employmentId: employee.employmentId, claimTypeId: mile, amount: 0, quantityKm: 12.5, incurredOn: RECENT }, null);
    const [row] = await owner.db.select({ amount: schema.claimRequest.amount }).from(schema.claimRequest).where(eq(schema.claimRequest.id, id));
    expect(row.amount).toBe(preview.amount);
  });

  it('refuses a type not priced by distance, an unpriced mileage type and another person’s employment', async () => {
    const mile = await mileageType();
    await expect(previewMileageClaim(employee.ctx, { employmentId: employee.employmentId, claimTypeId: mile, quantityKm: 10, incurredOn: RECENT })).rejects.toThrow(/No mileage rate/);
    await setMileageRateTable(adminCtx(base), { claimTypeId: mile, effectiveFrom: '2024-01-01', bands: [{ fromKm: 0, toKm: null, ratePerKm: 0.5 }] });
    await expect(previewMileageClaim(employee.ctx, { employmentId: employee.employmentId, claimTypeId: typeId, quantityKm: 10, incurredOn: RECENT })).rejects.toThrow(/not priced by distance/);
    await expect(previewMileageClaim(manager.ctx, { employmentId: employee.employmentId, claimTypeId: mile, quantityKm: 10, incurredOn: RECENT })).rejects.toBeInstanceOf(ClaimError);
    await expect(previewMileageClaim(employee.ctx, { employmentId: employee.employmentId, claimTypeId: mile, quantityKm: 0, incurredOn: RECENT })).rejects.toThrow(/greater than zero/);
  });
});

describe('(d) claimRecordFacts', () => {
  it('answers with labels (an archived field keeps its label), filing time, decider, reason and payout route', async () => {
    const a = adminCtx(base);
    const live = await createClaimFormField(a, { claimTypeId: typeId, label: 'Client', kind: 'text', required: true });
    const gone = await createClaimFormField(a, { claimTypeId: typeId, label: 'Guests', kind: 'number' });
    const { id: draft } = await saveClaimDraft(employee.ctx, fields({ fieldValues: { client: 'Acme', guests: '3' } }));
    let facts = (await claimRecordFacts(employee.ctx, [draft])).get(draft)!;
    expect(facts.submittedAt, 'a draft has not been filed').toBeNull();
    await submitDraftClaims(employee.ctx, { ids: [draft], employmentId: employee.employmentId });
    await archiveClaimFormField(a, gone.id);
    await decideClaim(a, { claimRequestId: draft, decision: 'reject', rejectReason: 'Receipt missing', deciderEmploymentId: manager.employmentId });
    facts = (await claimRecordFacts(employee.ctx, [draft])).get(draft)!;
    expect(live.id).toBeTruthy();
    expect(facts.fields.map((f) => [f.fieldKey, f.label])).toEqual([['client', 'Client'], ['guests', 'Guests']]);
    expect(facts.fieldValues).toEqual({ client: 'Acme', guests: 3 });
    expect(facts.submittedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(facts.rejectReason, 'the employee reads the reason through their own event').toBe('Receipt missing');
    expect(facts.payoutRoute).toBeNull();
    expect((await claimRecordFacts(a, [draft])).get(draft)!.decidedByName).toBe('Mohan Manager');

    const { id: approved } = await submitClaimWithAttachment(employee.ctx, fields({ incurredOn: addDays(RECENT, -1), fieldValues: { client: 'Beta' } }), null);
    await decideClaim(a, { claimRequestId: approved, decision: 'approve', taxable: true });
    const paid = (await claimRecordFacts(employee.ctx, [approved])).get(approved)!;
    expect(paid).toMatchObject({ payoutRoute: 'payroll', scheduledInPayroll: false, rejectReason: null });
    expect((await listClaimsForEmployment(employee.ctx, employee.employmentId)).map((c) => c.id).sort()).toEqual([approved, draft].sort());
  });

  it('a colleague reads nothing (RLS): an empty map, never a fact', async () => {
    const { id } = await submitClaimWithAttachment(employee.ctx, fields(), null);
    const colleague = await hire('Chen Colleague');
    expect((await claimRecordFacts(colleague.ctx, [id])).size).toBe(0);
  });
});
