/** Fictional native application data, called only after actual hybrid admission. */
import assert from 'node:assert/strict';
import {randomBytes,randomUUID} from 'node:crypto';
import {generateSecret} from 'otplib';
import {seedBase,entitledCtx,owner,closeAll} from '../harness';
import * as s from '../../db/schema';
import {hireEmployee} from '../../core/org';
import {createBatch,generatePayslips,closeBatch} from '../../packs/payroll/service';
import {MODULE_CATALOG} from '../../packs/catalog';
import {passwordHash,digest} from '../../lib/internal-auth/crypto';
import {writeRecord} from '../../lib/internal-auth/record-store';
import {internalIssuer} from '../../lib/internal-auth/config';
import {todayInKualaLumpur} from '../../lib/hr-date';
import {performanceFixtureCalendar} from '../../scripts/performance/fixture-workload.mjs';

export type NativeNextActor={index:number;tenant:number;role:'groupHR'|'companyHR'|'employee';name:string;
 userId:string;personId:string;employmentId:string;companyId:string;tenantId:string;organization:string;
 username:string;password:string;secret:string;employeeCode:string};

export async function seedNativeNextFixture(){
 assert.equal(process.env.GITHUB_ACTIONS,'true');assert.equal(process.env.GITHUB_JOB,'native-test');
 assert.equal(process.env.AUTH_PROVIDER,'internal');assert.equal(process.env.AUDIT_HASH_CHAIN_ENABLED,'true');
 // The caller has derived these exact capabilities through canonical workerDb.
 for(const [key,user]of [['DATABASE_URL','ai_hr_app'],['TEST_DATABASE_URL','ai_hr_app'],
  ['MIGRATION_DATABASE_URL','postgres'],['TEST_MIGRATION_DATABASE_URL','postgres']]as const){
  const url=new URL(process.env[key]!);assert.equal(url.hostname,'127.0.0.1');assert.equal(url.port,'5433');
  assert.equal(url.pathname,'/ai_hr_test_w1');assert.equal(url.username,user);assert.equal(url.search,'');assert.equal(url.hash,'');
 }
 const today=todayInKualaLumpur(),{historicalMonth}=performanceFixtureCalendar(today);
 const actors:NativeNextActor[]=[],tenants:{tenantId:string;companies:string[];historicalBatches:string[]}[]=[];
 try{
  for(let tenant=0;tenant<2;tenant++){
   const b=await seedBase(),organization=tenant?'native-b':'native-a';
   await owner.db.insert(s.tenantModule).values(MODULE_CATALOG.filter(m=>!m.isCore&&m.packBacked)
    .map((m):typeof s.tenantModule.$inferInsert=>({tenantId:b.tenantId,moduleCode:m.code,status:'active'}))).onConflictDoNothing();
   const ctx=await entitledCtx(b),org={code:organization,tenantId:b.tenantId,name:'Fictional native organization '+tenant};
   await writeRecord(owner.client,'org:'+organization,org,null);await writeRecord(owner.client,'tenant:'+b.tenantId,org,null);
   const [secondCompany]=await owner.db.insert(s.company).values({tenantId:b.tenantId,legalName:'Fictional native second company '+tenant,country:'MY'}).returning();
   const [secondDepartment]=await owner.db.insert(s.department).values({tenantId:b.tenantId,companyId:secondCompany.id,name:'Fictional native second department'}).returning();
   const companies=[{id:b.companyId,departmentId:b.deptA},{id:secondCompany.id,departmentId:secondDepartment.id}];
   const historicalBatches:string[]=[];
   for(let position=0;position<4;position++){
    const index=tenant*4+position,company=companies[Math.floor(position/2)],role=position===0?'groupHR':position===2?'companyHR':'employee';
    const name=`Native 测试 Person ${index}`,employeeCode='NATIVE'+String(index).padStart(4,'0');
    const hired=await hireEmployee(ctx,{person:{fullName:name,primaryEmail:`native${index}@example.invalid`},
     companyId:company.id,departmentId:company.departmentId,employmentType:'full_time',hiredOn:'2025-01-01',employeeCode});
    const userId=randomUUID(),subject=randomUUID(),version=randomUUID(),secret=generateSecret();
    const username='native'+index,password='Fictional-'+randomBytes(24).toString('hex');
    await owner.db.insert(s.appUser).values({id:userId,tenantId:b.tenantId,personId:hired.personId,workosUserId:'native_'+userId});
    const grants:(typeof s.roleAssignment.$inferInsert)[]=[{tenantId:b.tenantId,appUserId:userId,role:'employee',companyId:company.id}];
    if(role!=='employee')grants.push({tenantId:b.tenantId,appUserId:userId,role:'hr_admin',companyId:role==='groupHR'?null:company.id});
    await owner.db.insert(s.roleAssignment).values(grants);
    const issuer=internalIssuer(b.tenantId);
    await owner.client`insert into app_external_identity(issuer,subject,app_user_id)values(${issuer},${subject},${userId}::uuid)`;
    const credential={subject,version,tenantId:b.tenantId,issuer,organization,username,email:`native${index}@example.invalid`,
     emailVerified:true,enabled:true,password:await passwordHash(password),mustChange:false,totpSecret:secret,lastStep:-1,recoveryHashes:[]};
    await owner.client.begin(async tx=>{
     await writeRecord(tx,'credential:'+subject,credential,subject);
     await writeRecord(tx,'login:'+digest(organization+'\0'+username),{subject},subject);
    });
    await owner.db.insert(s.compensation).values({tenantId:b.tenantId,employmentId:hired.employmentId,basicSalary:'5000',validFrom:'2025-01-01'});
    actors.push({index,tenant,role,name,userId,personId:hired.personId,employmentId:hired.employmentId,
     companyId:company.id,tenantId:b.tenantId,organization,username,password,secret,employeeCode});
   }
   for(const company of companies){
    const {batchId}=await createBatch(ctx,{companyId:company.id,payPeriod:historicalMonth});
    await generatePayslips(ctx,{batchId});await closeBatch(ctx,{batchId});historicalBatches.push(batchId);
   }
   tenants.push({tenantId:b.tenantId,companies:companies.map(company=>company.id),historicalBatches});
  }
  const [counts]=await owner.client`select (select count(*)::integer from employment where tenant_id=any(${tenants.map(t=>t.tenantId)}::uuid[]))as employments,
   (select count(*)::integer from payslip where tenant_id=any(${tenants.map(t=>t.tenantId)}::uuid[]))as payslips`;
  assert.deepEqual(counts,{employments:8,payslips:8});
  assert.equal(actors.length,8);assert.equal(new Set(actors.map(actor=>actor.personId)).size,8);
  const [transportFacts]=await owner.client`select
   (select count(*)::integer from app_internal_auth_record where record_key like 'session:%')as sessions,
   ((select count(*)::integer from ai_provider_config)+(select count(*)::integer from ai_provider_candidate))as providers`;
  assert.deepEqual(transportFacts,{sessions:0,providers:0});
  const grants=await owner.client`select app_user_id,role,company_id from role_assignment
   where app_user_id=any(${actors.map(actor=>actor.userId)}::uuid[]) order by app_user_id,role,company_id`;
  for(const actor of actors){
   const actual=grants.filter(grant=>grant.app_user_id===actor.userId);
   assert.equal(actual.length,actor.role==='employee'?1:2);
   assert.deepEqual(actual.find(grant=>grant.role==='employee'),{app_user_id:actor.userId,role:'employee',company_id:actor.companyId});
   if(actor.role!=='employee')assert.deepEqual(actual.find(grant=>grant.role==='hr_admin'),
    {app_user_id:actor.userId,role:'hr_admin',company_id:actor.role==='groupHR'?null:actor.companyId});
  }
  return {version:1,kind:'FICTIONAL_NATIVE_NEXT_SMOKE_ONLY',today,historicalMonth,actors,tenants,counts,
   preissuedSessions:transportFacts.sessions,providersConfigured:transportFacts.providers};
 }finally{
  // Seed/fixture pools do not remain live alongside the web budget or browser oracle.
  await closeAll();
 }
}
