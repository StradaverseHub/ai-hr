/**
 * Claim lifecycle (ADR-0021 §2, Slice 3) — submit (cap/budget), decide (approve/reject + self-approval ban +
 * taxable confirm), cancel, receipts, and the read helpers.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { SessionContext } from '../db/client';
import {
  addClaimAttachment,
  cancelClaim,
  createClaimType,
  decideClaim,
  getClaimAttachment,
  listClaimsForEmployment,
  listPendingClaims,
  setClaimPolicy,
  submitClaim,
} from '../core/claims';
import { hireEmployee } from '../core/org';
import { adminCtx, closeAll, createAppUser, eventTypesFor, migrateTestDb, resetDb, seedBase, type Base } from './harness';

const hire = (ctx: SessionContext, b: Base, name: string) =>
  hireEmployee(ctx, {
    person: { fullName: name, primaryEmail: `${name.toLowerCase()}@acme.test` },
    companyId: b.companyId,
    departmentId: b.deptA,
    employmentType: 'full_time',
    hiredOn: '2026-01-01',
  });

describe('ADR-0021 — claim lifecycle', () => {
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

  async function setup(opts?: { taxable?: boolean; budget?: number | null; cap?: number | null }) {
    const a = adminCtx(base);
    const E = await hire(a, base, 'Subject');
    const { id: typeId } = await createClaimType(a, { code: 'MEDICAL', name: 'Medical', defaultTaxable: opts?.taxable ?? false, requiresReceipt: true });
    if (opts && ('budget' in opts || 'cap' in opts)) {
      await setClaimPolicy(a, { claimTypeId: typeId, annualBudget: opts.budget ?? null, perClaimCap: opts.cap ?? null, effectiveFrom: '2026-01-01' });
    }
    return { a, E, typeId };
  }

  it('submits a pending claim (taxable defaulted from the type) + event', async () => {
    const { a, E, typeId } = await setup();
    const { id } = await submitClaim(a, { employmentId: E.employmentId, claimTypeId: typeId, amount: 120, incurredOn: '2026-06-01' });
    expect(await eventTypesFor(base.tenantId, id)).toContain('claim-request.submitted');
    const [claim] = await listClaimsForEmployment(a, E.employmentId);
    expect(claim.status).toBe('pending');
    expect(claim.amount).toBe(120);
    expect(claim.taxable).toBe(false);
  });

  it('enforces the per-claim cap and the annual budget at submit', async () => {
    const { a, E, typeId } = await setup({ budget: 1000, cap: 500 });
    await expect(submitClaim(a, { employmentId: E.employmentId, claimTypeId: typeId, amount: 600, incurredOn: '2026-06-01' })).rejects.toThrow(/cap/);
    await submitClaim(a, { employmentId: E.employmentId, claimTypeId: typeId, amount: 450, incurredOn: '2026-06-01' });
    await submitClaim(a, { employmentId: E.employmentId, claimTypeId: typeId, amount: 450, incurredOn: '2026-06-02' });
    // 900 committed; a third 450 (≤ cap) would push past the 1000 budget.
    await expect(submitClaim(a, { employmentId: E.employmentId, claimTypeId: typeId, amount: 450, incurredOn: '2026-06-03' })).rejects.toThrow(/budget/);
  });

  it('approves (reimbursement) and rejects, with events', async () => {
    const { a, E, typeId } = await setup();
    const { id: c1 } = await submitClaim(a, { employmentId: E.employmentId, claimTypeId: typeId, amount: 100, incurredOn: '2026-06-01' });
    await decideClaim(a, { claimRequestId: c1, decision: 'approve' });
    expect(await eventTypesFor(base.tenantId, c1)).toContain('claim-request.approved');
    expect((await listClaimsForEmployment(a, E.employmentId)).find((c) => c.id === c1)?.status).toBe('approved');

    const { id: c2 } = await submitClaim(a, { employmentId: E.employmentId, claimTypeId: typeId, amount: 50, incurredOn: '2026-06-02' });
    await decideClaim(a, { claimRequestId: c2, decision: 'reject' });
    expect(await eventTypesFor(base.tenantId, c2)).toContain('claim-request.rejected');
  });

  it('lets the approver confirm/override taxable', async () => {
    const { a, E, typeId } = await setup({ taxable: false });
    const { id } = await submitClaim(a, { employmentId: E.employmentId, claimTypeId: typeId, amount: 200, incurredOn: '2026-06-01' });
    await decideClaim(a, { claimRequestId: id, decision: 'approve', taxable: true });
    expect((await listClaimsForEmployment(a, E.employmentId)).find((c) => c.id === id)?.taxable).toBe(true);
  });

  it('bans self-approval', async () => {
    const { a, E, typeId } = await setup();
    const uE = await createAppUser(base.tenantId, E.personId, 'employee');
    const { id } = await submitClaim(a, { employmentId: E.employmentId, claimTypeId: typeId, amount: 80, incurredOn: '2026-06-01' });
    const ownCtx: SessionContext = { tenantId: base.tenantId, userId: uE, personId: E.personId, roles: ['employee'] };
    await expect(decideClaim(ownCtx, { claimRequestId: id, decision: 'approve' })).rejects.toThrow();
  });

  it('cancels a pending claim (owner) but not a peer', async () => {
    const { a, E, typeId } = await setup();
    const X = await hire(a, base, 'Peer');
    const uE = await createAppUser(base.tenantId, E.personId, 'employee');
    const uX = await createAppUser(base.tenantId, X.personId, 'employee');
    const { id } = await submitClaim(a, { employmentId: E.employmentId, claimTypeId: typeId, amount: 90, incurredOn: '2026-06-01' });
    const ownCtx: SessionContext = { tenantId: base.tenantId, userId: uE, personId: E.personId, roles: ['employee'] };
    const peerCtx: SessionContext = { tenantId: base.tenantId, userId: uX, personId: X.personId, roles: ['employee'] };
    await expect(cancelClaim(peerCtx, id)).rejects.toThrow(); // peer can't even see it (RLS) → not found
    await cancelClaim(ownCtx, id);
    expect((await listClaimsForEmployment(a, E.employmentId)).find((c) => c.id === id)?.status).toBe('cancelled');
  });

  it('stores + reads a receipt; lists pending claims for approval', async () => {
    const { a, E, typeId } = await setup();
    const { id } = await submitClaim(a, { employmentId: E.employmentId, claimTypeId: typeId, amount: 75, incurredOn: '2026-06-01' });
    const { id: attId } = await addClaimAttachment(a, { claimRequestId: id, fileName: 'r.pdf', mimeType: 'application/pdf', content: Buffer.from('receipt-bytes') });
    expect(await eventTypesFor(base.tenantId, id)).toContain('claim-request.receipt-added');
    const dl = await getClaimAttachment(a, attId);
    expect(dl?.content.toString()).toBe('receipt-bytes');
    expect((await listClaimsForEmployment(a, E.employmentId))[0].attachments.length).toBe(1);
    expect((await listPendingClaims(a)).map((c) => c.id)).toContain(id);
  });
});
