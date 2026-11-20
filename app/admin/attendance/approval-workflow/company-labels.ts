import { and, asc, inArray, sql } from 'drizzle-orm';
import { withTenant, type SessionContext, type Tx } from '@/db/client';
import { company } from '@/db/schema';

const selectCompanyLabels = (tx: Tx, companyIds: string[]) => tx
  .select({ id: company.id, name: company.legalName })
  .from(company)
  .where(and(inArray(company.id, companyIds), sql`app.is_admin_for(${company.id})`))
  .orderBy(asc(company.legalName));

/** The workflow list needs only the labels for companies the current administrator may manage. */
export function attendanceWorkflowCompanyLabels(session: SessionContext, companyIds: string[]) {
  if (!companyIds.length) return Promise.resolve([]);
  return withTenant(session, async tx => selectCompanyLabels(tx, companyIds), { readOnlySnapshot: true });
}

/** The blank editor needs its company choices and the existing all-company authority. */
export function attendanceWorkflowCreationCompanies(session: SessionContext, companyIds: string[]) {
  if (!companyIds.length) return Promise.resolve({ companies: [], canManageAllCompanies: false });
  return withTenant(session, async tx => {
    const companies = await selectCompanyLabels(tx, companyIds);
    if (!companies.length) return { companies, canManageAllCompanies: false };
    const [allCompany] = await tx.execute<{ ok: boolean }>(sql`
      select app.principal_snapshot_current() and app.is_admin_for(NULL::uuid) as ok
    `);
    return { companies, canManageAllCompanies: allCompany?.ok === true };
  }, { readOnlySnapshot: true });
}
