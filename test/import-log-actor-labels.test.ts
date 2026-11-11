/**
 * Board 8d02748a — readable "Imported by" on import logs (migration 9740, app.import_log_actor_facts).
 * Real database, real RLS, fictional people. The function must only label people recorded on log rows the
 * caller can already see, in one set-wise read, including importers outside a company-scoped viewer's scope.
 */
import {randomUUID,createHash} from 'node:crypto';
import {afterAll,beforeAll,beforeEach,describe,expect,it} from 'vitest';
import {eq,sql} from 'drizzle-orm';
import {withTenant,type SessionContext} from '../db/client';
import * as s from '../db/schema';
import {hireEmployee} from '../core/org';
import {resolveImportActors,creatorOf,IMPORT_ACTOR_ROW_LIMIT} from '../core/import-actor-label';
import {listIndividualImportJobs} from '../core/individual-import-job';
import {listClockingImportRuns} from '../core/attendance-clocking-import';
import {adminCtx,createAppUser,closeAll,migrateTestDb,owner,resetDb,seedBase,type Base} from './harness';

const content=Buffer.from('fictional workbook');
const hash=createHash('sha256').update(content).digest('hex');

describe('import log actor labels (8d02748a)',()=>{
 let b:Base,a:SessionContext,betaId:string,aisyahUser:string,aisyahPerson:string,bobUser:string,acmeOnly:SessionContext;
 async function job(createdBy:string,companyIds:string[],at='2026-11-05T02:42:00Z'){
  const id=randomUUID();
  await owner.db.execute(sql`insert into payroll_individual_import_job(id,tenant_id,created_by,company_ids,context,source_name,source_hash,source,method,created_at)
   values(${id}::uuid,${b.tenantId}::uuid,${createdBy}::uuid,${JSON.stringify(companyIds)}::jsonb,'{}'::jsonb,'Nov-2026-overtime.xlsx',${hash},${content},'monthly',${at}::timestamptz)`);
  return id;
 }
 const actors=(ctx:SessionContext,log:Parameters<typeof resolveImportActors>[1],ids:string[])=>withTenant(ctx,tx=>resolveImportActors(tx,log,ids));
 beforeAll(migrateTestDb);
 beforeEach(async()=>{
  await resetDb();b=await seedBase();a=adminCtx(b);
  const[beta]=await owner.db.insert(s.company).values({tenantId:b.tenantId,legalName:'Beta Fictional Bhd',registrationNo:'202001000077'}).returning();betaId=beta.id;
  const[betaDept]=await owner.db.insert(s.department).values({tenantId:b.tenantId,companyId:betaId,name:'Beta Finance'}).returning();
  // Aisyah: two concurrent coded employments (ACME and Beta), one login.
  const acme=await hireEmployee(a,{person:{fullName:'Aisyah Rahman',primaryEmail:'aisyah@example.test'},companyId:b.companyId,departmentId:b.deptA,employmentType:'full_time',hiredOn:'2024-01-01',employeeCode:'EMP-0412'});
  aisyahPerson=acme.personId;
  await hireEmployee(a,{person:{id:aisyahPerson},companyId:betaId,departmentId:betaDept.id,employmentType:'full_time',hiredOn:'2025-01-01',employeeCode:'BETA-0077'});
  aisyahUser=await createAppUser(b.tenantId,aisyahPerson,'hr_admin');
  // Bob: employed only in Beta (outside an ACME-scoped viewer's personnel scope), group administrator.
  const bob=await hireEmployee(a,{person:{fullName:'Bob Tan',primaryEmail:'bob@example.test'},companyId:betaId,departmentId:betaDept.id,employmentType:'full_time',hiredOn:'2023-03-01',employeeCode:'BETA-0009'});
  bobUser=await createAppUser(b.tenantId,bob.personId,'hr_admin');
  const[p]=await owner.db.insert(s.person).values({tenantId:b.tenantId,fullName:'Scoped Acme Admin',primaryEmail:'acme-admin@example.test'}).returning();
  const scopedUser=await createAppUser(b.tenantId,p.id,'hr_admin');
  await owner.db.update(s.roleAssignment).set({companyId:b.companyId}).where(eq(s.roleAssignment.appUserId,scopedUser));
  acmeOnly={...a,userId:scopedUser,personId:p.id,grants:[{role:'hr_admin',companyId:b.companyId}]} as SessionContext;
 });
 afterAll(closeAll);

 it('labels creators with the Employee ID held in the import company on the import date, in one call',async()=>{
  const beta=await job(aisyahUser,[betaId]),acme=await job(aisyahUser,[b.companyId]),admin=await job(b.adminUserId,[b.companyId]);
  const result=await actors(a,'payroll_individual_job',[beta,acme,admin]);
  expect(creatorOf(result,acme)).toEqual({kind:'person',name:'Aisyah Rahman',employeeCode:'EMP-0412'});
  expect(creatorOf(result,beta)).toEqual({kind:'person',name:'Aisyah Rahman',employeeCode:'BETA-0077'});
  const [login]=await owner.db.select({workos:s.appUser.workosUserId}).from(s.appUser).where(eq(s.appUser.id,b.adminUserId));
  expect(creatorOf(result,admin)).toEqual({kind:'unlinked',loginSuffix:login.workos.slice(-6)});
  // The page reader carries the same label on every row.
  const rows=await listIndividualImportJobs(a,[b.companyId,betaId]);
  expect(Object.fromEntries(rows.map(row=>[row.id,row.created_by_actor]))).toEqual({
   [beta]:{kind:'person',name:'Aisyah Rahman',employeeCode:'BETA-0077'},[acme]:{kind:'person',name:'Aisyah Rahman',employeeCode:'EMP-0412'},[admin]:{kind:'unlinked',loginSuffix:login.workos.slice(-6)}});
 });

 it('keeps the Employee ID held on the day of the import after the person has left',async()=>{
  const before=await job(bobUser,[betaId],'2026-01-10T03:00:00Z');
  await owner.db.update(s.employment).set({terminatedOn:'2026-06-30'}).where(eq(s.employment.employeeCode,'BETA-0009'));
  const[bob]=await owner.db.select({personId:s.appUser.personId}).from(s.appUser).where(eq(s.appUser.id,bobUser));
  const[betaDept]=await owner.db.select({id:s.department.id}).from(s.department).where(eq(s.department.companyId,betaId));
  // Rehired later under a new Employee ID: the import still shows the ID held on its own date.
  await hireEmployee(a,{person:{id:bob.personId!},companyId:betaId,departmentId:betaDept.id,employmentType:'full_time',hiredOn:'2026-09-01',employeeCode:'BETA-0100'});
  expect(creatorOf(await actors(a,'payroll_individual_job',[before]),before)).toEqual({kind:'person',name:'Bob Tan',employeeCode:'BETA-0009'});
 });

 it('shows a company-scoped viewer the importer of a row they can see, even when the importer is outside their scope',async()=>{
  const visible=await job(bobUser,[b.companyId]),hidden=await job(bobUser,[betaId]);
  // Under the viewer's own RLS, Bob's person row is not readable at all.
  const direct=await withTenant(acmeOnly,tx=>tx.select({id:s.person.id}).from(s.person).where(eq(s.person.fullName,'Bob Tan')));
  expect(direct).toEqual([]);
  const result=await actors(acmeOnly,'payroll_individual_job',[visible,hidden]);
  expect(creatorOf(result,visible)).toEqual({kind:'person',name:'Bob Tan',employeeCode:'BETA-0009'});
  expect(result.has(hidden)).toBe(false);
 });

 it('returns nothing for another tenant, for rows that do not exist, and for an unknown log kind',async()=>{
  const id=await job(aisyahUser,[b.companyId]);
  const other=await seedBase();
  expect((await actors(adminCtx(other),'payroll_individual_job',[id])).size).toBe(0);
  expect((await actors(a,'payroll_individual_job',[randomUUID()])).size).toBe(0);
  const [raw]=await withTenant(a,tx=>tx.execute<{n:number}>(sql`select count(*)::int as n from app.import_log_actor_facts('employee_directory',${`{${id}}`}::uuid[])`));
  expect(raw.n).toBe(0);
  // An employee (not an administrator) sees no labels even for a real row.
  expect((await actors({...a,roles:['employee']},'payroll_individual_job',[id])).size).toBe(0);
 });

 it('refuses unbounded requests instead of scanning',async()=>{
  const many=Array.from({length:IMPORT_ACTOR_ROW_LIMIT+1},()=>randomUUID());
  await expect(actors(a,'payroll_individual_job',many)).rejects.toThrow(/bounded/);
  const [raw]=await withTenant(a,tx=>tx.execute<{n:number}>(sql`select count(*)::int as n from app.import_log_actor_facts('payroll_individual_job',${`{${many.join(',')}}`}::uuid[])`));
  expect(raw.n).toBe(0);
 });

 it('labels person-keyed logs (attendance, leave) and marks a missing login as unavailable',async()=>{
  const[named]=await owner.db.insert(s.clockingImportRun).values({tenantId:b.tenantId,mappingName:'AIHR Standard Template',fileName:'clock-nov.csv',createdByPersonId:aisyahPerson,createdByUserId:aisyahUser}).returning({id:s.clockingImportRun.id});
  const[gone]=await owner.db.insert(s.clockingImportRun).values({tenantId:b.tenantId,mappingName:'AIHR Standard Template',fileName:'clock-old.csv',createdByPersonId:null,createdByUserId:'not-a-login'}).returning({id:s.clockingImportRun.id});
  const runs=await listClockingImportRuns(a);
  const byId=Object.fromEntries(runs.map(run=>[run.id,run.actor]));
  expect(byId[named.id]).toEqual({kind:'person',name:'Aisyah Rahman',employeeCode:'EMP-0412'});
  expect(byId[gone.id]).toEqual({kind:'unavailable'});
 });

 it('grants EXECUTE only to the application role and pins search_path',async()=>{
  const [fn]=await owner.db.execute<{definer:boolean;config:string[]|null;public_exec:boolean;app_exec:boolean}>(sql`
   select p.prosecdef as definer,p.proconfig as config,
    has_function_privilege('public','app.import_log_actor_facts(text,uuid[])','EXECUTE') as public_exec,
    has_function_privilege('ai_hr_app','app.import_log_actor_facts(text,uuid[])','EXECUTE') as app_exec
   from pg_proc p where p.oid='app.import_log_actor_facts(text,uuid[])'::regprocedure`);
  expect(fn).toMatchObject({definer:true,public_exec:false,app_exec:true});
  expect(fn.config?.join(',')).toContain('search_path=pg_catalog,public,pg_temp');
 });
});
