/**
 * Per-entity bank disbursement profiles (ADR-0031). Each mutation runs inside `withTenant` (RLS-scoped,
 * one transaction) and appends a domain event before returning. Bank credentials (corporate ID, debit
 * account) are REDACTED from event payloads per ADR-0030 Layer-0: the append-only log references the
 * profile + which bank/rail changed, never the cleartext account numbers.
 */
import { eq } from 'drizzle-orm';
import { withTenant, type SessionContext } from '../db/client';
import { appendEvent, actorOf } from '../db/events';
import { companyBankProfile } from '../db/schema';

export type DisbursementBank = 'maybank' | 'cimb' | 'public_bank' | 'rhb';

export type CompanyBankProfileInput = {
  companyId: string;
  bank: DisbursementBank;
  corporateId: string;
  debitAccountNo: string;
  orgName?: string | null;
  txnType?: string | null;
};

/** Create or update the disbursement profile for a (company, bank). Admin-only via RLS. */
export async function upsertCompanyBankProfile(ctx: SessionContext, p: CompanyBankProfileInput) {
  const corporateId = p.corporateId.trim();
  const debitAccountNo = p.debitAccountNo.trim();
  if (!corporateId) throw new Error('Bank corporate / organisation ID is required');
  if (!debitAccountNo) throw new Error('Employer debit account number is required');
  const orgName = p.orgName?.trim() || null;
  const txnType = p.txnType?.trim() || 'IBG';

  return withTenant(ctx, async (tx) => {
    const [row] = await tx
      .insert(companyBankProfile)
      .values({ tenantId: ctx.tenantId, companyId: p.companyId, bank: p.bank, corporateId, debitAccountNo, orgName, txnType })
      .onConflictDoUpdate({
        target: [companyBankProfile.companyId, companyBankProfile.bank],
        set: { corporateId, debitAccountNo, orgName, txnType, updatedAt: new Date() },
      })
      .returning({ id: companyBankProfile.id });

    await appendEvent(tx, {
      tenantId: ctx.tenantId,
      aggregateType: 'company-bank-profile',
      aggregateId: row.id,
      eventType: 'company-bank-profile.set',
      actor: actorOf(ctx),
      // ADR-0030 Layer-0: reference only — corporate ID / debit account stay out of the event stream.
      payload: { companyBankProfileId: row.id, companyId: p.companyId, bank: p.bank, txnType },
    });
    return { id: row.id };
  });
}

/** Remove a disbursement profile (config, not history — hard delete). Admin-only via RLS. */
export async function removeCompanyBankProfile(ctx: SessionContext, p: { id: string }) {
  return withTenant(ctx, async (tx) => {
    const [row] = await tx
      .delete(companyBankProfile)
      .where(eq(companyBankProfile.id, p.id))
      .returning({ id: companyBankProfile.id, companyId: companyBankProfile.companyId, bank: companyBankProfile.bank });
    if (!row) return { id: null };
    await appendEvent(tx, {
      tenantId: ctx.tenantId,
      aggregateType: 'company-bank-profile',
      aggregateId: row.id,
      eventType: 'company-bank-profile.removed',
      actor: actorOf(ctx),
      payload: { companyBankProfileId: row.id, companyId: row.companyId, bank: row.bank },
    });
    return { id: row.id };
  });
}

/** List a company's disbursement profiles (admin-only via RLS). */
export async function listCompanyBankProfiles(ctx: SessionContext, companyId: string) {
  return withTenant(ctx, (tx) =>
    tx
      .select({
        id: companyBankProfile.id,
        bank: companyBankProfile.bank,
        corporateId: companyBankProfile.corporateId,
        debitAccountNo: companyBankProfile.debitAccountNo,
        orgName: companyBankProfile.orgName,
        txnType: companyBankProfile.txnType,
      })
      .from(companyBankProfile)
      .where(eq(companyBankProfile.companyId, companyId))
      .orderBy(companyBankProfile.bank),
  );
}

/** Every disbursement profile the caller can administer (RLS scopes to admin-for-company). The admin
 *  Organization page groups these by company, like listCompanyStatutoryMY. */
export async function listAllCompanyBankProfiles(ctx: SessionContext) {
  return withTenant(ctx, (tx) =>
    tx
      .select({
        id: companyBankProfile.id,
        companyId: companyBankProfile.companyId,
        bank: companyBankProfile.bank,
        corporateId: companyBankProfile.corporateId,
        debitAccountNo: companyBankProfile.debitAccountNo,
        orgName: companyBankProfile.orgName,
        txnType: companyBankProfile.txnType,
      })
      .from(companyBankProfile)
      .orderBy(companyBankProfile.companyId, companyBankProfile.bank),
  );
}
