/**
 * Per-authority statutory payment configuration (R46 orgbank 84719377).
 *
 * company_statutory_my holds the employer REFERENCE NUMBERS in one flat row per company. It has no room —
 * structurally — for per-body payment routing. This service owns the child table that does: for each
 * statutory body, which company bank account pays it, the body's correspondence address + contact, and the
 * authorised signatory.
 *
 * Every mutation runs inside `withTenant` (RLS-scoped, one transaction) and appends a domain event before
 * returning, following core/bank-profile.ts. ADR-0030 Layer-0: the authority ACCOUNT NUMBER is redacted
 * from event payloads for the same reason a debit account is — it is a payment identifier. The address /
 * phone are employer data (the authority's own published contact details) and are not redacted; the
 * signatory is logged as a person REFERENCE only, never a name.
 */
import { and, eq, isNull } from 'drizzle-orm';
import { withTenant, type SessionContext } from '../db/client';
import { appendEvent, actorOf } from '../db/events';
import { companyBankProfile, companyStatutoryAuthority, employment, person } from '../db/schema';
// The controlled authority set lives in lib/ so the client Company panel can import it too (core/ pulls in
// the DB client). Re-exported here so service callers keep one import site.
import { STATUTORY_AUTHORITIES, isStatutoryAuthority, type StatutoryAuthority } from '../lib/statutory-authorities';

export { STATUTORY_AUTHORITIES, isStatutoryAuthority };
export type { StatutoryAuthority };

export type CompanyStatutoryAuthorityInput = {
  companyId: string;
  authority: string;
  accountNo?: string | null;
  /** A company_bank_profile id — which of the company's accounts pays this body. Null = not routed yet. */
  bankProfileId?: string | null;
  addressLine1?: string | null;
  addressLine2?: string | null;
  addressLine3?: string | null;
  city?: string | null;
  state?: string | null;
  postcode?: string | null;
  country?: string | null;
  phone?: string | null;
  email?: string | null;
  /** A person id — the authorised signatory. Must be employed by THIS company (see below). */
  signatoryPersonId?: string | null;
};

const clean = (v: string | null | undefined): string | null => v?.trim() || null;

/**
 * Create or update the configuration for ONE (company, authority). Admin-only via RLS.
 *
 * Two cross-entity references are validated here rather than trusted from the form, because RLS alone would
 * not stop an admin of company A from pointing company A's EPF row at company B's bank account or staff:
 *  - bankProfileId must belong to the SAME company.
 *  - signatoryPersonId must have an employment in the SAME company. Terminated employments are ACCEPTED on
 *    the way in only when the value is unchanged (see below) — an admin cannot newly appoint a leaver, but
 *    editing the phone number of a row whose signatory has since left does not fail or silently wipe them.
 */
export async function upsertCompanyStatutoryAuthority(ctx: SessionContext, p: CompanyStatutoryAuthorityInput) {
  if (!isStatutoryAuthority(p.authority)) throw new Error(`Unknown statutory authority: ${p.authority}`);
  const bankProfileId = clean(p.bankProfileId);
  const signatoryPersonId = clean(p.signatoryPersonId);

  return withTenant(ctx, async (tx) => {
    if (bankProfileId) {
      const [bp] = await tx
        .select({ id: companyBankProfile.id })
        .from(companyBankProfile)
        .where(and(eq(companyBankProfile.id, bankProfileId), eq(companyBankProfile.companyId, p.companyId)));
      if (!bp) throw new Error('Choose a bank account belonging to this company');
    }

    const [existing] = await tx
      .select({ id: companyStatutoryAuthority.id, signatoryPersonId: companyStatutoryAuthority.signatoryPersonId })
      .from(companyStatutoryAuthority)
      .where(
        and(
          eq(companyStatutoryAuthority.companyId, p.companyId),
          eq(companyStatutoryAuthority.authority, p.authority),
        ),
      );

    if (signatoryPersonId && signatoryPersonId !== existing?.signatoryPersonId) {
      // A NEWLY chosen signatory must be an ACTIVE employee of this company. An unchanged one is left alone
      // so an employee leaving does not block edits to the rest of the row (nor silently clear the field).
      const [emp] = await tx
        .select({ id: employment.id })
        .from(employment)
        .where(
          and(
            eq(employment.personId, signatoryPersonId),
            eq(employment.companyId, p.companyId),
            isNull(employment.terminatedOn),
          ),
        );
      if (!emp) throw new Error('Choose a signatory who is an active employee of this company');
    }

    const fields = {
      accountNo: clean(p.accountNo),
      bankProfileId,
      addressLine1: clean(p.addressLine1),
      addressLine2: clean(p.addressLine2),
      addressLine3: clean(p.addressLine3),
      city: clean(p.city),
      state: clean(p.state),
      postcode: clean(p.postcode),
      country: clean(p.country),
      phone: clean(p.phone),
      email: clean(p.email),
      signatoryPersonId,
    };

    const [row] = await tx
      .insert(companyStatutoryAuthority)
      .values({ tenantId: ctx.tenantId, companyId: p.companyId, authority: p.authority, ...fields })
      .onConflictDoUpdate({
        target: [companyStatutoryAuthority.companyId, companyStatutoryAuthority.authority],
        set: { ...fields, updatedAt: new Date() },
      })
      .returning({ id: companyStatutoryAuthority.id });

    await appendEvent(tx, {
      tenantId: ctx.tenantId,
      aggregateType: 'company-statutory-authority',
      aggregateId: row.id,
      eventType: 'company-statutory-authority.set',
      actor: actorOf(ctx),
      // ADR-0030 Layer-0: the authority ACCOUNT NUMBER is a payment identifier and stays out of the log,
      // as does the signatory's name (only the id reference is kept). Which account pays and whether a
      // signatory is set ARE the audit-relevant facts.
      payload: {
        companyStatutoryAuthorityId: row.id,
        companyId: p.companyId,
        authority: p.authority,
        bankProfileId,
        hasAccountNo: !!fields.accountNo,
        signatoryPersonId,
      },
    });
    return { id: row.id };
  });
}

/** Clear one authority's configuration (config, not history — hard delete). Admin-only via RLS. */
export async function removeCompanyStatutoryAuthority(ctx: SessionContext, p: { id: string }) {
  return withTenant(ctx, async (tx) => {
    const [row] = await tx
      .delete(companyStatutoryAuthority)
      .where(eq(companyStatutoryAuthority.id, p.id))
      .returning({
        id: companyStatutoryAuthority.id,
        companyId: companyStatutoryAuthority.companyId,
        authority: companyStatutoryAuthority.authority,
      });
    if (!row) return { id: null };
    await appendEvent(tx, {
      tenantId: ctx.tenantId,
      aggregateType: 'company-statutory-authority',
      aggregateId: row.id,
      eventType: 'company-statutory-authority.removed',
      actor: actorOf(ctx),
      payload: { companyStatutoryAuthorityId: row.id, companyId: row.companyId, authority: row.authority },
    });
    return { id: row.id };
  });
}

const AUTHORITY_COLUMNS = {
  id: companyStatutoryAuthority.id,
  companyId: companyStatutoryAuthority.companyId,
  authority: companyStatutoryAuthority.authority,
  accountNo: companyStatutoryAuthority.accountNo,
  bankProfileId: companyStatutoryAuthority.bankProfileId,
  addressLine1: companyStatutoryAuthority.addressLine1,
  addressLine2: companyStatutoryAuthority.addressLine2,
  addressLine3: companyStatutoryAuthority.addressLine3,
  city: companyStatutoryAuthority.city,
  state: companyStatutoryAuthority.state,
  postcode: companyStatutoryAuthority.postcode,
  country: companyStatutoryAuthority.country,
  phone: companyStatutoryAuthority.phone,
  email: companyStatutoryAuthority.email,
  signatoryPersonId: companyStatutoryAuthority.signatoryPersonId,
};

/** One company's per-authority configuration (admin-only via RLS). */
export async function listCompanyStatutoryAuthorities(ctx: SessionContext, companyId: string) {
  return withTenant(ctx, (tx) =>
    tx
      .select(AUTHORITY_COLUMNS)
      .from(companyStatutoryAuthority)
      .where(eq(companyStatutoryAuthority.companyId, companyId))
      .orderBy(companyStatutoryAuthority.authority),
  );
}

/** Every authority row the caller can administer — the admin Organization page groups these by company. */
export async function listAllCompanyStatutoryAuthorities(ctx: SessionContext) {
  return withTenant(ctx, (tx) =>
    tx
      .select(AUTHORITY_COLUMNS)
      .from(companyStatutoryAuthority)
      .orderBy(companyStatutoryAuthority.companyId, companyStatutoryAuthority.authority),
  );
}

/**
 * Signatory candidates: ACTIVE employees, per company. The picker is company-scoped (an authorised
 * signatory signs for the entity that employs them) and this is also the set the service validates a NEWLY
 * chosen signatory against. Distinct people only — a person holding two concurrent employments in the same
 * company must not appear twice.
 */
export async function listSignatoryCandidates(ctx: SessionContext) {
  return withTenant(ctx, async (tx) => {
    const rows = await tx
      .selectDistinct({ companyId: employment.companyId, personId: person.id, name: person.fullName })
      .from(employment)
      .innerJoin(person, eq(person.id, employment.personId))
      .where(isNull(employment.terminatedOn))
      .orderBy(employment.companyId, person.fullName);
    return rows;
  });
}
