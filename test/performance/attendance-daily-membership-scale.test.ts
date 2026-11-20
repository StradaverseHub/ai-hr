import {sql} from 'drizzle-orm';
import {afterAll,beforeAll,expect,it} from 'vitest';
import {withTenant} from '../../db/client';
import {attendanceForDatePage} from '../../packs/attendance/service';
import {adminCtx,closeAll,migrateTestDb,owner,resetDb,seedBase,setModule} from '../harness';

beforeAll(migrateTestDb);
afterAll(closeAll);

it('preserves Daily Attendance pages through the previous assignment join at group scale',async()=>{
 await resetDb();
 const base=await seedBase();
 await setModule(base.tenantId,'attendance','active');
 const companies=await owner.client<{id:string}[]>`
  insert into company(tenant_id,legal_name)
  select ${base.tenantId}::uuid,'Fictional attendance company '||n from generate_series(1,71)n returning id`;
 const companyIds=[base.companyId,...companies.map(row=>row.id)];
 const employments=await owner.client<{id:string;company_id:string}[]>`
  with people as (
   insert into person(tenant_id,full_name,primary_email)
   select ${base.tenantId}::uuid,'Fictional attendance employee '||n,'daily-membership-'||n||'@example.invalid'
   from generate_series(1,1152)n returning id
  )
  insert into employment(tenant_id,person_id,company_id,employee_code,hired_on)
  select ${base.tenantId}::uuid,p.id,c.id,'DAILY-'||lpad(p.n::text,4,'0'),'2024-01-01'
  from (select id,row_number() over(order by id)n from people)p
  join unnest(${companyIds}::uuid[]) with ordinality c(id,n) on c.n=1+(p.n-1)%72
  returning id,company_id`;
 expect(employments).toHaveLength(1152);
 const stock=employments.filter(row=>row.company_id===base.companyId).map(row=>row.id);
 expect(stock).toHaveLength(16);
 const placed=stock.slice(0,8);
 await owner.client`
  insert into assignment(tenant_id,employment_id,company_id,department_id,employment_type,valid_from)
  select ${base.tenantId}::uuid,id,${base.companyId}::uuid,${base.deptA}::uuid,'full_time','2024-01-01'
  from unnest(${placed}::uuid[]) input(id)`;
 const ctx={...adminCtx(base),grants:[{role:'hr_admin',companyId:null}]};
 const limit=15,offset=1;
 for(const [label,scope,departmentId,total] of [
  ['group',companyIds,undefined,1152],
  ['company',[base.companyId],undefined,16],
  ['department',[base.companyId],base.deptA,8],
 ] as const){
  const previous=await withTenant(ctx,async tx=>{
   const source=sql`from employment e join person p on p.id=e.person_id
    left join assignment a on a.employment_id=e.id and a.valid_to is null and a.superseded_at is null
    where e.terminated_on is null and e.company_id=any(string_to_array(${scope.join(',')}::text,',')::uuid[])
     and p.full_name ilike '%Fictional attendance employee%'
    ${departmentId?sql`and a.department_id=${departmentId}::uuid`:sql``}`;
   const [count]=await tx.execute<{total:number}>(sql`select count(distinct e.id)::int as total ${source}`);
   const rows=await tx.execute<{id:string}>(sql`select e.id ${source}
    group by e.id,e.employee_code,p.full_name order by e.employee_code asc nulls last,p.full_name,e.id
    limit ${limit} offset ${offset}`);
   return {total:count.total,ids:Array.from(rows,row=>row.id)};
  },{readOnlySnapshot:true});
  expect(previous.total).toBe(total);
  const page=await attendanceForDatePage(ctx,'2026-08-10',[...scope],{limit,offset,departmentId,q:'Fictional attendance employee'});
  expect({total:page.total,ids:page.rows.map(row=>row.employmentId)}).toEqual(previous);
 }
},90000);
