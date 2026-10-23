/**
 * PDPA erasure-equivalent service (ADR-0030 §2 erasePersonPii). Malaysia has NO GDPR-style erasure right,
 * so this is Retention-Principle destruction + breach minimisation, NOT a blanket delete:
 *   1. resolve the subject;
 *   2. retention guard — refuse fields under the LHDN/EPF/SOCSO ~7-year statutory hold, naming what is
 *      withheld and why (returns a partial, never a silent over-delete);
 *   3. crypto-shred the subject's vault key (voids any sealed values, ADR-0030 Layer 1);
 *   4. NULL the erasable cleartext fields + redact the mutable profile_change_request.proposed store;
 *   5. append pii.erased (no PII payload) and return a report of erased vs withheld.
 * Admin/DPO-gated via RLS. Atomic — everything runs in one transaction.
 */
import { eq, sql } from 'drizzle-orm';
import { withTenant, type SessionContext } from '../db/client';
import { appendEvent, actorOf } from '../db/events';
import { employeeDependent, employeeStatutoryMy, employment, person, personEmergencyContact, personPhoto } from '../db/schema';
import { shredSubjectInTx } from './pii-vault';
import erasurePolicy from '../lib/pdpa-erasure-policy.json';

/** LHDN income-tax / EPF / SOCSO records must be kept ~7 years; statutory PII stays locked until then. */
export const RETENTION_YEARS = erasurePolicy.retentionYears;

export type ErasureScope = 'contact' | 'financial' | 'identity' | 'statutory-ids' | 'all';

type PiiField = { key: string; table: 'person' | 'statutory'; statutoryLocked: boolean; scopes: ErasureScope[] };

// Only NULLable cleartext fields. notNull identity (full_name, primary_email, ic_number) is never NULLed
// here — it identifies the subject on retained statutory documents and would need a tombstone, not a NULL.
// One declaration is shared with the SQL privacy-intent owner. Nullable identity/contact fields
// clear immediately; statutoryLocked fields retain the existing post-termination hold. Non-null
// identity and disability booleans are deliberately absent, preserving their retained meaning.
const PII_FIELDS = erasurePolicy.fields as PiiField[];

const inScope = (f: PiiField, scope: ErasureScope) => scope === 'all' || f.scopes.includes(scope);

function liftDate(terminatedOn: string): string {
  const d = new Date(terminatedOn);
  d.setUTCFullYear(d.getUTCFullYear() + RETENTION_YEARS);
  return d.toISOString().slice(0, 10);
}
/** Statutory hold lifts only RETENTION_YEARS after termination; while still employed it never lifts. */
function retentionLifted(terminatedOn: string | null, today: Date): boolean {
  if (!terminatedOn) return false;
  return new Date(liftDate(terminatedOn)) <= today;
}

export type ErasureReport = {
  erased: string[];
  withheld: { field: string; reason: string }[];
  shreddedKeys: number;
};

export async function erasePersonPii(
  ctx: SessionContext,
  p: { subjectEmploymentId: string; scope: ErasureScope; reason: string; requestRef: string },
): Promise<ErasureReport> {
  return withTenant(ctx, async (tx) => {
    // Independent privacy authority prepares only exact nullable erasure effects. It cannot grant
    // Workforce maintenance or lend its authority to an arbitrary value write.
    const [admission]=await tx.execute<{at:string}>(sql`select to_char(app.access_privacy_erasure_begin(${p.subjectEmploymentId}::uuid,${p.scope},${p.requestRef},${p.reason}) AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') as at`);
    if(!admission?.at)throw new Error('Privacy erasure admission unavailable.');
    const erasureAt=new Date(admission.at);
    if(!Number.isFinite(erasureAt.getTime()))throw new Error('Privacy erasure admission unavailable.');
    const [emp] = await tx
      .select({ personId: employment.personId, terminatedOn: employment.terminatedOn })
      .from(employment)
      .where(eq(employment.id, p.subjectEmploymentId))
      .limit(1);
    if (!emp) throw new Error(`No employment ${p.subjectEmploymentId} for PII erasure`);

    // (2) retention guard
    const lifted = retentionLifted(emp.terminatedOn, erasureAt);
    const erased: string[] = [];
    const withheld: { field: string; reason: string }[] = [];
    for (const f of PII_FIELDS) {
      if (!inScope(f, p.scope)) continue;
      if (f.statutoryLocked && !lifted) {
        withheld.push({
          field: f.key,
          reason: emp.terminatedOn
            ? `LHDN/EPF/SOCSO ${RETENTION_YEARS}yr retention (until ${liftDate(emp.terminatedOn)})`
            : 'LHDN/EPF/SOCSO retention — subject still employed',
        });
      } else {
        erased.push(f.key);
      }
    }

    // (3) crypto-shred — voids any vault-sealed values for the subject (idempotent)
    const { shredded } = await shredSubjectInTx(tx, ctx, p.subjectEmploymentId, `pii.erased:${p.requestRef}`);

    // (4) NULL erasable cleartext. The pii.erased event below is the audit record for these NULLs — no
    // per-field event (that would just duplicate the erasure log).
    const personSet: Record<string, null> = {};
    const statSet: Record<string, null> = {};
    for (const k of erased) (PII_FIELDS.find((f) => f.key === k)!.table === 'person' ? personSet : statSet)[k] = null;
    if (Object.keys(personSet).length) {
      await tx.update(person).set(personSet as Partial<typeof person.$inferInsert>).where(eq(person.id, emp.personId));
    }
    if (Object.keys(statSet).length) {
      await tx
        .update(employeeStatutoryMy)
        .set(statSet as Partial<typeof employeeStatutoryMy.$inferInsert>)
        .where(eq(employeeStatutoryMy.personId, emp.personId));
    }
    // The mutable proposed-change store holds cleartext PII in jsonb → redact it for this subject.
    //
    // r260 (9583deac stage two) added `decision_reason`: an approver's free sentence ABOUT this employee
    // ("The bank letter you attached is for a different account holder."), sitting in the same row as the
    // cleartext being redacted on the line above. core/profile.ts keeps that sentence OUT of the
    // append-only event log precisely because "it is RLS-scoped and erasable with the record" — so it has
    // to actually be erased here, or that justification is false and the free text outlives the PII.
    //
    // This UPDATE touches EVERY one of the subject's rows whatever their status, which is why 0458 adds a
    // plain nullable column and no CHECK: a rejected row is rewritten right here, and a table constraint
    // on `status = 'rejected' → reason present` would abort the whole erasure transaction on any legacy
    // rejection that has no reason. The rule lives at the decision instead (core/profile.ts).
    await tx.execute(sql`select app.redact_profile_request_pii(${emp.personId}::uuid)`);
    // Payroll keeps its outcome/reference; free-text follow-up explanations are erasable.
    await tx.execute(sql`select app.redact_leave_payroll_explanations(${p.subjectEmploymentId}::uuid)`);

    // b4682879 — the profile photograph is biometric-adjacent personal data (identity scope). Delete it on
    // an identity/all erasure and report it in `erased`. Never statutory-locked (a face photo is not a
    // retained tax/EPF record).
    if (p.scope === 'identity' || p.scope === 'all') {
      await tx.delete(personPhoto).where(eq(personPhoto.personId, emp.personId));
      erased.push('profilePhoto');
    }

    // 4535b733 — Family / dependent register PII (employee_dependent). This is benefits/insurance data, NOT
    // under the LHDN/EPF/SOCSO statutory retention hold, so it is erasable IMMEDIATELY when in scope. NULL
    // the sensitive columns across ALL of the person's dependent rows (contact-scope: phone / address /
    // employer; identity-scope: IC / passport). Not-in-scope fields (name/DOB/relationship) are untouched
    // — they carry no statutory obligation but are minimal identifiers we retain like person.full_name.
    const depContactCols = erasurePolicy.dependentContact;
    const depIdentityCols = erasurePolicy.dependentIdentity;
    const depSet: Record<string, null> = {};
    if (p.scope === 'contact' || p.scope === 'all') for (const c of depContactCols) depSet[c] = null;
    if (p.scope === 'identity' || p.scope === 'all') for (const c of depIdentityCols) depSet[c] = null;
    if (Object.keys(depSet).length) {
      // Only REPORT dependent fields that were actually cleared — when the person has no dependent rows,
      // nothing is erased and the report stays truthful (and existing erasure-scope assertions unaffected).
      const cleared = await tx
        .update(employeeDependent)
        .set(depSet as Partial<typeof employeeDependent.$inferInsert>)
        .where(eq(employeeDependent.personId, emp.personId))
        .returning({ id: employeeDependent.id });
      if (cleared.length > 0) for (const k of Object.keys(depSet)) erased.push(`dependent.${k}`);
    }

    // 23ad620e — the emergency-contact register (person_emergency_contact), which REPLACED the five
    // person.emergency_contact_* columns dropped by migration 0322. This is the only place an emergency
    // contact lives, so erasing it here is the whole obligation, not a supplement to a column NULL.
    // Contact PII about a THIRD party (next of kin) — never under the LHDN/EPF/SOCSO hold, so erasable
    // immediately when the contact scope is in play. The rows are DELETED, not blanked: unlike a dependent
    // (whose name/relationship we retain as a minimal benefits identifier) an emergency contact has no
    // residual purpose once the contact details are gone. Reported only when something was actually removed.
    if (p.scope === 'contact' || p.scope === 'all') {
      const removed = await tx
        .delete(personEmergencyContact)
        .where(eq(personEmergencyContact.personId, emp.personId))
        .returning({ id: personEmergencyContact.id });
      if (removed.length > 0) erased.push('emergencyContacts');
      const [consent] = await tx.execute(sql`select app.notification_email_revoke_contact(${p.subjectEmploymentId}::uuid) as revoked`) as unknown as {revoked:number}[];
      if (consent?.revoked) erased.push('workflowEmailConsent');
    }

    // (5) audit record — no PII payload
    await appendEvent(tx, {
      tenantId: ctx.tenantId,
      aggregateType: 'person',
      aggregateId: emp.personId,
      eventType: 'pii.erased',
      actor: actorOf(ctx),
      subjectEmploymentId: p.subjectEmploymentId,
      payload: { scope: p.scope, requestRef: p.requestRef, reason: p.reason, erasedFields: erased, withheld },
    });

    return { erased, withheld, shreddedKeys: shredded };
  });
}
