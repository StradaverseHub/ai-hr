/** Read-only review candidates. Current root facts are evidence, never an automatic correction policy. */
import { sql } from 'drizzle-orm';
import { withTenant, type SessionContext } from '../db/client';

export type LeaveSplitReviewRow = {
  requestId: string; employmentId: string; rootReference: string | null; rootRequestId: string | null; employee: string; employeeNo: string | null;
  startDate: string; endDate: string; differences: string[];
  charging: 'charged' | 'uncharged_import' | 'no_debit_evidence';
  lineage: 'current_root_comparison' | 'unresolved';
};

export async function leaveSplitReview(ctx: SessionContext, p: { limit?: number; offset?: number; companyIds?: readonly string[] } = {}) {
  if (!(ctx.roles ?? []).some(role => role === 'hr_admin' || role === 'super_admin')
    && !(ctx.grants ?? []).some(grant => grant.role === 'hr_admin' || grant.role === 'super_admin')) throw new Error('HR administrator required');
  const limit = Math.min(2000, Math.max(1, Math.trunc(p.limit ?? 25)));
  const offset = Math.max(0, Math.trunc(p.offset ?? 0));
  if (p.companyIds?.length === 0) return { rows: [], total: 0 };
  return withTenant(ctx, async tx => {
    const [result] = await tx.execute(sql`
      WITH RECURSIVE scoped AS MATERIALIZED (
        SELECT lr.*, p.full_name AS employee, e.employee_code AS employee_no
        FROM leave_request lr
        JOIN employment e ON e.id=lr.employment_id AND e.tenant_id=lr.tenant_id
        JOIN person p ON p.id=e.person_id AND p.tenant_id=e.tenant_id
        WHERE lr.tenant_id=app.current_tenant_id() AND app.is_admin_for(e.company_id)
          ${p.companyIds ? sql`AND e.company_id IN (SELECT jsonb_array_elements_text(${JSON.stringify(p.companyIds)}::jsonb)::uuid)` : sql``}
      ), links AS MATERIALIZED (
        SELECT DISTINCT ON (ev.aggregate_id) ev.aggregate_id AS child,
          CASE WHEN ev.payload->>'splitFromRequestId' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
            THEN (ev.payload->>'splitFromRequestId')::uuid END AS parent
        FROM domain_event ev JOIN scoped s ON s.id=ev.aggregate_id
        WHERE ev.tenant_id=app.current_tenant_id() AND ev.aggregate_type='leave-request' AND ev.event_type='leave-request.split'
        ORDER BY ev.aggregate_id,ev.sequence DESC
      ), ancestry AS (
        SELECT s.id AS child,s.id AS ancestor,ARRAY[s.id] AS path,0 AS depth
        FROM scoped s WHERE s.status='approved' AND EXISTS(SELECT 1 FROM links l WHERE l.child=s.id)
        UNION ALL
        SELECT a.child,parent.id,a.path||parent.id,a.depth+1
        FROM ancestry a JOIN links l ON l.child=a.ancestor
        JOIN scoped current_row ON current_row.id=a.ancestor
        JOIN scoped parent ON parent.id=l.parent AND parent.employment_id=current_row.employment_id
        WHERE a.depth<64 AND NOT parent.id=ANY(a.path)
      ), roots AS (
        SELECT DISTINCT ON (child) child,ancestor,depth,path FROM ancestry ORDER BY child,depth DESC
      ), findings AS (
        SELECT child.id AS "requestId",child.employment_id AS "employmentId",root.external_reference AS "rootReference",CASE WHEN next_link.child IS NULL THEN root.id END AS "rootRequestId",
          child.employee,child.employee_no AS "employeeNo",child.start_date::text AS "startDate",child.end_date::text AS "endDate",
          CASE WHEN next_link.child IS NOT NULL THEN ARRAY['lineage']::text[] ELSE array_remove(ARRAY[
            CASE WHEN child.reason IS DISTINCT FROM root.reason THEN 'reason' END,
            CASE WHEN child.employee_remark IS DISTINCT FROM root.employee_remark THEN 'employeeRemark' END,
            CASE WHEN child.unpaid_consent_at IS DISTINCT FROM root.unpaid_consent_at OR child.unpaid_consent_by IS DISTINCT FROM root.unpaid_consent_by THEN 'consent' END,
            CASE WHEN child.surviving_children IS DISTINCT FROM root.surviving_children OR child.confinement_date IS DISTINCT FROM root.confinement_date THEN 'maternity' END,
            CASE WHEN child.allowance_eligible IS DISTINCT FROM root.allowance_eligible THEN 'allowanceEligible' END,
            CASE WHEN child.unpaid_days IS DISTINCT FROM root.unpaid_days THEN 'unpaidDays' END,
            CASE WHEN child.entitlement_year IS DISTINCT FROM root.entitlement_year THEN 'entitlementYear' END,
            CASE WHEN child.submitted_on IS DISTINCT FROM root.submitted_on OR child.created_at IS DISTINCT FROM root.created_at THEN 'submission' END,
            CASE WHEN child.imported_history IS DISTINCT FROM root.imported_history THEN 'importedHistory' END
          ]::text[],NULL) END AS differences,
          CASE WHEN EXISTS(SELECT 1 FROM leave_ledger ll WHERE ll.tenant_id=child.tenant_id AND ll.source_request_id=child.id AND ll.entry_type='debit') THEN 'charged'
            WHEN child.imported_history THEN 'uncharged_import' ELSE 'no_debit_evidence' END AS charging,
          CASE WHEN next_link.child IS NULL THEN 'current_root_comparison' ELSE 'unresolved' END AS lineage
        FROM roots r JOIN scoped child ON child.id=r.child JOIN scoped root ON root.id=r.ancestor
        LEFT JOIN links next_link ON next_link.child=root.id
      ), candidates AS (SELECT * FROM findings WHERE cardinality(differences)>0), page AS (
        SELECT * FROM candidates ORDER BY "startDate" DESC,"requestId" LIMIT ${limit} OFFSET ${offset}
      ) SELECT coalesce(jsonb_agg(to_jsonb(page) ORDER BY "startDate" DESC,"requestId"),'[]'::jsonb) AS rows,
        (SELECT count(*)::integer FROM candidates) AS total FROM page
    `) as unknown as { rows: LeaveSplitReviewRow[]; total: number }[];
    return result ?? { rows: [], total: 0 };
  });
}
