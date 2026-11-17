import {sql} from 'drizzle-orm';
import type {SessionContext} from '../db/client';
import {withPersonnelRead} from './personnel-read-bounds';
import {workforceChoiceInput,WorkforceChoiceAccessError,type WorkforceChoiceInput,type WorkforceChoicePage} from '../lib/workforce-choice';
/** Uses the exact thin native Workforce picker owner, not generic employment RLS or wide Workforce JSON.
 * Active means terminated_on IS NULL, including exclusion of future-dated departures, as before.
 * Undefined company scope means all native-visible companies; [] means none. */
export function readWorkforceChoices(ctx:SessionContext,input:WorkforceChoiceInput,companyIds?:readonly string[]):Promise<WorkforceChoicePage>{
 const p=workforceChoiceInput(input),captured=structuredClone(ctx),scope=companyIds?.slice();
 const narrowed=p.companyId?(scope===undefined||scope.some(id=>id.toLowerCase()===p.companyId!.toLowerCase())?[p.companyId]:[]):scope;
 const query=p.query?.trim()??'',pattern='%'+query.replace(/[\\%_]/g,c=>'\\'+c)+'%';
 return withPersonnelRead(captured,async tx=>{
  const [access]=await tx.execute<{allowed:boolean}>(sql`select app.access_workforce_employment(${p.subjectId}::uuid,'workforce.view') as allowed`);
  if(!access?.allowed)throw new WorkforceChoiceAccessError();
  const wanted=narrowed===undefined?sql`null::uuid[]`:sql`array[${sql.join(narrowed.map(id=>sql`${id}::uuid`),sql`, `)}]::uuid[]`;
  const selected=sql`array[${sql.join((p.selectedIds??[]).map(id=>sql`${id}::uuid`),sql`, `)}]::uuid[]`;
  const [page]=await tx.execute<WorkforceChoicePage>(sql`
   with population as materialized (
    select employment_id as "employmentId",name,employee_code as "employeeCode",company_id as "companyId"
    from app.access_workforce_picker_facts(${wanted})
    where terminated_on is null and employment_id<>${p.subjectId}::uuid
     and ${p.companyId?sql`company_id=${p.companyId}::uuid`:sql`true`}
   ), matched as materialized (select * from population where ${query?sql`name ilike ${pattern} or "employeeCode" ilike ${pattern} or "employmentId"::text ilike ${pattern}`:sql`true`}),
   page as (select * from matched order by name,"employmentId" limit 25 offset ${p.offset??0})
   select coalesce((select jsonb_agg(to_jsonb(page) order by name,"employmentId") from page),'[]'::jsonb) as rows,
    coalesce((select jsonb_agg(to_jsonb(population) order by name,"employmentId") from population where "employmentId"=any(${selected})),'[]'::jsonb) as selected,
    (select count(*)::int from matched) as total,${p.offset??0}::int as offset,25::int as limit`);
  return page;
 });
}
