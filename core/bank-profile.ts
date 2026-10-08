/**
 * Per-entity company bank accounts / disbursement profiles (ADR-0031; reworked by R46 orgbank 84719377).
 *
 * Each mutation runs inside `withTenant` (RLS-scoped, one transaction) and appends a domain event before
 * returning. Bank credentials (corporate ID, debit account, SWIFT) are REDACTED from event payloads per
 * ADR-0030 Layer-0: the append-only log references the profile + which bank/rail changed, never the
 * cleartext account numbers.
 *
 * R46 changes:
 *  - `bank` is a key from the SHARED Malaysian bank master (lib/my-banks.ts) — the same list the employee
 *    bank picker reads — instead of a 4-value pgEnum. Validated against the master here, because the column
 *    is now plain text and a bank with no BNM routing code produces unpayable salary files.
 *  - A company may hold SEVERAL accounts, including more than one at the same bank. The (companyId, bank)
 *    ON CONFLICT upsert is gone: pass `id` to update an existing account, omit it to create a new one.
 *  - Fuller account master data (label / account name / type / branch / SWIFT / currency / primary).
 */
import { and, eq, ne } from 'drizzle-orm';
import { withTenant, type SessionContext } from '../db/client';
import { appendEvent, actorOf } from '../db/events';
import { companyBankProfile } from '../db/schema';
import { isMyBankKey, myBankLabel, disbursementFormatFor } from '../lib/my-banks';

/** A bank key from the shared master (lib/my-banks.ts). Plain string — the master is the gate, not the type. */
export type DisbursementBank = string;

export type CompanyBankProfileInput = {
  /** Present ⇒ update THAT account. Absent ⇒ create a new one (several per bank are allowed since R46). */
  id?: string | null;
  companyId: string;
  bank: DisbursementBank;
  corporateId: string;
  debitAccountNo: string;
  orgName?: string | null;
  txnType?: string | null;
  accountLabel?: string | null;
  accountName?: string | null;
  accountType?: string | null;
  branch?: string | null;
  swiftCode?: string | null;
  currency?: string | null;
  isPrimary?: boolean;
};

const clean = (v: string | null | undefined): string | null => v?.trim() || null;

/**
 * Create or update ONE company bank account. Admin-only via RLS.
 *
 * Not an upsert-by-(company,bank) any more — that unique key was dropped in migration 0275 so a company can
 * hold two accounts at the same bank. Identity is the row id.
 */
export async function upsertCompanyBankProfile(ctx: SessionContext, p: CompanyBankProfileInput) {
  const corporateId = p.corporateId.trim();
  const debitAccountNo = p.debitAccountNo.trim();
  if (!isMyBankKey(p.bank)) throw new Error('Select a bank from the Malaysian bank list');
  if (!corporateId) throw new Error('Bank corporate / organisation ID is required');
  if (!debitAccountNo) throw new Error('Employer debit account number is required');
  const orgName = clean(p.orgName);
  const txnType = clean(p.txnType) ?? 'IBG';
  // Default the label from the bank name so two accounts at the same bank are still distinguishable in a
  // picker even when the admin left the field blank.
  const accountLabel = clean(p.accountLabel) ?? myBankLabel(p.bank);
  const currency = clean(p.currency)?.toUpperCase() ?? 'MYR';
  const isPrimary = p.isPrimary === true;
  const fields = {
    bank: p.bank,
    corporateId,
    debitAccountNo,
    orgName,
    txnType,
    accountLabel,
    accountName: clean(p.accountName),
    accountType: clean(p.accountType),
    branch: clean(p.branch),
    swiftCode: clean(p.swiftCode),
    currency,
    isPrimary,
  };

  return withTenant(ctx, async (tx) => {
    let rowId: string;
    let created: boolean;
    if (p.id) {
      // Demote any OTHER primary first — the partial unique index would otherwise reject the update.
      if (isPrimary) {
        await tx
          .update(companyBankProfile)
          .set({ isPrimary: false })
          .where(and(eq(companyBankProfile.companyId, p.companyId), ne(companyBankProfile.id, p.id)));
      }
      const [row] = await tx
        .update(companyBankProfile)
        .set({ ...fields, updatedAt: new Date() })
        .where(and(eq(companyBankProfile.id, p.id), eq(companyBankProfile.companyId, p.companyId)))
        .returning({ id: companyBankProfile.id });
      if (!row) throw new Error('Bank account not found');
      rowId = row.id;
      created = false;
    } else {
      if (isPrimary) {
        await tx
          .update(companyBankProfile)
          .set({ isPrimary: false })
          .where(eq(companyBankProfile.companyId, p.companyId));
      }
      const [row] = await tx
        .insert(companyBankProfile)
        .values({ tenantId: ctx.tenantId, companyId: p.companyId, ...fields })
        .returning({ id: companyBankProfile.id });
      rowId = row.id;
      created = true;
    }

    await appendEvent(tx, {
      tenantId: ctx.tenantId,
      aggregateType: 'company-bank-profile',
      aggregateId: rowId,
      eventType: 'company-bank-profile.set',
      actor: actorOf(ctx),
      // ADR-0030 Layer-0: reference only — corporate ID / debit account / SWIFT stay out of the event
      // stream. The bank key, rail, currency and primary flag are configuration, not credentials.
      payload: {
        companyBankProfileId: rowId,
        companyId: p.companyId,
        bank: p.bank,
        txnType,
        currency,
        isPrimary,
        created,
        // Whether ai-hr can build this bank's salary file. Logged so a later "why did the file fail"
        // investigation can see the account was saved against an unsupported bank knowingly.
        disbursementFormat: disbursementFormatFor(p.bank),
      },
    });
    return { id: rowId };
  });
}

/** Remove a bank account (config, not history — hard delete). Admin-only via RLS.
 *  Any company_statutory_authority pointing at it is unrouted, not deleted (FK ON DELETE SET NULL, 0276).
 *
 *  ⚠️ IT REFUSES NOTHING. There is no check for a statutory body paid from this account (the FK above
 *  silently unroutes it) and no "paying account" concept to check: nothing else references this table.
 *  The only ways it does not delete are RLS (a non-admin's delete matches no row) and an unknown id — both
 *  return `{ id: null }` without throwing.
 *
 *  48652e18 (r419) — also returns the removed row's `bank` and `debitAccountNo`, so the action can say
 *  WHICH account went ("…ending 5678"). They are returned to the caller only; the event payload below is
 *  unchanged and still carries no account number (ADR-0030 Layer-0). */
export async function removeCompanyBankProfile(
  ctx: SessionContext,
  p: { id: string; companyId?: string },
): Promise<{ id: string; bank: string; debitAccountNo: string } | { id: null }> {
  return withTenant(ctx, async (tx) => {
    const [row] = await tx
      .delete(companyBankProfile)
      // r419 verify D1 — scoped by company when the caller names one, as the update path already is: a
      // tenant-wide admin posting company B's account from company A's screen deletes nothing.
      .where(p.companyId ? and(eq(companyBankProfile.id, p.id), eq(companyBankProfile.companyId, p.companyId)) : eq(companyBankProfile.id, p.id))
      .returning({
        id: companyBankProfile.id,
        companyId: companyBankProfile.companyId,
        bank: companyBankProfile.bank,
        debitAccountNo: companyBankProfile.debitAccountNo,
      });
    if (!row) return { id: null };
    await appendEvent(tx, {
      tenantId: ctx.tenantId,
      aggregateType: 'company-bank-profile',
      aggregateId: row.id,
      eventType: 'company-bank-profile.removed',
      actor: actorOf(ctx),
      payload: { companyBankProfileId: row.id, companyId: row.companyId, bank: row.bank },
    });
    return { id: row.id, bank: row.bank, debitAccountNo: row.debitAccountNo };
  });
}

/** The columns every read of this table returns (kept in one place — the two listers share it). */
const PROFILE_COLUMNS = {
  id: companyBankProfile.id,
  companyId: companyBankProfile.companyId,
  bank: companyBankProfile.bank,
  corporateId: companyBankProfile.corporateId,
  debitAccountNo: companyBankProfile.debitAccountNo,
  orgName: companyBankProfile.orgName,
  txnType: companyBankProfile.txnType,
  accountLabel: companyBankProfile.accountLabel,
  accountName: companyBankProfile.accountName,
  accountType: companyBankProfile.accountType,
  branch: companyBankProfile.branch,
  swiftCode: companyBankProfile.swiftCode,
  currency: companyBankProfile.currency,
  isPrimary: companyBankProfile.isPrimary,
};

/** List a company's bank accounts (admin-only via RLS). */
export async function listCompanyBankProfiles(ctx: SessionContext, companyId: string) {
  return withTenant(ctx, (tx) =>
    tx
      .select(PROFILE_COLUMNS)
      .from(companyBankProfile)
      .where(eq(companyBankProfile.companyId, companyId))
      .orderBy(companyBankProfile.bank, companyBankProfile.createdAt),
  );
}

/** Every bank account the caller can administer (RLS scopes to admin-for-company). The admin
 *  Organization page groups these by company, like listCompanyStatutoryMY. */
export async function listAllCompanyBankProfiles(ctx: SessionContext) {
  return withTenant(ctx, (tx) =>
    tx
      .select(PROFILE_COLUMNS)
      .from(companyBankProfile)
      .orderBy(companyBankProfile.companyId, companyBankProfile.bank, companyBankProfile.createdAt),
  );
}
