/** Actual current-caller source contracts for all20 module jobs. Authored UNRUN; no provider. */
import {randomUUID} from 'node:crypto';
import {and,eq,sql} from 'drizzle-orm';
import {afterAll,afterEach,beforeAll,beforeEach,describe,expect,it,vi} from 'vitest';
import * as tenantDb from '../db/client';
import type {SessionContext} from '../db/client';
import * as schema from '../db/schema';
import {loadCanonicalModuleJob,assertCanonicalModuleJobView} from '../core/workspace-module-jobs';
import {AGENT_MODULE_CODES} from '../lib/ai/module-agents';
import {isModuleEnabled} from '../core/entitlements';
import {MODULE_CATALOG} from '../packs/catalog';
import {hireEmployee} from '../core/org';
import {grantAssistant,revokeAssistant} from '../core/assistant-grant';
import {todayInKualaLumpur} from '../lib/hr-date';
import {adminCtx,closeAll,createAppUser,entitledCtx,migrateTestDb,owner,resetDb,seedBase,setModule,type Base} from './harness';
let base:Base;
beforeAll(migrateTestDb);afterAll(closeAll);afterEach(()=>{vi.restoreAllMocks();vi.unstubAllEnvs();});
beforeEach(async()=>{await resetDb();base=await seedBase();for(const module of MODULE_CATALOG.filter(row=>!row.isCore))await setModule(base.tenantId,module.code,'active');});
async function fixture(){const admin=adminCtx(base),hire=(name:string,companyId=base.companyId,departmentId=base.deptA)=>hireEmployee(admin,
 {person:{fullName:name,primaryEmail:randomUUID()+'@fixture.test'},companyId,departmentId,employmentType:'full_time',hiredOn:'2020-01-01'});
 const mine=await hire('Fictional Canonical Job Owner'),peer=await hire('PRIVATE_PEER_IDENTITY_SENTINEL');
 const [otherCompany]=await owner.db.insert(schema.company).values({tenantId:base.tenantId,legalName:'PRIVATE_OTHER_COMPANY_SENTINEL'}).returning({id:schema.company.id});
 const [otherDepartment]=await owner.db.insert(schema.department).values({tenantId:base.tenantId,companyId:otherCompany.id,name:'Other department'}).returning({id:schema.department.id});
 const foreign=await hire('PRIVATE_OTHER_COMPANY_PERSON_SENTINEL',otherCompany.id,otherDepartment.id);
 const userId=await createAppUser(base.tenantId,mine.personId,'hr_admin');await grantAssistant(admin,{appUserId:userId});
 const ctx:SessionContext={...await entitledCtx(base,['hr_admin']),userId,personId:mine.personId,roles:['hr_admin'],grants:[{role:'hr_admin',companyId:null}]};
 // Deliberately broad HR visibility, but Mine jobs still choose only the current person's employment.
 for(const employmentId of [mine.employmentId,peer.employmentId,foreign.employmentId]){
  await owner.db.insert(schema.notification).values({tenantId:base.tenantId,recipientEmploymentId:employmentId,kind:'fixture',title:'PRIVATE_NOTIFICATION_TITLE',body:'PRIVATE_NOTIFICATION_BODY',linkPath:'/private/embedded-link'});
  await owner.db.insert(schema.attendance).values({tenantId:base.tenantId,employmentId,attendanceDate:todayInKualaLumpur(),status:'present',workedMinutes:employmentId===mine.employmentId?471:9999});
 }
 const [cycle]=await owner.db.insert(schema.reviewCycle).values({tenantId:base.tenantId,name:'Canonical own review',periodStart:'2026-01-01',periodEnd:'2026-12-31',ratingScale:[]}).returning({id:schema.reviewCycle.id});
 await owner.db.insert(schema.performanceReview).values([{tenantId:base.tenantId,cycleId:cycle.id,employmentId:mine.employmentId,managerComments:'PRIVATE_MANAGER_FEEDBACK',overallRating:5},
  {tenantId:base.tenantId,cycleId:cycle.id,employmentId:peer.employmentId,managerComments:'PRIVATE_PEER_FEEDBACK',overallRating:1}]);
 return {admin,ctx,mine,peer,foreign};}
describe('actual canonical module-job carrier and independent authorization contracts',()=>{
 it.each(AGENT_MODULE_CODES)('%s uses one actual current-caller carrier and never emits peer/other-company facts or cached bodies',async module=>{
  const f=await fixture(),transactions=vi.spyOn(tenantDb,'withTenant');
  const view=await loadCanonicalModuleJob(f.ctx,{module});
  expect(view.state).toBe('ready');assertCanonicalModuleJobView(view,f.ctx);expect(transactions).toHaveBeenCalledTimes(1);
  const text=JSON.stringify(view);for(const marker of ['PRIVATE_PEER_','PRIVATE_OTHER_COMPANY_PERSON','PRIVATE_NOTIFICATION_','PRIVATE_MANAGER_FEEDBACK','/private/embedded-link','9999'])expect(text).not.toContain(marker);
  // Rewards/schema/case metadata are permitted administrative scopes, not an invented own-record claim.
  if(!['rewards','system_explorer','system_testing'].includes(module))expect(text).not.toContain('PRIVATE_OTHER_COMPANY_SENTINEL');
  const [runs]=await owner.db.execute<{n:number}>(sql`select count(*)::int as n from public.ai_model_run`);expect(runs.n).toBe(0);
 });
 it.each(AGENT_MODULE_CODES)('%s enforces current principal and its canonical core or optional module policy',async module=>{
  const f=await fixture();expect((await loadCanonicalModuleJob(f.ctx,{module,employmentId:f.peer.employmentId})).state).toBe('unavailable');
  expect((await loadCanonicalModuleJob({...f.ctx,personId:f.peer.personId},{module})).state).toBe('unavailable');
  expect((await loadCanonicalModuleJob({...f.ctx,tenantId:randomUUID()},{module})).state).toBe('unavailable');
  const catalogue=MODULE_CATALOG.find(row=>row.code===module)!;
  if(catalogue.isCore){
   expect(isModuleEnabled(await entitledCtx(base,['hr_admin']),module)).toBe(true);
   expect(await owner.db.select().from(schema.tenantModule).where(and(eq(schema.tenantModule.tenantId,base.tenantId),eq(schema.tenantModule.moduleCode,module)))).toEqual([]);
   const denied=await owner.db.insert(schema.tenantModule).values({tenantId:base.tenantId,moduleCode:module,status:'active'}).then(()=>null,(error:unknown)=>{
    const failure=error as {cause?:{message?:string};message?:string};return failure.cause?.message??failure.message;
   });expect(denied).toBe('core module '+module+' is always enabled and takes no tenant_module row');
   expect((await loadCanonicalModuleJob(f.ctx,{module})).state).toBe('ready');
   // Core cannot lapse through a tenant row; the distinct operator emergency kill still binds it.
   vi.stubEnv('MODULE_KILL',module);
  }else await setModule(base.tenantId,module,null);
  expect((await loadCanonicalModuleJob(f.ctx,{module})).state).toBe('unavailable');
 });
 it.each(AGENT_MODULE_CODES)('%s honors fresh Assistant grant revocation rather than a retained workspace offer',async module=>{
  const f=await fixture();expect((await loadCanonicalModuleJob(f.ctx,{module})).state).toBe('ready');
  await revokeAssistant(f.admin,{appUserId:f.ctx.userId!});expect((await loadCanonicalModuleJob(f.ctx,{module})).state).toBe('unavailable');
 });
 it('refuses copied/model-forged/cross-user renderer views and reads changed canonical facts without a shared cache',async()=>{
  const f=await fixture(),first=await loadCanonicalModuleJob(f.ctx,{module:'employees'});assertCanonicalModuleJobView(first,f.ctx);
  expect(()=>assertCanonicalModuleJobView(JSON.parse(JSON.stringify(first)),f.ctx)).toThrow();
  expect(()=>assertCanonicalModuleJobView(first,{...f.ctx,userId:randomUUID()})).toThrow();
  await owner.db.update(schema.employment).set({employeeCode:'FRESH-CANONICAL-CODE'}).where(eq(schema.employment.id,f.mine.employmentId));
  const second=await loadCanonicalModuleJob(f.ctx,{module:'employees'});expect(JSON.stringify(second)).toContain('FRESH-CANONICAL-CODE');
  expect(JSON.stringify(first)).not.toContain('FRESH-CANONICAL-CODE');
 });
});
