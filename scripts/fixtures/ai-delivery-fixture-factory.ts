/** Import-safe fictional native fixture composition. No CLI, coordinator, DB reset/migration,
 * provider configuration or transport. The runtime parent/harness owns an admitted disposable DB.
 * Canonical business owners create facts; direct inserts below are identity fixtures only. */
import {randomUUID} from 'node:crypto';
import {and,asc,eq} from 'drizzle-orm';
import {withTenant,type createDb,type SessionContext} from '../../db/client';
import * as s from '../../db/schema';
import {MODULE_CATALOG,missingModuleDependencies} from '../../packs/catalog';
import {provisionTenant} from '../../db/provision';
import {createDepartment,assignRole} from '../../core/admin';
import {hireEmployee} from '../../core/org';
import {resolveEntitlementsTx,isModuleEnabled} from '../../core/entitlements';
import {grantAssistant,assertMayUseAssistant} from '../../core/assistant-grant';
import {assertAiPrincipalTx} from '../../core/ai-principal';
import {todayInKualaLumpur} from '../../lib/hr-date';
import type {AiDeliveryFixtureActor,AiDeliveryFixtureContext} from './ai-delivery-fixture-context';
/** Tests retain the actual nested native/SQL cause and phase; user-facing CLI owners must bound it. */
export async function aiDeliveryFixturePhase<T>(phase:string,run:()=>Promise<T>):Promise<T>{try{return await run();}catch(cause){throw new Error('AI delivery native fixture phase: '+phase,{cause});}}
export async function createAiDeliveryFixtureContext(owner:ReturnType<typeof createDb>):Promise<AiDeliveryFixtureContext>{
 const modules=MODULE_CATALOG.filter(module=>!module.isCore).map(module=>module.code);
 if(missingModuleDependencies(modules).length)throw Error('Full native module catalogue dependency closure is incomplete.');
 const token=randomUUID(),today=todayInKualaLumpur(),year=Number(today.slice(0,4)),hiredOn=String(year-1)+'-01-01';
 const made=await aiDeliveryFixturePhase('provisionTenant all native noncore modules',()=>owner.db.transaction(tx=>provisionTenant(tx,{name:'Fictional full AI browser '+token,adminEmail:'ai-browser-bootstrap-'+token+'@example.test',country:'MY',modules,baseUrl:'http://127.0.0.1:3177'})));
 // Provisioning deliberately leaves the first HR grant to single-use invitation activation.
 // Exercise that native owner with a fictional legacy subject; this is not verified OIDC evidence.
 await aiDeliveryFixturePhase('native bootstrap invitation activation',async()=>{
  const token=new URL(made.activationUrl).pathname.split('/invite/')[1];
  if(!token)throw Error('Provisioned bootstrap activation token is missing.');
  const rows=await owner.client<{app_user_id:string;tenant_id:string}[]>`select app_user_id,tenant_id from app.consume_invitation(${token},${'ai-browser-bootstrap:'+randomUUID()})`;
  if(rows.length!==1||rows[0].app_user_id!==made.appUserId||rows[0].tenant_id!==made.tenantId)throw Error('Native bootstrap activation binding differs.');
 });
 async function context(userId:string,personId:string):Promise<SessionContext>{
  const [identity]=await owner.db.select({personId:s.appUser.personId,tenantId:s.appUser.tenantId,archivedAt:s.appUser.archivedAt}).from(s.appUser).where(eq(s.appUser.id,userId));
  if(identity?.tenantId!==made.tenantId||identity.personId!==personId||identity.archivedAt!==null)throw Error('Actual fixture login/person binding differs.');
  const grants=await owner.db.select({role:s.roleAssignment.role,companyId:s.roleAssignment.companyId}).from(s.roleAssignment).where(and(eq(s.roleAssignment.tenantId,made.tenantId),eq(s.roleAssignment.appUserId,userId))).orderBy(asc(s.roleAssignment.id));
  const ctx:SessionContext={tenantId:made.tenantId,userId,personId,grants,roles:[...new Set(grants.map(grant=>grant.role))],entitlements:await owner.db.transaction(tx=>resolveEntitlementsTx(tx,made.tenantId))};
  await withTenant(ctx,tx=>assertAiPrincipalTx(tx,ctx));return ctx;
 }
 let bootstrapCtx=await aiDeliveryFixturePhase('actual provisioned bootstrap principal',()=>context(made.appUserId,made.personId));
 await aiDeliveryFixturePhase('bootstrap Assistant grant',()=>grantAssistant(bootstrapCtx,{appUserId:made.appUserId}));
 const department=await aiDeliveryFixturePhase('canonical department',()=>createDepartment(bootstrapCtx,{companyId:made.companyId,name:'Fictional full AI browser department'}));
 async function actor(key:string,roles:readonly('hr_admin'|'payroll_partner'|'manager'|'employee')[]):Promise<AiDeliveryFixtureActor>{
  const hired=await aiDeliveryFixturePhase('canonical hire '+key,()=>hireEmployee(bootstrapCtx,{person:{fullName:'Fictional AI Browser '+key,primaryEmail:'ai-browser-'+key+'-'+token+'@example.test'},employeeCode:'AIF-'+key.toUpperCase(),companyId:made.companyId,departmentId:department.id,employmentType:'full_time',hiredOn}));
  // Local selected-cookie identity fixture, not a production SSO assertion or activation credential.
  const [login]=await aiDeliveryFixturePhase('actual identity '+key,()=>owner.db.insert(s.appUser).values({tenantId:made.tenantId,personId:hired.personId,workosUserId:'ai-browser:'+key+':'+token,onboardedAt:new Date()}).returning({id:s.appUser.id}));
  for(const role of roles)await aiDeliveryFixturePhase('actual role '+key+':'+role,()=>assignRole(bootstrapCtx,{appUserId:login.id,role,...(role==='payroll_partner'||key==='manager'&&role==='hr_admin'?{companyId:made.companyId}:{})}));
  await aiDeliveryFixturePhase('Assistant grant '+key,()=>grantAssistant(bootstrapCtx,{appUserId:login.id}));
  const ctx=await aiDeliveryFixturePhase('current principal '+key,()=>context(login.id,hired.personId));
  if(ctx.grants?.some(grant=>grant.role==='super_admin')||ctx.roles?.length!==roles.length||roles.some(role=>!ctx.roles?.includes(role)))throw Error('Actual fixture grants differ from the explicit role plan.');
  await withTenant(ctx,tx=>assertMayUseAssistant(ctx,tx));
  return{userId:login.id,personId:hired.personId,employmentId:hired.employmentId,ctx};
 }
 const operator=await actor('operator',['hr_admin','payroll_partner']),self=await actor('self',['employee']),r1=await actor('reviewer1',['hr_admin','payroll_partner']),r2=await actor('reviewer2',['hr_admin','payroll_partner']),peer=await actor('peer',['employee']),manager=await actor('manager',['manager','hr_admin']);
 bootstrapCtx=await context(made.appUserId,made.personId);
 const actualModules=await owner.db.select({code:s.tenantModule.moduleCode}).from(s.tenantModule).where(eq(s.tenantModule.tenantId,made.tenantId));
 if(actualModules.length!==modules.length||actualModules.some(row=>!modules.includes(row.code)))throw Error('Provisioned module rows differ; never insert core module rows to repair this.');
 for(const entry of MODULE_CATALOG)if(!isModuleEnabled(bootstrapCtx,entry.code))throw Error('Actual provisioned entitlement is unavailable: '+entry.code);
 return{owner,tenantId:made.tenantId,companyId:made.companyId,departmentId:department.id,today,period:today.slice(0,7),bootstrapCtx,actors:{operator,self,reviewers:[r1,r2],peer,manager}};
}
