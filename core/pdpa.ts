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
import { employeeStatutoryMy, employment, person, profileChangeRequest } from '../db/schema';
import { shredSubjectInTx } from './pii-vault';

/** LHDN income-tax / EPF / SOCSO records must be kept ~7 years; statutory PII stays locked until then. */
export const RETENTION_YEARS = 7;

export type ErasureScope = 'contact' | 'financial' | 'identity' | 'statutory-ids' | 'all';

type PiiField = { key: string; table: 'person' | 'statutory'; statutoryLocked: boolean; scopes: ErasureScope[] };

// Only NULLable cleartext fields. notNull identity (full_name, primary_email, ic_number) is never NULLed
// here — it identifies the subject on retained statutory documents and would need a tombstone, not a NULL.
const PII_FIELDS: PiiField[] = [
  { key: 'phone', table: 'person', statutoryLocked: false, scopes: ['contact'] },
  { key: 'address', table: 'person', statutoryLocked: false, scopes: ['contact'] },
  { key: 'emergencyContactName', table: 'person', statutoryLocked: false, scopes: ['contact'] },
  { key: 'emergencyContactPhone', table: 'person', statutoryLocked: false, scopes: ['contact'] },
  { key: 'dateOfBirth', table: 'person', statutoryLocked: true, scopes: ['identity'] }, // drives EPF age bands
  { key: 'bankName', table: 'statutory', statutoryLocked: true, scopes: ['financial'] },
  { key: 'bankAccountNo', table: 'statutory', statutoryLocked: true, scopes: ['financial'] },
  { key: 'epfNumber', table: 'statutory', statutoryLocked: true, scopes: ['statutory-ids'] },
  { key: 'socsoNumber', table: 'statutory', statutoryLocked: true, scopes: ['statutory-ids'] },
  { key: 'taxNumber', table: 'statutory', statutoryLocked: true, scopes: ['statutory-ids'] },
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
    await tx
      .update(profileChangeRequest)
      .set({ proposed: { redacted: true } })
      .where(eq(profileChangeRequest.personId, emp.personId));

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
