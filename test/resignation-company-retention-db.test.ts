import {randomUUID} from 'node:crypto';
import {sql} from 'drizzle-orm';
import {beforeAll,beforeEach,afterAll,describe,it,expect} from 'vitest';
import {withTenant,type SessionContext} from '../db/client';
import {owner,migrateTestDb,resetDb,closeAll,seedBase,adminCtx,createAppUser,setModule,type Base} from './harness';
import {transferEmploymentCompanyTx} from '../core/org';
import {companyDeleteStatus} from '../core/read';
import {deleteCompany} from '../core/admin';
let b:Base,admin:SessionContext;
beforeAll(migrateTestDb);beforeEach(async()=>{await resetDb();b=await seedBase();admin=adminCtx(b);});afterAll(closeAll);
const retained=(ctx:SessionContext,id:string|null)=>withTenant(ctx,async tx=>{const [row]=await tx.execute<{used:boolean}>(sql`select app.resignation_company_in_use(${id}::uuid) as used`);return row.used;});
async function history(){
 const source=randomUUID(),destination=randomUUID(),department=randomUUID(),person=randomUUID(),employment=randomUUID(),request=randomUUID();
 await owner.db.execute(sql`insert into company(id,tenant_id,legal_name) values(${source}::uuid,${b.tenantId}::uuid,'Fictional retained resignation company'),(${destination}::uuid,${b.tenantId}::uuid,'Fictional destination company')`);
 await owner.db.execute(sql`insert into department(id,tenant_id,company_id,name) values(${department}::uuid,${b.tenantId}::uuid,${destination}::uuid,'Destination department')`);
 await owner.db.execute(sql`insert into person(id,tenant_id,full_name) values(${person}::uuid,${b.tenantId}::uuid,'Fictional historical resignation employee')`);
 // A pre-existing employment without an assignment leaves no source department/configuration to mask retention.
 await owner.db.execute(sql`insert into employment(id,tenant_id,person_id,company_id,hired_on) values(${employment}::uuid,${b.tenantId}::uuid,${person}::uuid,${source}::uuid,'2024-01-01')`);
 await setModule(b.tenantId,'lifecycle','disabled');
 await owner.db.execute(sql`insert into resignation_request(id,tenant_id,employment_id,person_id,last_working_day,status) values(${request}::uuid,${b.tenantId}::uuid,${employment}::uuid,${person}::uuid,'2026-10-31','withdrawn')`);
 const data={facts:{employmentId:employment,companyId:source,personId:person,employeeName:'Fictional historical resignation employee',basicSalary:null,currency:null},lastWorkingDay:'2026-10-31',offer:null,tasks:[],letters:[],waits:[],priorCases:[],comments:[]};
 await owner.db.execute(sql`insert into resignation_journey(tenant_id,id,employment_id,company_id,person_id,stage,data,submitted_on,closed_on) values(${b.tenantId}::uuid,${request}::uuid,${employment}::uuid,${source}::uuid,${person}::uuid,'retained',${JSON.stringify(data)}::jsonb,'2026-10-01','2026-10-15')`);
 await setModule(b.tenantId,'lifecycle','active');
 // The actual entity-transfer owner moves the current employment; the frozen journey keeps its original company.
 await withTenant(admin,tx=>transferEmploymentCompanyTx(tx,admin,{employmentId:employment,newCompanyId:destination,effectiveDate:'2026-11-01',placement:{departmentId:department},employmentType:'full_time',movement:{type:'entityTransfer',effectiveDate:'2026-11-01',groupId:randomUUID(),remarks:'Historical resignation retention fixture transfer'}}));
 return{source,destination,employment,request,data};
}
describe('company retention for custody-protected resignation history',()=>{
 it('blocks the public company deletion path after the employee moves, without exposing raw case rows, even with Lifecycle disabled',async()=>{
  const h=await history();
  const [current]=await owner.db.execute<{company:string}>(sql`select company_id as company from employment where id=${h.employment}::uuid`);expect(current.company).toBe(h.destination);
  const raw=await withTenant(admin,tx=>tx.execute(sql`select id,data from resignation_journey where company_id=${h.source}::uuid`));expect(raw).toEqual([]);
  expect(await retained(admin,h.source)).toBe(true);
  await setModule(b.tenantId,'lifecycle','disabled');expect(await retained(admin,h.source)).toBe(true);
  expect(await companyDeleteStatus(admin,h.source)).toEqual({canDelete:true,blockedBy:'other'});
  await expect(deleteCompany(admin,{id:h.source})).rejects.toMatchObject({name:'CompanyInUseError',reason:'other'});
  const [kept]=await owner.db.execute<{company:string;data:unknown}>(sql`select company_id as company,data from resignation_journey where tenant_id=${b.tenantId}::uuid and id=${h.request}::uuid`);expect(kept).toEqual({company:h.source,data:h.data});
  expect(await withTenant(admin,tx=>tx.execute(sql`select id from resignation_journey where id=${h.request}::uuid`))).toEqual([]);
 },90000);
 it('answers only fresh administrators of the current tenant company, without broadening custody permissions',async()=>{
  const h=await history(),scope=(companyId:string):SessionContext=>({...admin,grants:[{role:'hr_admin',companyId}]});
  expect(await retained(scope(h.source),h.source)).toBe(true);expect(await retained(scope(h.destination),h.source)).toBe(false);
  const employeeId=await createAppUser(b.tenantId,null,'employee'),employee={...admin,userId:employeeId,roles:['employee'],grants:[{role:'employee',companyId:null}]} as SessionContext;expect(await retained(employee,h.source)).toBe(false);
  const foreign=await seedBase();expect(await retained(adminCtx(foreign),h.source)).toBe(false);
  expect(await retained(admin,null)).toBe(false);expect(await retained(admin,randomUUID())).toBe(false);expect(await retained(admin,h.destination)).toBe(false);
  const [acl]=await owner.db.execute<{app:boolean;public:boolean;stable:boolean;definer:boolean}>(sql`select has_function_privilege('ai_hr_app',p.oid,'EXECUTE') as app,exists(select 1 from aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a where a.grantee=0 and a.privilege_type='EXECUTE') as public,p.provolatile='s' as stable,p.prosecdef as definer from pg_proc p where p.oid='app.resignation_company_in_use(uuid)'::regprocedure`);expect(acl).toEqual({app:true,public:false,stable:true,definer:true});
  await owner.db.execute(sql`update role_assignment set role='employee' where tenant_id=${b.tenantId}::uuid and app_user_id=${admin.userId}::uuid`);
  const [stale]=await withTenant(admin,tx=>tx.execute<{current:boolean;used:boolean}>(sql`select app.principal_snapshot_current() as current,app.resignation_company_in_use(${h.source}::uuid) as used`));expect(stale).toEqual({current:false,used:false});
 },90000);
});
