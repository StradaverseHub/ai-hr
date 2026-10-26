/** Canonical Claims specialist read and Assistant consumer; authored UNRUN. No provider calls. */
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { SessionContext } from '../db/client';
import * as schema from '../db/schema';
import { ownClaimStatuses, createClaimType, submitClaim, saveClaimDraft, addClaimAttachment } from '../packs/claims/service';
import { ASSISTANT_TOOLS, toolsFor } from '../core/assistant-tools';
import { grantAssistant } from '../core/assistant-grant';
import { hireEmployee } from '../core/org';
import { todayInKualaLumpur } from '../lib/hr-date';
import { adminCtx, closeAll, createAppUser, entitledCtx, migrateTestDb, owner, resetDb, seedBase, setModule, type Base } from './harness';
let base: Base;
beforeAll(migrateTestDb);
beforeEach(async () => { await resetDb(); base = await seedBase(); await setModule(base.tenantId, 'claims', 'active'); await setModule(base.tenantId, 'assistant', 'active'); });
afterAll(closeAll);
const tool = ASSISTANT_TOOLS.find(item => item.spec.name === 'my_claim_statuses')!;

async function fixture() {
  const a = adminCtx(base);
  const hire = (name: string) => hireEmployee(a, { person: { fullName: name }, companyId: base.companyId,
    departmentId: base.deptA, employmentType: 'full_time', hiredOn: '2026-01-01' });
  const mine = await hire('Fictional Claim Reader');
  const other = await hire('Fictional Other Claimant');
  const userId = await createAppUser(base.tenantId, mine.personId, 'hr_admin');
  await grantAssistant(a, { appUserId: userId });
  const snapshot = await entitledCtx(base, ['hr_admin']);
  // Deliberately broad HR visibility: own identity must still constrain this tool.
  const ctx: SessionContext = { ...snapshot, userId, personId: mine.personId, roles: ['hr_admin'], grants: [{ role: 'hr_admin', companyId: null }] };
  const type = await createClaimType(a, { code: 'STATUS_TEST', name: 'Fictional Status Claim', defaultTaxable: false, requiresReceipt: false, maxReceiptAgeDays: 36500 });
  const submit = (employmentId: string, description: string, amount = 271.23) => submitClaim(a, {
    employmentId, claimTypeId: type.id, amount, description, incurredOn: todayInKualaLumpur(),
  });
  return { a, mine, other, ctx, submit, typeId: type.id };
}

describe('own Claims status specialist', () => {
  it('returns actual canonical statuses without money, private text, receipts or other claimants even for HR', async () => {
    const { a, mine, other, ctx, submit } = await fixture();
    const mineClaim = await submit(mine.employmentId, 'PRIVATE_DESCRIPTION_SENTINEL');
    const otherClaim = await submit(other.employmentId, 'OTHER_CLAIM_SENTINEL');
    await addClaimAttachment(a, { claimRequestId: mineClaim.id, fileName: 'PRIVATE_RECEIPT_SENTINEL.pdf', mimeType: 'application/pdf', content: Buffer.from('PRIVATE_FILE_BYTES_SENTINEL') });
    const result = await ownClaimStatuses(ctx, 5);
    expect(result.hasEmployment).toBe(true);
    expect(result.truncated).toBe(false);
    expect(result.claims).toHaveLength(1);
    expect(result.claims[0]).toMatchObject({ id: mineClaim.id, employmentId: mine.employmentId, status: 'pending', decidedAt: null, paidAt: null });
    expect(Object.keys(result.claims[0]).sort()).toEqual(['id', 'employmentId', 'claimType', 'status', 'incurredOn', 'createdAt', 'decidedAt', 'paidAt'].sort());
    const serialized = JSON.stringify(result);
    for (const forbidden of [otherClaim.id, other.employmentId, 'PRIVATE_', 'OTHER_CLAIM', '271.23', 'amount', 'attachments', 'description', 'taxable', 'claimantName']) expect(serialized).not.toContain(forbidden);
    expect(tool.module).toBe('claims');
    const consumed = await tool.run(ctx, { limit: 5 });
    expect(consumed).toMatchObject({ ok: true, returnedRows: 1, claims: result.claims, truncated: false });
  });

  it('bounds the complete own result and honestly reports truncation without guessed totals', async () => {
    const { mine, ctx, submit } = await fixture();
    const ids = [];
    for (let index = 0; index < 3; index++) ids.push((await submit(mine.employmentId, `Private ${index}`)).id);
    const bounded = await ownClaimStatuses(ctx, 2);
    expect(bounded.claims).toHaveLength(2); expect(bounded.truncated).toBe(true);
    expect(bounded).not.toHaveProperty('totalRows');
    const complete = await ownClaimStatuses(ctx, 3);
    expect(complete.truncated).toBe(false);
    expect(complete.claims.map(row => row.id).sort()).toEqual(ids.sort());
    await expect(tool.run(ctx, { limit: 2, employment_id: 'retarget' })).resolves.toMatchObject({ ok: false, refusal: 'invalid_input' });
    for (const limit of [0, 26, 1.5, NaN]) await expect(ownClaimStatuses(ctx, limit)).rejects.toThrow();
  });

  it('keeps a saved draft a draft and does not manufacture a submission or payment timestamp', async () => {
    const { mine, ctx, typeId } = await fixture();
    const draft = await saveClaimDraft(ctx, { employmentId: mine.employmentId, claimTypeId: typeId,
      amount: 100, description: 'PRIVATE_DRAFT_SENTINEL', incurredOn: todayInKualaLumpur() });
    const result = await ownClaimStatuses(ctx, 5);
    expect(result.claims).toHaveLength(1);
    expect(result.claims[0]).toMatchObject({ id: draft.id, status: 'draft', decidedAt: null, paidAt: null });
    expect(result.claims[0].createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(result.claims[0]).not.toHaveProperty('submittedAt');
    expect(JSON.stringify(result)).not.toContain('PRIVATE_DRAFT_SENTINEL');
  });

  it('refuses a retained offered tool after actual Claims entitlement revocation, then succeeds after restoration', async () => {
    const { mine, ctx, submit } = await fixture();
    const claim = await submit(mine.employmentId, 'Own claim');
    expect(toolsFor(ctx)).toContain(tool);
    await setModule(base.tenantId, 'claims', null);
    // This captured session still offers it. The source owner must not trust that old offer.
    expect(toolsFor(ctx)).toContain(tool);
    await expect(tool.run(ctx, { limit: 5 })).rejects.toThrow();
    await setModule(base.tenantId, 'claims', 'active');
    expect((await ownClaimStatuses(ctx, 5)).claims.map(row => row.id)).toEqual([claim.id]);
  });

  it('refuses forged, relinked and revoked principals rather than using broad admin visibility', async () => {
    const { mine, other, ctx, submit } = await fixture();
    await submit(mine.employmentId, 'Own'); await submit(other.employmentId, 'Other');
    await expect(ownClaimStatuses({ ...ctx, personId: other.personId }, 5)).rejects.toThrow('Current AI calling authority');
    const tenant = await seedBase();
    await expect(ownClaimStatuses({ ...ctx, tenantId: tenant.tenantId }, 5)).rejects.toThrow();
    await owner.db.update(schema.appUser).set({ personId: other.personId }).where(eq(schema.appUser.id, ctx.userId!));
    await expect(ownClaimStatuses(ctx, 5)).rejects.toThrow('Current AI calling authority');
    await owner.db.update(schema.appUser).set({ personId: mine.personId }).where(eq(schema.appUser.id, ctx.userId!));
    expect((await ownClaimStatuses(ctx, 5)).claims).toHaveLength(1);
    await owner.db.delete(schema.roleAssignment).where(eq(schema.roleAssignment.appUserId, ctx.userId!));
    await expect(ownClaimStatuses(ctx, 5)).rejects.toThrow('Current AI calling authority');
  });
});
