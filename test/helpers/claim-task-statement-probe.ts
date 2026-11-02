/** Private review proposal only. No application/native API imports this test helper. */
import {sql,type SQL} from 'drizzle-orm';
import type {SessionContext,Tx} from '../../db/client';
import {claimRequest} from '../../db/schema';
import {withClaimsTenant} from '../../core/module-gate';
import {assertAssignedWorkPrincipalTx} from '../../core/approvals';
import {AssignedWorkPrincipalUnavailableError,type AssignedApprovalMetadata} from '../../lib/assigned-work';
type RawHeader={id:string|null;employmentId:string|null;personId:string|null;employee:string|null;createdAt:Date|string|null;total:number|null;callerCurrent:boolean|null};

function statement(ctx:SessionContext,companyIds:string[]|undefined,limit:number|undefined,bounded:boolean):SQL{
 const roles=ctx.roles??[],admin=roles.includes('super_admin')||roles.includes('hr_admin');
 // Both forms call the same native owner. The bounded experiment requires the frozen-body/PK proof.
 const header=bounded?sql`(SELECT * FROM app.delegated_approval_subject(request.employment_id,'claims','claims.claim') LIMIT 1)`
  :sql`app.delegated_approval_subject(request.employment_id,'claims','claims.claim')`;
 return sql`
   WITH caller AS MATERIALIZED (
    SELECT (app.principal_snapshot_current()
     AND (${ctx.personId??null}::uuid IS NULL OR app.is_self_person(${ctx.personId??null}::uuid))) AS ok
   ), candidates AS MATERIALIZED (
    SELECT request.id,request.employment_id,request.created_at,header.person_id,header.employee
    FROM public.claim_request request CROSS JOIN caller
    INNER JOIN LATERAL ${header} header ON true
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
   SELECT selected.id,selected.employment_id AS "employmentId",selected.person_id AS "personId",
    selected.employee,selected.created_at AS "createdAt",selected.total,caller.ok AS "callerCurrent"
   FROM caller LEFT JOIN LATERAL (
    SELECT eligible.*,count(*) OVER()::int AS total FROM eligible
    ORDER BY created_at DESC,id ${limit===undefined?sql``:sql`LIMIT ${limit}`}
   ) selected ON true ORDER BY selected.created_at DESC NULLS LAST,selected.id
  `;
}
async function withProbe<T>(supplied:SessionContext,companyIds:string[]|undefined,limit:number|undefined,bounded:boolean,read:(tx:Tx,query:SQL)=>Promise<T>){
 if(limit!==undefined&&(!Number.isSafeInteger(limit)||limit<1||limit>200))throw Error('Invalid private preview limit');
 const ctx:SessionContext={...supplied,roles:supplied.roles?.slice(),grants:supplied.grants?.map(grant=>({...grant})),agent:supplied.agent?{...supplied.agent}:undefined};
 const companies=companyIds?.slice();
 return withClaimsTenant(ctx,async tx=>{
  await assertAssignedWorkPrincipalTx(tx,ctx);
  return read(tx,statement(ctx,companies,limit,bounded));
 });
}
async function read(ctx:SessionContext,companyIds:string[]|undefined,limit:number|undefined,bounded:boolean){
 return withProbe(ctx,companyIds,limit,bounded,async(tx,query)=>{
  const rows=await tx.execute<RawHeader>(query);
  if(!rows.length)throw Error('Private caller-proof row is unavailable');
  if(rows[0].callerCurrent!==true)throw new AssignedWorkPrincipalUnavailableError();
  const items:AssignedApprovalMetadata[]=[];
  for(const row of rows){
   if(row.id===null)continue;
   if(row.employmentId===null||row.personId===null||row.createdAt===null)throw Error('Private header shape is unavailable');
   items.push({id:row.id,employmentId:row.employmentId,personId:row.personId,employee:row.employee,
    createdAt:row.createdAt instanceof Date?row.createdAt:claimRequest.createdAt.mapFromDriverValue(row.createdAt)});
  }
  return {items,total:rows[0].total??0};
 });
}
export function claimTaskStatementProbe(ctx:SessionContext,companyIds?:string[],limit?:number){return read(ctx,companyIds,limit,false);}
export function claimTaskBoundedHeaderProbe(ctx:SessionContext,companyIds?:string[],limit?:number){return read(ctx,companyIds,limit,true);}
export function explainClaimTaskProbe(ctx:SessionContext,companyIds:string[]|undefined,limit:number,mode:'reference'|'bounded'){
 return withProbe(ctx,companyIds,limit,mode==='bounded',async(tx,query)=>tx.execute(sql`EXPLAIN (FORMAT JSON,SETTINGS) ${query}`));
}
