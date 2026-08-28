/**
 * Malaysia company-level statutory identity (localization pack, ADR-0008 / ADR-0009).
 * Each legal entity files under its own employer registrations (KWSP / PERKESO / LHDN E-no /
 * MyInvois TIN / SSM). Upsert keyed by company; admin-managed (RLS).
 */
import { eq, sql } from 'drizzle-orm';
import { withTenant, type SessionContext } from '../../db/client';
import { actorOf, appendEvent } from '../../db/events';
import { companyStatutoryMy } from '../../db/schema';
import type { HrdfStatus } from './statutory-tables';

/**
 * A PARTIAL PATCH of the company's statutory identity row (r226).
 *
 * ⚠ THE SEMANTICS CHANGED, AND THE CHANGE IS THE POINT. This used to be a FULL-ROW OVERWRITE: every one
 * of the five text fields was written as `p.x ?? null`, so a caller that named only its own field
 * silently blanked the other four. That was safe only while exactly ONE form on exactly one screen owned
 * the whole row. It no longer is: r226 puts each statutory body's filing number on that body's own card
 * (components/company-panel.tsx), so five different forms now write into this one row, and under the old
 * rule saving the EPF card would have NULLed SOCSO, LHDN, MyInvois and SSM — silently, behind a green
 * suite and a 200.
 *
 * The rule now:
 *   • a field the caller does NOT name is left exactly as it is on the stored row;
 *   • a field the caller names is written, and an empty string CLEARS it to NULL (that is how an
 *     operator blanks a number — the server action posts '' for a box that was emptied, and omits the
 *     key entirely for a box that form does not carry).
 *
 * `null` and `''` both mean "clear it"; `undefined` — or an absent key — means "don't touch it".
 */
export type CompanyStatutoryInput = {
  companyId: string;
  epfEmployerNo?: string | null;
  socsoEmployerCode?: string | null;
  lhdnEmployerNo?: string | null;
  myinvoisTin?: string | null;
  ssmRegistrationNo?: string | null;
  /** HRDF contribution rate (stored as not_registered / mandatory / optional = no / 1.0% / 0.5%
   *  contribution). Omitted on upsert = leave at the column default (insert) / unchanged (update). */
  hrdfStatus?: HrdfStatus;
};

/** The five text columns this row carries, in the order the screens present them. */
const STATUTORY_TEXT_FIELDS = [
  'epfEmployerNo',
  'socsoEmployerCode',
  'lhdnEmployerNo',
  'myinvoisTin',
  'ssmRegistrationNo',
] as const;

export async function setCompanyStatutoryMY(ctx: SessionContext, p: CompanyStatutoryInput) {
  // Only the fields the caller actually NAMED are written — see the type comment above. `''` is a real
  // instruction ("the operator cleared this box") and becomes NULL; `undefined` is the absence of one.
  const values: Partial<Record<(typeof STATUTORY_TEXT_FIELDS)[number], string | null>> & {
    hrdfStatus?: HrdfStatus;
  } = {};
  for (const f of STATUTORY_TEXT_FIELDS) {
    if (p[f] !== undefined) values[f] = p[f] || null;
  }
  // Default to not_registered on first insert; on update only change it when provided.
  if (p.hrdfStatus !== undefined) values.hrdfStatus = p.hrdfStatus;
  return withTenant(ctx, async (tx) => {
    // hrdfStatus is read alongside the id so a rate change can be audited old → new. Both editable
    // surfaces (Organization ▸ Statutory and Admin ▸ Payroll config) write through this one function.
    const [existing] = await tx
      .select({ id: companyStatutoryMy.id, hrdfStatus: companyStatutoryMy.hrdfStatus })
      .from(companyStatutoryMy)
      .where(eq(companyStatutoryMy.companyId, p.companyId))
      .limit(1);
    let id: string;
    if (existing) {
      await tx
        .update(companyStatutoryMy)
        .set({ ...values, updatedAt: sql`now()` })
        .where(eq(companyStatutoryMy.id, existing.id));
      id = existing.id;
    } else {
      const [row] = await tx
        .insert(companyStatutoryMy)
        .values({ tenantId: ctx.tenantId, companyId: p.companyId, ...values })
        .returning({ id: companyStatutoryMy.id });
      id = row.id;
    }
    // Audit trail for the HRDF Contribution Rate: emit the repo's { before, after } convention so
    // lib/audit-format renders an accented "old → new" line (actor + timestamp ride the envelope).
    // Gated on an actual CHANGE, not merely "provided" — both forms post hrdfStatus on every save
    // (it is a select with a defaultValue), so a provided-gate would log before == after noise on
    // every EPF/SOCSO-only edit.
    const hrdfChanged =
      existing !== undefined && p.hrdfStatus !== undefined && existing.hrdfStatus !== p.hrdfStatus;
    await appendEvent(tx, {
      tenantId: ctx.tenantId,
      aggregateType: 'company-statutory-my',
      aggregateId: id,
      eventType: existing ? 'company.statutory.my.updated' : 'company.statutory.my.created',
      actor: actorOf(ctx),
      payload: hrdfChanged
        ? {
            companyId: p.companyId,
            before: { hrdfStatus: existing.hrdfStatus },
            after: { hrdfStatus: p.hrdfStatus },
          }
        : { companyId: p.companyId },
    });
    return { id };
  });
}

export function getCompanyStatutoryMY(ctx: SessionContext, companyId: string) {
  return withTenant(ctx, async (tx) => {
    const [row] = await tx
      .select()
      .from(companyStatutoryMy)
      .where(eq(companyStatutoryMy.companyId, companyId))
      .limit(1);
    return row ?? null;
  });
}

export function listCompanyStatutoryMY(ctx: SessionContext) {
  return withTenant(ctx, (tx) => tx.select().from(companyStatutoryMy));
}
