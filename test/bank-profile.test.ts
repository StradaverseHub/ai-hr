/**
 * #73 (P-73c) — company bank disbursement profiles (ADR-0031). Verifies the upsert/remove service:
 * substrate events fire, (company, bank) is unique (upsert, not duplicate), and bank credentials stay
 * OUT of the append-only event payload (ADR-0030 Layer-0 redaction).
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

  it('upsert on the same (company, bank) updates rather than duplicating', async () => {
    const ctx = adminCtx(b);
    const first = await upsertCompanyBankProfile(ctx, { companyId: b.companyId, bank: 'cimb', corporateId: 'OLD', debitAccountNo: '111' });
    const second = await upsertCompanyBankProfile(ctx, { companyId: b.companyId, bank: 'cimb', corporateId: 'NEW', debitAccountNo: '222', txnType: 'RENTAS' });
    expect(second.id).toBe(first.id);
    const list = await listCompanyBankProfiles(ctx, b.companyId);
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ corporateId: 'NEW', debitAccountNo: '222', txnType: 'RENTAS' });
  });

  it('keeps bank credentials OUT of the event payload (ADR-0030 Layer-0)', async () => {
    const ctx = adminCtx(b);
    const { id } = await upsertCompanyBankProfile(ctx, { companyId: b.companyId, bank: 'rhb', corporateId: 'SECRETCORP', debitAccountNo: '8009998887' });
    const rows = await owner.db
      .select({ payload: schema.domainEvent.payload })
      .from(schema.domainEvent)
      .where(eq(schema.domainEvent.aggregateId, id));
    const blob = JSON.stringify(rows.map((r) => r.payload));
    expect(blob).not.toContain('SECRETCORP');
    expect(blob).not.toContain('8009998887');
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
