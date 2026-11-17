import {sql,eq} from 'drizzle-orm';
import {withTenant,type SessionContext} from '../db/client';
import {exactEmployeeChoiceMatches} from './employee-choice';
import {employeeDraft} from '../db/schema';
import {isAdmin} from '../lib/authz-model';
import {workforceChoiceInput,WorkforceChoiceAccessError,WorkforceChoiceInputError,type WorkforceChoiceInput,type WorkforceChoicePage,type WorkforceChoice} from '../lib/workforce-choice';
export function draftManagerChoices(ctx:SessionContext,companyIds:readonly string[],input:WorkforceChoiceInput,signal?:AbortSignal):Promise<WorkforceChoicePage>{
 const p=workforceChoiceInput(input),scope=companyIds.slice();
 if(p.companyId!==undefined)throw new WorkforceChoiceInputError();
 if(!isAdmin(ctx))throw new WorkforceChoiceAccessError();
 const q=(p.query?.trim()??'').toLowerCase();
 return withTenant(ctx,async tx=>{
  signal?.throwIfAborted();
  const [draft]=await tx.select({id:employeeDraft.id}).from(employeeDraft).where(eq(employeeDraft.id,p.subjectId)).limit(1);
  signal?.throwIfAborted();
  if(!draft)throw new WorkforceChoiceAccessError();
  const population=sql`select e.id as "employmentId",p.full_name as name,e.employee_code as "employeeCode",e.company_id as "companyId"
   from employment e join person p on p.id=e.person_id where e.terminated_on is null
    and ${scope.length?sql`e.company_id=any(${'{'+scope.join(',')+'}'}::uuid[])`:sql`true`}`;
  if(q){
   // Native ASCII candidates plus a streamed Unicode fringe preserve the old Combobox's
   // ECMAScript lower/includes contract without retaining the complete directory.
   const label=sql`case when coalesce(e.employee_code,'')='' then p.full_name else e.employee_code||' – '||p.full_name end`;
   const ascii=/^[ -~–]*$/.test(q),candidate=q.includes('\0')?sql`false`:sql`(p.full_name collate "C") ~ '[^ -~]' or (coalesce(e.employee_code,'') collate "C") ~ '[^ -~]'
    or ${ascii?sql`position(${q} in translate(${label},'ABCDEFGHIJKLMNOPQRSTUVWXYZ','abcdefghijklmnopqrstuvwxyz'))>0 or position(${q} in e.id::text)>0`:sql`false`}`;
   const matched=await exactEmployeeChoiceMatches(tx,sql`${population} and (${candidate}) order by p.full_name,e.id`,q,p.offset??0,25,signal,
    row=>(row.employeeCode?`${row.employeeCode} – ${row.name}`:row.name).toLowerCase().includes(q)||row.employmentId.includes(q));
   const selected=await tx.execute<WorkforceChoice>(sql`${population} and e.id=any(${'{'+(p.selectedIds??[]).join(',')+'}'}::uuid[]) order by p.full_name,e.id`);
   signal?.throwIfAborted();
   const rows=matched.rows.length?await tx.execute<WorkforceChoice>(sql`${population} and e.id=any(${'{'+matched.rows.map(row=>row.employmentId).join(',')+'}'}::uuid[]) order by p.full_name,e.id`):[];
   signal?.throwIfAborted();
   return {rows:[...rows],selected:[...selected],total:matched.total,offset:p.offset??0,limit:25};
  }
  const [page]=await tx.execute<WorkforceChoicePage>(sql`
   with population as materialized (${population}),page as (select * from population order by name,"employmentId" limit 25 offset ${p.offset??0})
   select coalesce((select jsonb_agg(to_jsonb(page) order by name,"employmentId") from page),'[]'::jsonb) rows,
    coalesce((select jsonb_agg(to_jsonb(population) order by name,"employmentId") from population where "employmentId"=any(${'{'+(p.selectedIds??[]).join(',')+'}'}::uuid[])),'[]'::jsonb) selected,
    (select count(*)::int from population) total,${p.offset??0}::int as "offset",25::int as "limit"`);
  signal?.throwIfAborted();
  return page;
 },{readOnlySnapshot:true,readSignal:signal});
}
