import {sql} from 'drizzle-orm';
import {afterAll,beforeAll,expect,it} from 'vitest';
import {withTenant,type SessionContext} from '../../db/client';
import {decidedStatusCounts} from '../../core/approvals-summary';
import {listPendingClaimsPage} from '../../packs/claims/service';
import {adminCtx,closeAll,createAppUser,migrateTestDb,owner,resetDb,seedBase,setModule} from '../harness';

beforeAll(migrateTestDb);
afterAll(closeAll);

async function previousClaimCounts(ctx:SessionContext){
  const rows=await withTenant(ctx,tx=>tx.execute<{status:string;count:number}>(sql`
    select status,count(*)::int as count from claim_request group by status`));
  const counts=new Map(rows.map(row=>[row.status,row.count]));
  return {
    approved:(counts.get('approved')??0)+(counts.get('paid')??0),
    rejected:counts.get('rejected')??0,
    cancelled:counts.get('cancelled')??0,
  };
}

it('preserves the decided totals without counting the much larger pending claim queue',async()=>{
  await resetDb();
  const base=await seedBase();
  await setModule(base.tenantId,'claims','active');
  const [type]=await owner.client<{id:string}[]>`
    insert into claim_type(tenant_id,code,name) values(${base.tenantId}::uuid,'SCOPE','Fictional scale claim') returning id`;
  const companies=await owner.client<{id:string}[]>`
    insert into company(tenant_id,legal_name)
    select ${base.tenantId}::uuid,'Fictional claims company '||n from generate_series(1,71)n returning id`;
  const ids=[base.companyId,...companies.map(company=>company.id)];
  const staff=await owner.client<{id:string;person_id:string;company_id:string}[]>`
    with people as (
      insert into person(tenant_id,full_name,primary_email)
      select ${base.tenantId}::uuid,'Fictional claims employee '||n,'approval-scale-'||n||'@example.invalid'
      from generate_series(1,1152)n returning id
    )
    insert into employment(tenant_id,person_id,company_id,hired_on)
    select ${base.tenantId}::uuid,p.id,c.id,'2024-01-01'::date
    from (select id,row_number() over(order by id)n from people)p
    join unnest(${ids}::uuid[]) with ordinality c(id,n) on c.n=1+(p.n-1)%72
    returning id,person_id,company_id`;
  expect(staff).toHaveLength(1152);
  expect(new Set(staff.map(row=>row.company_id))).toEqual(new Set(ids));
  await owner.client`
    insert into claim_request(tenant_id,employment_id,claim_type_id,amount,incurred_on,status)
    select e.tenant_id,e.id,${type.id}::uuid,1,'2026-08-10',
     case when n<=200 then 'pending'::claim_status else
      (array['approved','paid','rejected','cancelled','draft']::claim_status[])[n-200] end
    from employment e cross join generate_series(1,205)n
    where e.tenant_id=${base.tenantId}::uuid`;
  await owner.client`analyze claim_request`;
  const [companyPerson,managerPerson,...reports]=staff.filter(row=>row.company_id===base.companyId);
  const [companyUser,managerUser]=await Promise.all([
    createAppUser(base.tenantId,companyPerson.person_id,'hr_admin'),
    createAppUser(base.tenantId,managerPerson.person_id,'manager'),
  ]);
  await owner.client`update role_assignment set company_id=${base.companyId}::uuid
    where app_user_id in (${companyUser}::uuid,${managerUser}::uuid)`;
  await owner.client`insert into reporting_line(tenant_id,subordinate_employment_id,manager_employment_id,line_type,valid_from)
    select ${base.tenantId}::uuid,id,${managerPerson.id}::uuid,'administrative','2024-01-01'
    from unnest(${reports.slice(0,2).map(row=>row.id)}::uuid[]) r(id)`;
  const group={...adminCtx(base),grants:[{role:'hr_admin',companyId:null}]};
  const scope=[base.companyId];
  const company={...group,userId:companyUser,personId:companyPerson.person_id,grants:[{role:'hr_admin',companyId:base.companyId}]};
  const manager={...group,userId:managerUser,personId:managerPerson.person_id,roles:['manager'],grants:[{role:'manager',companyId:base.companyId}]};
  for(const [label,actor,employees] of [['group',group,1152],['company',company,16],['manager',manager,3]] as const){
    const started=performance.now();
    const before=await previousClaimCounts(actor);
    const previousMs=Math.round(performance.now()-started);
    const next=performance.now();
    const after=await decidedStatusCounts(actor,[...scope],'claim');
    const filteredMs=Math.round(performance.now()-next);
    expect(before).toEqual({approved:2*employees,rejected:employees,cancelled:employees});
    expect(after).toEqual(before);
    // Independent direct RLS read in this fixture with no delegates or legacy claim types.
    const expected=await withTenant(actor,tx=>tx.execute<{id:string}>(sql`
      select id from claim_request where status='pending'
      order by date_trunc('milliseconds',created_at) desc,id limit 25`),{readOnlySnapshot:true});
    const pageStarted=performance.now();
    const page=await listPendingClaimsPage(actor);
    console.info('Approvals pending claim page',{label,elapsedMs:Math.round(performance.now()-pageStarted)});
    expect(page.page.total).toBe(employees*200);
    expect(page.rows.map(row=>row.id)).toEqual(Array.from(expected,row=>row.id));
    console.info('Approvals decided claim comparison',{label,previousMs,filteredMs});
  }
},90000);
