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

export type CompanyStatutoryInput = {
  companyId: string;
  epfEmployerNo?: string;
  socsoEmployerCode?: string;
  lhdnEmployerNo?: string;
  myinvoisTin?: string;
  ssmRegistrationNo?: string;
  /** HRDF contribution rate (stored as not_registered / mandatory / optional = no / 1.0% / 0.5%
   *  contribution). Omitted on upsert = leave at the column default. */
  hrdfStatus?: HrdfStatus;
};

export async function setCompanyStatutoryMY(ctx: SessionContext, p: CompanyStatutoryInput) {
  const values = {
    epfEmployerNo: p.epfEmployerNo ?? null,
    socsoEmployerCode: p.socsoEmployerCode ?? null,
    lhdnEmployerNo: p.lhdnEmployerNo ?? null,
    myinvoisTin: p.myinvoisTin ?? null,
    ssmRegistrationNo: p.ssmRegistrationNo ?? null,
    // Default to not_registered on first insert; on update only change it when provided.
    ...(p.hrdfStatus !== undefined ? { hrdfStatus: p.hrdfStatus } : {}),
  };
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
