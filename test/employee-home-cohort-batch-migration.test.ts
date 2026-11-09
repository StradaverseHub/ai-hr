/** Reversible Home cohort proof batching. Native application-role readers; no deployment. */
import {randomUUID} from 'node:crypto';
import {readFileSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {performance} from 'node:perf_hooks';
import {sql} from 'drizzle-orm';
import {afterAll,beforeAll,expect,it} from 'vitest';
import {withTenant,type SessionContext} from '../db/client';
import * as schema from '../db/schema';
import {hireEmployee} from '../core/org';
import {saveEmployeeHomeConfiguration} from '../core/employee-home-configuration';
import {saveOwnHomePersonPrivacy} from '../core/employee-home-person-privacy';
import {defaultEmployeeHomeConfiguration} from '../lib/employee-home-defaults';
import {todayInKualaLumpur} from '../lib/hr-date';
import {addDaysIso} from '../lib/roster-month';
import {adminCtx,closeAll,createAppUser,migrateTestDb,owner,resetDb,seedBase} from './harness';
beforeAll(migrateTestDb);afterAll(closeAll);
it('compares chunked dated-company proof with scalar Home cohorts over more than one thousand peers',async()=>{
 await resetDb();const b=await seedBase(),foreign=await seedBase(),on=todayInKualaLumpur(),hiredOn=addDaysIso(on,-400);
 const viewer=await hireEmployee(adminCtx(b),{person:{fullName:'Fictional viewer',primaryEmail:randomUUID()+'@example.invalid'},companyId:b.companyId,departmentId:b.deptA,employmentType:'full_time',hiredOn});
 const ctx:SessionContext={tenantId:b.tenantId,userId:await createAppUser(b.tenantId,viewer.personId,'employee'),personId:viewer.personId,roles:['employee']};
 const peers=Array.from({length:1005},(_,i)=>({personId:randomUUID(),employmentId:randomUUID(),name:'Fictional peer '+String(i).padStart(4,'0')}));
 for(let offset=0;offset<peers.length;offset+=250){
  const part=peers.slice(offset,offset+250);
  await owner.db.insert(schema.person).values(part.map((p,i)=>({id:p.personId,tenantId:b.tenantId,fullName:p.name,primaryEmail:p.personId+'@example.invalid',dateOfBirth:offset+i<10?'2000-'+on.slice(5):null})));
  await owner.db.insert(schema.employment).values(part.map((p,i)=>({id:p.employmentId,tenantId:b.tenantId,personId:p.personId,companyId:b.companyId,hiredOn,employeeCode:'COHORT'+(offset+i)})));
  await owner.db.insert(schema.assignment).values(part.map(p=>({tenantId:b.tenantId,employmentId:p.employmentId,companyId:b.companyId,departmentId:b.deptA,employmentType:'full_time' as const,validFrom:hiredOn})));
 }
 // Concurrent employment of one peer must remain one person in the public pages.
 const concurrent=randomUUID();await owner.db.insert(schema.employment).values({id:concurrent,tenantId:b.tenantId,personId:peers[1].personId,companyId:b.companyId,hiredOn,employeeCode:'COHORT-CONCURRENT'});
 await owner.db.insert(schema.assignment).values({tenantId:b.tenantId,employmentId:concurrent,companyId:b.companyId,departmentId:b.deptA,employmentType:'full_time',validFrom:hiredOn});
 const privateUser=await createAppUser(b.tenantId,peers[0].personId,'employee');
 await saveOwnHomePersonPrivacy({tenantId:b.tenantId,userId:privateUser,personId:peers[0].personId,roles:['employee']},{expectedOrdinal:0,hideBirthday:true,hideAnniversary:true});
 await hireEmployee(adminCtx(foreign),{person:{fullName:'Fictional foreign peer',primaryEmail:randomUUID()+'@example.invalid'},companyId:foreign.companyId,departmentId:foreign.deptA,employmentType:'full_time',hiredOn});
 const configuration=defaultEmployeeHomeConfiguration();configuration.teamVisibility='department';configuration.celebrations={...configuration.celebrations,enabled:true,scope:'department'};
 await saveEmployeeHomeConfiguration(adminCtx(b),{companyId:b.companyId,audienceRole:'employee',expectedOrdinal:0,configuration,reason:'Fictional cohort performance comparison'});
 const [original]=await owner.client<{ddl:string;body:string;metadata:unknown}[]>`select pg_get_functiondef(p.oid) as ddl,prosrc as body,
  jsonb_build_object('owner',proowner,'acl',proacl,'securityDefiner',prosecdef,'volatility',provolatile,'config',proconfig,'arguments',proargnames) as metadata
  from pg_proc p where p.oid='app._home_peer_cohort(uuid,text)'::regprocedure`;
 const companion=async()=>owner.client`select pg_get_functiondef('app.proven_company_date_points(jsonb)'::regprocedure) as proof,
  pg_get_functiondef('app._home_peer_policy(uuid,text)'::regprocedure) as policy`;
 const originalCompanion=await companion();
 const legacySource=readFileSync('db/migrations/0584_employee_home_sharing.sql','utf8');
 const legacyStart=legacySource.indexOf('CREATE FUNCTION app._home_peer_cohort(');
 const legacy=legacySource.slice(legacyStart,legacySource.indexOf('$$;',legacyStart)+3).replace('CREATE FUNCTION','CREATE OR REPLACE FUNCTION');
 const migration=readFileSync('db/migrations/2137_home_peer_cohort_batch.sql','utf8').split('--> statement-breakpoint').map(s=>s.trim()).filter(Boolean);
 const candidate=original.ddl;
 const measure=async()=>withTenant(ctx,async tx=>{
  await tx.execute(sql`set transaction read only`);const start=performance.now();
  const [row]=await tx.execute<{team:{totalPeople:number;items:unknown[]};celebrations:{total:number;items:unknown[]}}>(sql`select
   app.home_team_page(${viewer.employmentId}::uuid,${on}::date,null,20) as team,
   app.home_celebration_page(${viewer.employmentId}::uuid,null,20) as celebrations`);
  expect(row.team.totalPeople).toBe(1005);expect(row.team.items).toHaveLength(20);expect(row.celebrations.total).toBe(9);
  expect(JSON.stringify(row)).not.toContain('Fictional foreign peer');
  return {elapsedMs:performance.now()-start,values:row};
 });
 const report:{kind:string;releaseEligible:boolean;phases:Record<string,unknown>;restored:boolean;benefitObserved?:boolean}={kind:'INSTALLED_HOME_COHORT_MIGRATION_COMPONENT_ONLY_NOT_500_USERS',releaseEligible:false,phases:{},restored:false};
 let expected:Awaited<ReturnType<typeof measure>>|undefined;
 try{
  const installed=await measure();
  await owner.client.unsafe(legacy);
  expected=await measure();report.phases.original={elapsedMs:expected.elapsedMs};
  for(const statement of migration)await owner.client.unsafe(statement);
  const [applied]=await owner.client<{ddl:string}[]>`select pg_get_functiondef('app._home_peer_cohort(uuid,text)'::regprocedure) as ddl`;
  expect(applied.ddl).toEqual(candidate);expect(installed.values).toEqual(expected.values);
  const [metadata]=await owner.client<{metadata:unknown;callable:boolean}[]>`select jsonb_build_object('owner',proowner,'acl',proacl,'securityDefiner',prosecdef,'volatility',provolatile,'config',proconfig,'arguments',proargnames) as metadata,
   has_function_privilege('ai_hr_app',p.oid,'EXECUTE') as callable from pg_proc p where p.oid='app._home_peer_cohort(uuid,text)'::regprocedure`;
  expect(metadata.metadata).toEqual(original.metadata);expect(metadata.callable).toBe(false);expect(await companion()).toEqual(originalCompanion);
  for(const phase of ['candidate','candidateWarm']){const result=await measure();expect(result.values).toEqual(expected.values);report.phases[phase]={elapsedMs:result.elapsedMs,exactPublicPages:true};}
 }finally{
  await owner.client.unsafe(original.ddl);const [restored]=await owner.client<{ddl:string}[]>`select pg_get_functiondef('app._home_peer_cohort(uuid,text)'::regprocedure) as ddl`;
  report.restored=restored.ddl===original.ddl;expect(report.restored).toBe(true);expect(await companion()).toEqual(originalCompanion);
  const result=await measure();if(expected)expect(result.values).toEqual(expected.values);report.phases.restored={elapsedMs:result.elapsedMs};
  const before=report.phases.original as {elapsedMs:number}|undefined,proposed=report.phases.candidate as {elapsedMs:number}|undefined;
  if(before&&proposed)report.benefitObserved=proposed.elapsedMs<before.elapsedMs*0.85;
  if(process.env.AIHR_FOCUSED_EVIDENCE_DIR)writeFileSync(join(process.env.AIHR_FOCUSED_EVIDENCE_DIR,'home-cohort-batch-plan.json'),JSON.stringify({...report,peers:1005,employmentRows:1006,proofChunkSize:1000,privateBirthdayOptOut:true,duplicatePersonMerged:true,ordinaryCompanyDateProofUnchanged:true},null,2));
 }
},180000);

it('refuses a drifted cohort body and leaves the installed function unchanged after rollback',async()=>{
 const [before]=await owner.client<{ddl:string;body:string}[]>`select pg_get_functiondef(p.oid) as ddl,prosrc as body from pg_proc p where p.oid='app._home_peer_cohort(uuid,text)'::regprocedure`;
 const precondition=readFileSync('db/migrations/2137_home_peer_cohort_batch.sql','utf8').split('--> statement-breakpoint')[0];
 const error=await owner.client.begin(async tx=>{
  await tx.unsafe(before.ddl.replace(before.body,before.body+'\n-- unreviewed predecessor probe\n'));
  await tx.unsafe(precondition);
 }).then(()=>null,error=>error);
 expect(error?.code).toBe('55000');
 const [after]=await owner.client<{ddl:string}[]>`select pg_get_functiondef('app._home_peer_cohort(uuid,text)'::regprocedure) as ddl`;
 expect(after.ddl).toBe(before.ddl);
});
