/** Installed predicate: canonical provided-grant oracle plus actual principal/row visibility. */
import {randomUUID} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {sql} from 'drizzle-orm';
import {afterAll,beforeAll,expect,it} from 'vitest';
import {withTenant,type SessionContext} from '../db/client';
import {hireEmployee} from '../core/org';
import {pgSqlState} from '../lib/db-error';
import {adminCtx,closeAll,createAppUser,migrateTestDb,owner,resetDb,seedBase} from './harness';
beforeAll(migrateTestDb);afterAll(closeAll);
it('preserves canonical role/group/subtree and malformed-input results',async()=>{
 await resetDb();const b=await seedBase(),other=await seedBase(),ctx=adminCtx(b),child=randomUUID();
 await owner.client`insert into company(id,tenant_id,legal_name,country,parent_company_id) values(${child},${b.tenantId},'Fictional grant child','MY',${b.companyId})`;
 const grants:unknown[]=[null,[],[{role:'employee',companyId:null}],[{role:'manager',companyId:b.companyId}],
  [{role:'hr_admin',companyId:null}],[{role:'hr_admin',companyId:b.companyId}],[{role:'hr_admin',companyId:child}],
  [{role:'super_admin',companyId:child}],[{role:'payroll_partner',companyId:null}],
  [{role:'employee',companyId:null},{role:'hr_admin',companyId:other.companyId}],{},'invalid-json-shape',
  [{role:'employee',companyId:'invalid-company'}],[{role:'hr_admin',companyId:'invalid-company'}],
  [{role:'hr_admin',companyId:''}],[{role:null,companyId:null}]];
 const targets=[b.companyId,child,other.companyId,randomUUID(),null];
 for(const value of grants)for(const company of targets){
  const argument=value===null?sql`null::jsonb`:sql`${JSON.stringify(value)}::jsonb`;
  const evaluate=(canonical:boolean)=>withTenant(ctx,async tx=>{
   await tx.execute(sql`set transaction read only`);
   const expression=canonical?sql`app.grants_have_role_for(${argument},'hr_admin',${company}::uuid) or app.grants_have_role_for(${argument},'super_admin',${company}::uuid)`
    :sql`app.grants_admin_for(${argument},${company}::uuid)`;
   const [row]=await tx.execute<{allowed:boolean}>(sql`select ${expression} as allowed`);return {allowed:row.allowed};
  }).catch(error=>({error:pgSqlState(error)??'unknown'}));
  expect(await evaluate(false)).toEqual(await evaluate(true));
 }
});
it('retains actual employee/manager/company-HR/group-HR row boundaries',async()=>{
 await resetDb();const b=await seedBase(),foreign=await seedBase(),group=adminCtx(b),child=randomUUID(),sibling=randomUUID();
 await owner.client`insert into company(id,tenant_id,legal_name,country,parent_company_id) values
  (${child},${b.tenantId},'Fictional grant child','MY',${b.companyId}),(${sibling},${b.tenantId},'Fictional grant sibling','MY',null)`;
 const hire=(ctx:SessionContext,companyId:string,name:string)=>hireEmployee(ctx,{person:{fullName:name,primaryEmail:randomUUID()+'@example.invalid'},companyId,employmentType:'full_time',hiredOn:'2020-01-01'});
 const manager=await hire(group,b.companyId,'Fictional manager'),report=await hire(group,child,'Fictional report'),employee=await hire(group,sibling,'Fictional employee'),outside=await hire(adminCtx(foreign),foreign.companyId,'Fictional foreign');
 const managerUser=await createAppUser(b.tenantId,manager.personId,'manager'),employeeUser=await createAppUser(b.tenantId,employee.personId,'employee'),hrUser=await createAppUser(b.tenantId,null,'hr_admin');
 await owner.client`update role_assignment set company_id=${b.companyId} where tenant_id=${b.tenantId} and app_user_id=${hrUser}`;
 await owner.client`insert into reporting_line(tenant_id,subordinate_employment_id,manager_employment_id,line_type,valid_from)
  values(${b.tenantId},${report.employmentId},${manager.employmentId},'administrative','2020-01-01')`;
 const contexts:[SessionContext,string[]][]=[
  [group,[manager.employmentId,report.employmentId,employee.employmentId]],
  [{tenantId:b.tenantId,userId:hrUser,roles:['hr_admin'],grants:[{role:'hr_admin',companyId:b.companyId}]},[manager.employmentId,report.employmentId]],
  [{tenantId:b.tenantId,userId:managerUser,personId:manager.personId,roles:['manager']},[manager.employmentId,report.employmentId]],
  [{tenantId:b.tenantId,userId:employeeUser,personId:employee.personId,roles:['employee']},[employee.employmentId]],
 ];
 for(const [ctx,expected]of contexts){
  const rows=await withTenant(ctx,async tx=>{
   await tx.execute(sql`set transaction read only`);const [principal]=await tx.execute<{current:boolean}>(sql`select app.principal_snapshot_current() as current`);expect(principal.current).toBe(true);
   return tx.execute<{id:string}>(sql`select id from employment where id in(${manager.employmentId}::uuid,${report.employmentId}::uuid,${employee.employmentId}::uuid,${outside.employmentId}::uuid) and app.can_see_employment(id) order by id`);
  });expect(rows.map(row=>row.id)).toEqual(expected.sort());
 }
});
it('refuses an unreviewed predecessor and rolls its probe back without changing the installed function',async()=>{
 const [before]=await owner.client<{ddl:string;secdef:boolean;volatility:string;config:unknown}[]>`select pg_get_functiondef(p.oid) as ddl,prosecdef as secdef,provolatile as volatility,proconfig as config from pg_proc p where p.oid='app.grants_admin_for(jsonb,uuid)'::regprocedure`;
 expect(before.secdef).toBe(false);expect(before.volatility).toBe('s');expect(before.config).toBe(null);
 const precondition=readFileSync('db/migrations/2136_grant_admin_role_precheck.sql','utf8').split('--> statement-breakpoint')[0];
 const error=await owner.client.begin(async tx=>{
  await tx.unsafe('create or replace function app.grants_admin_for(grants jsonb,wanted_company uuid) returns boolean language sql stable as $$select false$$');
  await tx.unsafe(precondition);
 }).then(()=>null,error=>error);
 expect(pgSqlState(error)).toBe('55000');
 const [after]=await owner.client<{ddl:string}[]>`select pg_get_functiondef('app.grants_admin_for(jsonb,uuid)'::regprocedure) as ddl`;
 expect(after.ddl).toBe(before.ddl);
});
