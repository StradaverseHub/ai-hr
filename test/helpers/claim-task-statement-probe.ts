/** Private review proposal only. Not imported by an application/service or installed as a native API. */
import {sql} from 'drizzle-orm';
import type {SessionContext} from '../../db/client';
import {claimRequest} from '../../db/schema';
import {withClaimsTenant} from '../../core/module-gate';
import {assertAssignedWorkPrincipalTx} from '../../core/approvals';
import type {AssignedApprovalMetadata} from '../../lib/assigned-work';

export async function claimTaskStatementProbe(ctx:SessionContext,companyIds?:string[],limit?:number){
 if(limit!==undefined&&(!Number.isSafeInteger(limit)||limit<1||limit>200))throw Error('Invalid private preview limit');
 return withClaimsTenant(ctx,async tx=>{
  await assertAssignedWorkPrincipalTx(tx,ctx);
  if(companyIds?.length===0)return {items:[] as AssignedApprovalMetadata[],total:0};
  const roles=ctx.roles??[],admin=roles.includes('super_admin')||roles.includes('hr_admin');
  const rows=await tx.execute<Omit<AssignedApprovalMetadata,'createdAt'>&{createdAt:Date|string;total:number}>(sql`
   WITH caller AS MATERIALIZED (
    SELECT (app.principal_snapshot_current()
     AND (${ctx.personId??null}::uuid IS NULL OR app.is_self_person(${ctx.personId??null}::uuid))) AS ok
   ), candidates AS MATERIALIZED (
    SELECT request.id,request.employment_id,request.created_at,header.person_id,header.employee
    FROM public.claim_request request CROSS JOIN caller
    INNER JOIN LATERAL app.delegated_approval_subject(request.employment_id,'claims','claims.claim') header ON true
    WHERE caller.ok AND request.tenant_id=${ctx.tenantId}::uuid AND request.status='pending'
     AND NOT app.is_self_person(header.person_id)
     AND ${companyIds===undefined?sql`true`:sql`header.company_id=ANY(ARRAY[${sql.join(companyIds.map(id=>sql`${id}::uuid`),sql`, `)}]::uuid[])`}
     AND CASE WHEN ${admin} THEN true ELSE app.workflow_task_reader('claims.claim',request.id) END
   ), subjects AS MATERIALIZED (
    SELECT DISTINCT employment_id FROM candidates
   ), legacy_decision AS MATERIALIZED (
    -- Header self-exclusion above is stronger than the scalar guard's first self check.
    -- Remaining scalar legacy branches keep their original order and native delegation owner.
    SELECT subject.employment_id,CASE
     WHEN ${admin} THEN true
     WHEN ${ctx.personId??null}::uuid IS NULL THEN false
     WHEN EXISTS(SELECT 1 FROM public.reporting_line line
      INNER JOIN public.employment manager ON manager.id=line.manager_employment_id
      WHERE line.subordinate_employment_id=subject.employment_id AND line.line_type='administrative'
       AND line.valid_from<=current_date AND (line.valid_to IS NULL OR line.valid_to>current_date)
       AND line.superseded_at IS NULL AND manager.person_id=${ctx.personId??null}::uuid) THEN true
     ELSE app.can_decide_via_delegation(subject.employment_id,'claims','claims.claim') END AS allowed
    FROM subjects subject
   ), decision AS MATERIALIZED (
    -- Keep the published additional native gate. No result survives this SQL statement.
    SELECT employment_id,CASE WHEN allowed THEN app.claim_decision_allowed(employment_id) ELSE false END AS allowed
    FROM legacy_decision
   ), eligible AS MATERIALIZED (
    SELECT candidate.* FROM candidates candidate INNER JOIN decision
     ON decision.employment_id=candidate.employment_id AND decision.allowed
   )
   SELECT id,employment_id AS "employmentId",person_id AS "personId",employee,created_at AS "createdAt",
    count(*) OVER()::int AS total
   FROM eligible ORDER BY created_at DESC,id ${limit===undefined?sql``:sql`LIMIT ${limit}`}
  `);
  return {items:rows.map(({total:_,...row})=>({...row,createdAt:row.createdAt instanceof Date?row.createdAt:claimRequest.createdAt.mapFromDriverValue(row.createdAt)})),total:rows[0]?.total??0};
 });
}
