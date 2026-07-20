/**
 * #73 (P-73c) — company bank accounts / disbursement profiles (ADR-0031), reworked by R46 orgbank
 * (84719377). Verifies the create/update/remove service: substrate events fire, a company can hold
 * SEVERAL accounts including more than one at the same bank (the old (company, bank) unique key is gone),
 * identity is the row id, the bank must come from the shared MY master, at most one account is primary,
 * and bank credentials stay OUT of the append-only event payload (ADR-0030 Layer-0 redaction).
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import * as schema from '../db/schema';
import { adminCtx, closeAll, eventTypesFor, migrateTestDb, owner, resetDb, seedBase, type Base } from './harness';
import { listCompanyBankProfiles, removeCompanyBankProfile, upsertCompanyBankProfile } from '../core/bank-profile';

let b: Base;
beforeAll(async () => {
  await migrateTestDb();
});
afterAll(async () => {
  await closeAll();
});
beforeEach(async () => {
  await resetDb();
  b = await seedBase();
});

describe('company bank profile (ADR-0031, #73)', () => {
  it('upserts a profile, lists it, and appends a set event', async () => {
    const ctx = adminCtx(b);
    const { id } = await upsertCompanyBankProfile(ctx, {
      companyId: b.companyId,
      bank: 'maybank',
      corporateId: 'CORP123',
      debitAccountNo: '514123456789',
      orgName: 'Acme Sdn Bhd',
    });
    const list = await listCompanyBankProfiles(ctx, b.companyId);
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ bank: 'maybank', corporateId: 'CORP123', debitAccountNo: '514123456789', txnType: 'IBG' });
    expect(await eventTypesFor(b.tenantId, id)).toContain('company-bank-profile.set');
  });

  // R46: passing the row id UPDATES that account. This replaces the old upsert-by-(company, bank), which
  // could not express "a second account at the same bank".
  it('passing an id updates that account rather than creating another', async () => {
    const ctx = adminCtx(b);
    const first = await upsertCompanyBankProfile(ctx, { companyId: b.companyId, bank: 'cimb', corporateId: 'OLD', debitAccountNo: '111' });
    const second = await upsertCompanyBankProfile(ctx, { id: first.id, companyId: b.companyId, bank: 'cimb', corporateId: 'NEW', debitAccountNo: '222', txnType: 'RENTAS' });
    expect(second.id).toBe(first.id);
    const list = await listCompanyBankProfiles(ctx, b.companyId);
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ corporateId: 'NEW', debitAccountNo: '222', txnType: 'RENTAS' });
  });

  // The headline of the item: two accounts at the SAME bank must coexist.
  it('holds several accounts for one company, including two at the same bank', async () => {
    const ctx = adminCtx(b);
    await upsertCompanyBankProfile(ctx, { companyId: b.companyId, bank: 'maybank', corporateId: 'C1', debitAccountNo: '111', accountLabel: 'Payroll' });
    await upsertCompanyBankProfile(ctx, { companyId: b.companyId, bank: 'maybank', corporateId: 'C2', debitAccountNo: '222', accountLabel: 'Statutory' });
    await upsertCompanyBankProfile(ctx, { companyId: b.companyId, bank: 'hong_leong_bank', corporateId: 'C3', debitAccountNo: '333' });
    const list = await listCompanyBankProfiles(ctx, b.companyId);
    expect(list).toHaveLength(3);
    expect(list.filter((r) => r.bank === 'maybank').map((r) => r.accountLabel).sort()).toEqual(['Payroll', 'Statutory']);
  });

  // The bank column is plain text now, so the shared master (lib/my-banks.ts) is the only gate. A bank with
  // no BNM routing code would produce unpayable salary files.
  it('refuses a bank that is not in the shared Malaysian bank master', async () => {
    const ctx = adminCtx(b);
    await expect(
      upsertCompanyBankProfile(ctx, { companyId: b.companyId, bank: 'bank_of_zen', corporateId: 'C', debitAccountNo: '1' }),
    ).rejects.toThrow(/bank list/i);
  });

  it('accepts a bank outside the original four (shared master is wider than the old enum)', async () => {
    const ctx = adminCtx(b);
    await upsertCompanyBankProfile(ctx, { companyId: b.companyId, bank: 'bank_islam', corporateId: 'C', debitAccountNo: '1' });
    const list = await listCompanyBankProfiles(ctx, b.companyId);
    expect(list[0]).toMatchObject({ bank: 'bank_islam', currency: 'MYR', isPrimary: false });
    // The label defaults from the bank name so two accounts at one bank are still distinguishable.
    expect(list[0].accountLabel).toBe('Bank Islam');
  });

  // A partial unique index enforces this at the DB; the service demotes the incumbent so the second save
  // succeeds rather than erroring.
  it('keeps at most one primary account per company', async () => {
    const ctx = adminCtx(b);
    const a = await upsertCompanyBankProfile(ctx, { companyId: b.companyId, bank: 'maybank', corporateId: 'C1', debitAccountNo: '111', isPrimary: true });
    const c = await upsertCompanyBankProfile(ctx, { companyId: b.companyId, bank: 'cimb', corporateId: 'C2', debitAccountNo: '222', isPrimary: true });
    const list = await listCompanyBankProfiles(ctx, b.companyId);
    expect(list.filter((r) => r.isPrimary).map((r) => r.id)).toEqual([c.id]);
    expect(list.find((r) => r.id === a.id)!.isPrimary).toBe(false);
  });

  it('keeps bank credentials OUT of the event payload (ADR-0030 Layer-0)', async () => {
    const ctx = adminCtx(b);
    const { id } = await upsertCompanyBankProfile(ctx, { companyId: b.companyId, bank: 'rhb', corporateId: 'SECRETCORP', debitAccountNo: '8009998887', swiftCode: 'SWIFTXX' });
    const rows = await owner.db
      .select({ payload: schema.domainEvent.payload })
      .from(schema.domainEvent)
      .where(eq(schema.domainEvent.aggregateId, id));
    const blob = JSON.stringify(rows.map((r) => r.payload));
    expect(blob).not.toContain('SECRETCORP');
    expect(blob).not.toContain('8009998887');
    expect(blob).not.toContain('SWIFTXX'); // R46: SWIFT is a bank credential too
    expect(blob).toContain('rhb'); // the bank reference itself is fine to log
  });

  it('removes a profile and appends a removed event', async () => {
    const ctx = adminCtx(b);
    const { id } = await upsertCompanyBankProfile(ctx, { companyId: b.companyId, bank: 'public_bank', corporateId: 'C', debitAccountNo: '9' });
    await removeCompanyBankProfile(ctx, { id });
    expect(await listCompanyBankProfiles(ctx, b.companyId)).toHaveLength(0);
    expect(await eventTypesFor(b.tenantId, id)).toContain('company-bank-profile.removed');
  });

  it('refuses an empty corporate ID or debit account', async () => {
    const ctx = adminCtx(b);
    await expect(upsertCompanyBankProfile(ctx, { companyId: b.companyId, bank: 'maybank', corporateId: '  ', debitAccountNo: '1' })).rejects.toThrow(/corporate/i);
    await expect(upsertCompanyBankProfile(ctx, { companyId: b.companyId, bank: 'maybank', corporateId: 'X', debitAccountNo: '' })).rejects.toThrow(/debit account/i);
  });
});
