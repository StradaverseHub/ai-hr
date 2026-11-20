import { and, asc, inArray, sql } from 'drizzle-orm';
import { withTenant, type SessionContext } from '@/db/client';
import { company } from '@/db/schema';

/** The workflow list needs only the labels for companies the current administrator may manage. */
export function attendanceWorkflowCompanyLabels(session: SessionContext, companyIds: string[]) {
  if (!companyIds.length) return Promise.resolve([]);
  return withTenant(session, tx => tx
    .select({ id: company.id, name: company.legalName })
    .from(company)
    .where(and(inArray(company.id, companyIds), sql`app.is_admin_for(${company.id})`))
    .orderBy(asc(company.legalName)), { readOnlySnapshot: true });
}
