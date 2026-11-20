import {afterAll,beforeAll,expect,it,vi} from 'vitest';
import {assistantBrowserConversationScope} from '../../app/assistant/conversation-scope';
import {allowedCompanies} from '../../core/read';
import type {SessionContext} from '../../db/client';
import {companyContextForPage,getScopeIds} from '../../lib/scope';
import {adminCtx,closeAll,createAppUser,migrateTestDb,owner,resetDb,seedBase} from '../harness';

const selection=vi.hoisted(()=>({value:''}));
vi.mock('next/headers',()=>({cookies:async()=>({get:()=>({value:selection.value})})}));
beforeAll(migrateTestDb);
afterAll(closeAll);

it('preserves Assistant company scope and the shell selection order at group scale',async()=>{
 await resetDb();
 const base=await seedBase();
 const companies=await owner.client<{id:string}[]>`
  insert into company(tenant_id,legal_name)
  select ${base.tenantId}::uuid,'Fictional assistant company '||n from generate_series(1,71)n returning id`;
 const companyIds=[base.companyId,...companies.map(company=>company.id)];
 const [representative]=await owner.client<{person_id:string;total:number}[]>`
  with people as (
   insert into person(tenant_id,full_name,primary_email)
   select ${base.tenantId}::uuid,'Fictional assistant employee '||n,'assistant-scope-'||n||'@example.invalid'
   from generate_series(1,1152)n returning id
  ), staff as (
   insert into employment(tenant_id,person_id,company_id,hired_on)
   select ${base.tenantId}::uuid,p.id,c.id,'2024-01-01'
   from (select id,row_number() over(order by id)n from people)p
   join unnest(${companyIds}::uuid[]) with ordinality c(id,n) on c.n=1+(p.n-1)%72
   returning person_id,company_id
  )
  select person_id,(select count(*)::int from staff) as total
  from staff where company_id=${base.companyId}::uuid order by person_id limit 1`;
 expect(representative.total).toBe(1152);
 const group:SessionContext={...adminCtx(base),grants:[{role:'hr_admin',companyId:null}]};
 const companyUserId=await createAppUser(base.tenantId,null,'hr_admin');
 await owner.client`
  update role_assignment set company_id=${base.companyId}::uuid where app_user_id=${companyUserId}::uuid`;
 const company:SessionContext={...group,userId:companyUserId,grants:[{role:'hr_admin',companyId:base.companyId}]};
 const employeeUserId=await createAppUser(base.tenantId,representative.person_id,'employee');
 const employee:SessionContext={...group,userId:employeeUserId,roles:['employee'],personId:representative.person_id,
  grants:[{role:'employee',companyId:null}]};
 const [first,second]=[...companies.map(row=>row.id)].sort();
 for(const [session,cookie,expected] of [
  [group,'',companyIds],
  [group,[second,first].join(','),[second,first]],
  [company,[second,base.companyId].join(','),[base.companyId]],
  [employee,second,[base.companyId]],
 ] as const){
  selection.value=cookie;
  const previous=(await getScopeIds((await allowedCompanies(session)).map(row=>row.id))).sort();
  expect(previous).toEqual([...expected].sort());
  const shell=await companyContextForPage(session);
  const shellOrder=[...shell.scopeIds];
  expect(await assistantBrowserConversationScope(session)).toBe(JSON.stringify(previous));
  expect(shell.scopeIds).toEqual(shellOrder);
  if(session===group&&cookie)expect(shell.scopeIds).toEqual(expected);
 }
},90000);
