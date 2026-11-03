/** Actual stored draft-author scope remains distinct from company administration. */
import {beforeAll,beforeEach,afterAll,it,expect} from 'vitest';
import {and,eq,sql} from 'drizzle-orm';
import {withTenant,type SessionContext} from '../db/client';
import * as s from '../db/schema';
import {employeeDraftCreateCompanies,getEmployeeDraft,saveEmployeeDraft} from '../core/employee-draft';
import {hireEmployee} from '../core/org';
import {publishActionCapabilityPackage,publishWorkforceActionPackage} from '../deploy/access/publish-workforce-capabilities';
import {pgSqlState} from '../lib/db-error';
import {adminCtx,closeAll,createAppUser,migrateTestDb,owner,resetDb,seedBase,type Base} from './harness';
let b:Base;
beforeAll(migrateTestDb);afterAll(closeAll);beforeEach(async()=>{await resetDb();b=await seedBase();});
it('preserves the actual author read after a scope move without granting another HR actor the draft',async()=>{
 const [other]=await owner.db.insert(s.company).values({tenantId:b.tenantId,legalName:'Fictional other draft company'}).returning({id:s.company.id});
 const [author]=await owner.db.insert(s.person).values({tenantId:b.tenantId,fullName:'Fictional draft author',primaryEmail:'draft-author@fixture.invalid'}).returning({id:s.person.id});
 const userId=await createAppUser(b.tenantId,author.id,'employee');
 await owner.db.insert(s.roleAssignment).values({tenantId:b.tenantId,appUserId:userId,role:'hr_admin',companyId:b.companyId});
 const native:SessionContext={...adminCtx(b),userId,personId:author.id,roles:['employee','hr_admin'],grants:[{role:'employee',companyId:null},{role:'hr_admin',companyId:b.companyId}]};
 expect(await employeeDraftCreateCompanies(native)).toEqual([b.companyId]);
 const saved=await saveEmployeeDraft(native,{currentStep:1,data:{profile:{fullName:'Fictional prospective hire'},employment:{companyId:b.companyId}}});
 expect(await getEmployeeDraft(native,saved.id)).toMatchObject({id:saved.id,companyId:b.companyId});
 await owner.db.update(s.roleAssignment).set({companyId:other.id}).where(and(eq(s.roleAssignment.appUserId,userId),eq(s.roleAssignment.role,'hr_admin')));
 const moved={...native,grants:[{role:'employee',companyId:null},{role:'hr_admin',companyId:other.id}]} satisfies SessionContext;
 expect(await getEmployeeDraft(moved,saved.id)).toMatchObject({id:saved.id,companyId:b.companyId,actions:{canEdit:true,canDiscard:true,canActivate:false}});
 expect(await employeeDraftCreateCompanies(moved)).toEqual([other.id]);
 const outsiderId=await createAppUser(b.tenantId,null,'employee');
 await owner.db.insert(s.roleAssignment).values({tenantId:b.tenantId,appUserId:outsiderId,role:'hr_admin',companyId:other.id});
 expect(await getEmployeeDraft({...moved,userId:outsiderId,personId:null},saved.id)).toBeNull();
 let denial:unknown;try{await withTenant(moved,tx=>tx.execute(sql`select app.workforce_draft_purpose_allowed(${b.companyId}::uuid,${author.id}::uuid,'view')`));}catch(error){denial=error;}
 expect(pgSqlState(denial)).toBe('42501');
 const [authority]=await owner.client`select app.workforce_draft_author_legacy_allowed(${b.tenantId}::uuid,${userId}::uuid,'function.workforceDrafts.author.view',null) as author,app.workforce_function_legacy_allowed(${b.tenantId}::uuid,${userId}::uuid,'function.workforceDrafts.view',${b.companyId}::uuid) as administers`;
 expect(authority).toEqual({author:true,administers:false});
});

it('publishes Drafts and applies Execute independently of Edit and ordinary new hire',async()=>{
 const ctx=adminCtx(b);
 await publishWorkforceActionPackage(owner.client);
 const draft=await saveEmployeeDraft(ctx,{currentStep:1,data:{profile:{fullName:'Fictional Execute subject'},employment:{companyId:b.companyId}}});
 const cap='function.workforceDrafts.execute';
 try{
  expect(await publishActionCapabilityPackage(owner.client,'workforce_drafts')).toMatchObject({changed:true,capabilities:9});
  expect(await publishActionCapabilityPackage(owner.client,'workforce_drafts')).toMatchObject({changed:false});
  expect(await getEmployeeDraft(ctx,draft.id)).toMatchObject({actions:{canEdit:true,canActivate:true}});
  await owner.client`insert into access_user_override(tenant_id,user_id,capability_id,company_id,effect)
   values(${b.tenantId}::uuid,${ctx.userId!}::uuid,${cap},${b.companyId}::uuid,'deny')`;
  expect(await getEmployeeDraft(ctx,draft.id)).toMatchObject({actions:{canEdit:true,canActivate:false}});
  const hire={person:{fullName:'Fictional native hire',primaryEmail:'draft-execute@fixture.invalid'},
   employeeCode:'DRAFT-EXECUTE',companyId:b.companyId,departmentId:b.deptA,employmentType:'full_time' as const,hiredOn:'2025-01-01'};
  let failure:unknown;
  try{await hireEmployee(ctx,{...hire,fromEmployeeDraftId:draft.id});}catch(error){failure=error;}
  expect(pgSqlState(failure)).toBe('42501');
  expect(await getEmployeeDraft(ctx,draft.id)).toMatchObject({id:draft.id});
  expect(await hireEmployee(ctx,hire)).toHaveProperty('employmentId');
 }finally{
  await owner.client`delete from app.access_native_capability_default where capability_id like 'function.workforceDrafts.%'`;
  await owner.client`update access_capability set supported=false,bindings='[]'::jsonb where id like 'function.workforceDrafts.%'`;
 }
});

it('matches native cent rounding for stored draft compensation, including binary midpoints',async()=>{
 const inputs=['3,000.129','1_0.126','1.005','2.675','-1.125','1e-3','0'];
 const rows=await owner.client<{value:string}[]>`select app.workforce_draft_money(raw)::text as value
  from unnest(${inputs}::text[]) with ordinality as input(raw,ordinal) order by ordinal`;
 expect(rows.map(row=>row.value)).toEqual(inputs.map(raw=>Number(raw.replace(/[,_]/g,'')).toFixed(2)));
});
