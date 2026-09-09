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
import { eq } from 'drizzle-orm';
import { withTenant, type SessionContext } from '../db/client';
import { appendEvent, actorOf } from '../db/events';
import { employeeDependent, employeeStatutoryMy, employment, person, personEmergencyContact, personPhoto, profileChangeRequest } from '../db/schema';
import { shredSubjectInTx } from './pii-vault';

/** LHDN income-tax / EPF / SOCSO records must be kept ~7 years; statutory PII stays locked until then. */
export const RETENTION_YEARS = 7;

export type ErasureScope = 'contact' | 'financial' | 'identity' | 'statutory-ids' | 'all';

type PiiField = { key: string; table: 'person' | 'statutory'; statutoryLocked: boolean; scopes: ErasureScope[] };

// Only NULLable cleartext fields. notNull identity (full_name, primary_email, ic_number) is never NULLed
// here — it identifies the subject on retained statutory documents and would need a tombstone, not a NULL.
const PII_FIELDS: PiiField[] = [
  { key: 'phone', table: 'person', statutoryLocked: false, scopes: ['contact'] },
  { key: 'address', table: 'person', statutoryLocked: false, scopes: ['contact'] }, // legacy single-line
  // 23ad620e — emergencyContactName / Phone / Relationship / Phone2 / Address were listed here while they
  // were person COLUMNS. Migration 0322 dropped them; the emergency contact is now a row in
  // person_emergency_contact and is erased WHOLESALE further down (`emergencyContacts`) rather than NULLed
  // field by field. Listing a dropped column here would build an UPDATE against a column that is gone.
  // b4682879 — new contact & structured-address fields (all erasable immediately; not statutory-locked).
  { key: 'personalEmail', table: 'person', statutoryLocked: false, scopes: ['contact'] },
  { key: 'addressLine1', table: 'person', statutoryLocked: false, scopes: ['contact'] },
  { key: 'addressLine2', table: 'person', statutoryLocked: false, scopes: ['contact'] },
  { key: 'addressLine3', table: 'person', statutoryLocked: false, scopes: ['contact'] },
  { key: 'postcode', table: 'person', statutoryLocked: false, scopes: ['contact'] },
  { key: 'city', table: 'person', statutoryLocked: false, scopes: ['contact'] },
  { key: 'state', table: 'person', statutoryLocked: false, scopes: ['contact'] },
  { key: 'country', table: 'person', statutoryLocked: false, scopes: ['contact'] },
  // 3a25f5ee — Permanent + Correspondence structured addresses (migration 0213); personal data, erasable
  // immediately under the same contact scope as the legacy single address, never statutory-locked.
  { key: 'permanentAddressLine1', table: 'person', statutoryLocked: false, scopes: ['contact'] },
  { key: 'permanentAddressLine2', table: 'person', statutoryLocked: false, scopes: ['contact'] },
  { key: 'permanentAddressLine3', table: 'person', statutoryLocked: false, scopes: ['contact'] },
  { key: 'permanentPostcode', table: 'person', statutoryLocked: false, scopes: ['contact'] },
  { key: 'permanentCity', table: 'person', statutoryLocked: false, scopes: ['contact'] },
  { key: 'permanentState', table: 'person', statutoryLocked: false, scopes: ['contact'] },
  { key: 'permanentCountry', table: 'person', statutoryLocked: false, scopes: ['contact'] },
  { key: 'correspondenceAddressLine1', table: 'person', statutoryLocked: false, scopes: ['contact'] },
  { key: 'correspondenceAddressLine2', table: 'person', statutoryLocked: false, scopes: ['contact'] },
  { key: 'correspondenceAddressLine3', table: 'person', statutoryLocked: false, scopes: ['contact'] },
  { key: 'correspondencePostcode', table: 'person', statutoryLocked: false, scopes: ['contact'] },
  { key: 'correspondenceCity', table: 'person', statutoryLocked: false, scopes: ['contact'] },
  { key: 'correspondenceState', table: 'person', statutoryLocked: false, scopes: ['contact'] },
  { key: 'correspondenceCountry', table: 'person', statutoryLocked: false, scopes: ['contact'] },
  // bf953339 — Home + Correspondence phone pair (migration 0304); contact PII, erasable immediately like
  // the existing `phone` (mobile) column, never statutory-locked.
  { key: 'homePhone', table: 'person', statutoryLocked: false, scopes: ['contact'] },
  { key: 'correspondenceMobilePhone', table: 'person', statutoryLocked: false, scopes: ['contact'] },
  { key: 'correspondenceHomePhone', table: 'person', statutoryLocked: false, scopes: ['contact'] },
  // b4682879 — name parts + PDPA s.40 sensitive demographics (identity scope; erasable immediately).
  { key: 'firstName', table: 'person', statutoryLocked: false, scopes: ['identity'] },
  { key: 'lastName', table: 'person', statutoryLocked: false, scopes: ['identity'] },
  { key: 'preferredName', table: 'person', statutoryLocked: false, scopes: ['identity'] },
  { key: 'religion', table: 'person', statutoryLocked: false, scopes: ['identity'] },
  { key: 'race', table: 'person', statutoryLocked: false, scopes: ['identity'] },
  { key: 'nationality', table: 'person', statutoryLocked: false, scopes: ['identity'] },
  { key: 'dateOfBirth', table: 'person', statutoryLocked: true, scopes: ['identity'] }, // drives EPF age bands
  { key: 'bankName', table: 'statutory', statutoryLocked: true, scopes: ['financial'] },
  { key: 'bankAccountNo', table: 'statutory', statutoryLocked: true, scopes: ['financial'] },
  { key: 'epfNumber', table: 'statutory', statutoryLocked: true, scopes: ['statutory-ids'] },
  { key: 'socsoNumber', table: 'statutory', statutoryLocked: true, scopes: ['statutory-ids'] },
  { key: 'taxNumber', table: 'statutory', statutoryLocked: true, scopes: ['statutory-ids'] },
  // ── d64d0df4 — ERASURE SCOPE FOR THE DISABILITY / CHILD-RELIEF CLAIMS. Decision recorded here because
  // the approved plan required one BEFORE the columns landed, and because two of the three fields hold
  // health data about people who are NOT the employee (a spouse, and children).
  //
  // DECIDED: they are erased with the rest of the subject's data once the LHDN retention period lifts —
  // i.e. statutoryLocked, under the `identity` scope alongside the other PDPA s.40 sensitive
  // demographics (religion / race), NOT under `statutory-ids`, which is about registration NUMBERS.
  //
  // ONLY child_relief_table is listed. The mechanism below NULLs a column, and the other two
  // (disabled_individual, migration 0341; disabled_spouse, migration 0356) are NOT NULL booleans
  // defaulting to false: NULLing them would violate the constraint, and this list has no "reset to
  // default" form. They are therefore out of reach of erasure until the mechanism gains one — a gap
  // deliberately recorded here rather than papered over, and the reason child_relief_table was made
  // NULLable in the first place. The two booleans say only "a claim was made"; the grid is the field
  // that says how many of this person's children are disabled, which is why it is the one that matters
  // most and the one that is covered.
  { key: 'childReliefTable', table: 'statutory', statutoryLocked: true, scopes: ['identity'] },
];

const inScope = (f: PiiField, scope: ErasureScope) => scope === 'all' || f.scopes.includes(scope);

function liftDate(terminatedOn: string): string {
  const d = new Date(terminatedOn);
  d.setFullYear(d.getFullYear() + RETENTION_YEARS);
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
    const [emp] = await tx
      .select({ personId: employment.personId, terminatedOn: employment.terminatedOn })
      .from(employment)
      .where(eq(employment.id, p.subjectEmploymentId))
      .limit(1);
    if (!emp) throw new Error(`No employment ${p.subjectEmploymentId} for PII erasure`);

    // (2) retention guard
    const lifted = retentionLifted(emp.terminatedOn, new Date());
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
    await tx
      .update(profileChangeRequest)
      .set({ proposed: { redacted: true }, decisionReason: null })
      .where(eq(profileChangeRequest.personId, emp.personId));

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
    const depContactCols = ['phone', 'residentialAddress', 'companyName', 'employerAddress'] as const;
    const depIdentityCols = ['icOrPassport', 'passportNumber'] as const;
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
