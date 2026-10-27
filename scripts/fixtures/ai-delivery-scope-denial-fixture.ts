/** Import-safe PRIVATE denial prerequisites, not browser/authentication/security proof.
 * Parent owns an admitted disposable target. Native business owners create every company, hire,
 * entitlement and request. The sole direct insertion is the existing selected-cookie USER identity
 * fixture seam; it asserts no external identity, verified mailbox, cookie or production session.
 * Partial failure preserves facts for diagnosis; never reset, retry or clean from this helper. */
import {randomUUID} from 'node:crypto';
import {and,count,eq} from 'drizzle-orm';
import {client,withTenant,type Grant,type SessionContext} from '../../db/client';
import * as s from '../../db/schema';
import {createCompany,createDepartment,assignRole,setLeaveTypeRules} from '../../core/admin';
import {hireEmployee} from '../../core/org';
import {grantAssistant,assertMayUseAssistant} from '../../core/assistant-grant';
import {assertAiPrincipalTx} from '../../core/ai-principal';
import {resolveEntitlementsTx} from '../../core/entitlements';
import {createEntitlementTemplate,setLeaveTypeDefaultTemplate} from '../../core/entitlement-template';
import {openLeaveYear,requestLeave} from '../../packs/leave/service';
import {readOwnLeaveCandidateTx} from '../../core/assistant-actions/own-leave-candidate';
import {readOwnLeaveSubmissionReferenceTx} from '../../core/read';
import {todayInKualaLumpur} from '../../lib/hr-date';
import {createAiDeliveryFixtureContext} from './ai-delivery-fixture-factory';
import type {AiDeliveryFixtureActor,AiDeliveryFixtureContext} from './ai-delivery-fixture-context';
export type AiDeliveryScopeDenialSelection=Readonly<{annualTypeId:string;selfLeave:Readonly<{date:string;humanText:Readonly<{reason:string;employeeRemark:string}>}>}>;
const fail=():never=>{throw Error('Fictional scope prerequisites unavailable; preserve the owned target for private diagnosis.');};
function requireFact(value:unknown):asserts value{if(!value)fail();}
const reference=(actor:AiDeliveryFixtureActor)=>({userId:actor.userId,personId:actor.personId,employmentId:actor.employmentId});
export async function populateAiDeliveryScopeDenials(context:AiDeliveryFixtureContext,input:AiDeliveryScopeDenialSelection){
 const selected=structuredClone(input),c={...context,bootstrapCtx:{...context.bootstrapCtx,roles:context.bootstrapCtx.roles?.slice(),grants:context.bootstrapCtx.grants?.map(g=>({...g}))},actors:{...context.actors,self:{...context.actors.self,ctx:{...context.actors.self.ctx,roles:context.actors.self.ctx.roles?.slice(),grants:context.actors.self.ctx.grants?.map(g=>({...g}))}}}};
 requireFact(c.today===todayInKualaLumpur()&&c.period===c.today.slice(0,7)&&c.bootstrapCtx.tenantId===c.tenantId&&c.actors.self.ctx.userId===c.actors.self.userId&&c.actors.self.ctx.personId===c.actors.self.personId);
 const year=Number(c.today.slice(0,4)),hiredOn=String(year-1)+'-01-01',token=randomUUID();
 const [annual]=await c.owner.db.select({id:s.leaveType.id,code:s.leaveType.code,template:s.leaveType.defaultTemplateLineageId}).from(s.leaveType).where(and(eq(s.leaveType.tenantId,c.tenantId),eq(s.leaveType.id,selected.annualTypeId))).limit(1);
 requireFact(annual?.code==='ANNUAL'&&annual.template!==null);
 async function counters(tenantId:string,employmentId?:string){
  const [requests]=await c.owner.db.select({n:count()}).from(s.leaveRequest).where(and(eq(s.leaveRequest.tenantId,tenantId),employmentId?eq(s.leaveRequest.employmentId,employmentId):undefined));
  const [events]=await c.owner.db.select({n:count()}).from(s.domainEvent).where(and(eq(s.domainEvent.tenantId,tenantId),eq(s.domainEvent.eventType,'leave-request.submitted'),employmentId?eq(s.domainEvent.subjectEmploymentId,employmentId):undefined));
  return{requests:requests.n,submittedEvents:events.n};
 }
 async function candidate(actor:AiDeliveryFixtureActor,typeId:string,date:string,humanText:{reason:string;employeeRemark:string}){
  const result=await withTenant(actor.ctx,tx=>readOwnLeaveCandidateTx(tx,actor.ctx,{action:'leave.apply',contractVersion:1,employmentId:actor.employmentId,leaveTypeId:typeId,date,durationType:'full_day'},{employmentId:actor.employmentId,leaveTypeId:typeId},humanText,'en'));
  requireFact(result.kind==='candidate'&&result.candidate.deductionDays===1&&result.candidate.availableBalance!==null&&Number.isFinite(result.candidate.availableBalance)&&result.candidate.availableBalance>=1);
  if(result.kind!=='candidate')return fail();
  return{date:result.candidate.nomination.date,availableBalance:result.candidate.availableBalance,estimatedAvailableAfter:result.candidate.estimatedAvailableAfter,deductionDays:result.candidate.deductionDays};
 }
 const before={tenant:await counters(c.tenantId),self:await counters(c.tenantId,c.actors.self.employmentId),review:await candidate(c.actors.self,annual.id,selected.selfLeave.date,selected.selfLeave.humanText)};
 requireFact(before.self.requests===0&&before.self.submittedEvents===0);
 async function currentActor(tenantId:string,userId:string,personId:string,employmentId:string):Promise<AiDeliveryFixtureActor>{
  const rows=await client<{tenant_id:string;person_id:string|null;grants:Grant[]|null}[]>`select tenant_id,person_id,grants from app.principal(${userId}::uuid)`;
  requireFact(rows.length===1&&rows[0].tenant_id===tenantId&&rows[0].person_id===personId&&Array.isArray(rows[0].grants));
  const grants=rows[0].grants!.map(g=>({...g}));requireFact(grants.length===1&&grants[0].role==='employee'&&grants[0].companyId===null);
  const ctx:SessionContext={tenantId,userId,personId,grants,roles:grants.map(g=>g.role),entitlements:await c.owner.db.transaction(tx=>resolveEntitlementsTx(tx,tenantId))};
  await withTenant(ctx,async tx=>{await assertAiPrincipalTx(tx,ctx);await assertMayUseAssistant(ctx,tx);});
  const [actual]=await c.owner.db.select({personId:s.employment.personId,tenantId:s.employment.tenantId}).from(s.employment).where(eq(s.employment.id,employmentId));requireFact(actual?.personId===personId&&actual.tenantId===tenantId);
  return{userId,personId,employmentId,ctx};
 }
 async function hireLogin(key:string,companyId:string,departmentId:string){
  const hired=await hireEmployee(c.bootstrapCtx,{person:{fullName:'Fictional denial '+key,primaryEmail:'ai-denial-'+key+'-'+token+'@example.test'},companyId,departmentId,employmentType:'full_time',hiredOn});
  // Identity fixture ONLY, identical to the maintained full fixture factory. No business rows or
  // external identity claims are written here; real role/grant owners adjudicate the new login.
  const [login]=await c.owner.db.insert(s.appUser).values({tenantId:c.tenantId,personId:hired.personId,workosUserId:'ai-denial:'+key+':'+token,onboardedAt:new Date()}).returning({id:s.appUser.id});
  await assignRole(c.bootstrapCtx,{appUserId:login.id,role:'employee'});await grantAssistant(c.bootstrapCtx,{appUserId:login.id});
  return currentActor(c.tenantId,login.id,hired.personId,hired.employmentId);
 }
 const otherCompany=await createCompany(c.bootstrapCtx,{legalName:'Fictional separate denial company '+token,country:'MY',currency:'MYR'}),otherDepartment=await createDepartment(c.bootstrapCtx,{companyId:otherCompany.id,name:'Fictional separate denial department'});
 const sameTenant=await hireLogin('other-company',otherCompany.id,otherDepartment.id),revocable=await hireLogin('revocable',c.companyId,c.departmentId);
 const opened=await openLeaveYear(c.bootstrapCtx,{year,leaveTypeIds:[annual.id],employmentIds:[sameTenant.employmentId,revocable.employmentId]});requireFact(opened.packBlocked.length===0);
 // Reuse native provisioning+single-use activation; no second installer, synthetic tenant row or
 // provider delivery. Its extra bootstrap actors are native prerequisites, not browser observations.
 const foreign=await createAiDeliveryFixtureContext(c.owner),foreignActor=foreign.actors.self;
 requireFact(foreign.tenantId!==c.tenantId&&foreignActor.personId!==c.actors.self.personId);
 const [foreignAnnual]=await c.owner.db.select({id:s.leaveType.id}).from(s.leaveType).where(and(eq(s.leaveType.tenantId,foreign.tenantId),eq(s.leaveType.code,'ANNUAL'))).limit(1);requireFact(foreignAnnual);
 const template=await createEntitlementTemplate(foreign.bootstrapCtx,{leaveTypeId:foreignAnnual.id,name:'Fictional foreign denial annual',validFrom:String(year)+'-01-01',serviceBands:[{fromYears:0,toYears:null,days:20,carryForwardDays:0,maxBalanceDays:20}]});
 await setLeaveTypeDefaultTemplate(foreign.bootstrapCtx,{leaveTypeId:foreignAnnual.id,templateLineageId:template.lineageId});await setLeaveTypeRules(foreign.bootstrapCtx,{id:foreignAnnual.id,accrualMethod:'lump_sum'});
 const foreignOpened=await openLeaveYear(foreign.bootstrapCtx,{year,leaveTypeIds:[foreignAnnual.id],employmentIds:[foreignActor.employmentId]});requireFact(foreignOpened.packBlocked.length===0);
 async function suitable(actor:AiDeliveryFixtureActor,typeId:string,label:string){
  const humanText={reason:'Fictional human '+label+' leave',employeeRemark:'Fictional explicit '+label+' remark'},date=new Date(c.today+'T12:00:00Z');
  for(let n=0;n<31;n++){date.setUTCDate(date.getUTCDate()+1);const value=date.toISOString().slice(0,10);const result=await withTenant(actor.ctx,tx=>readOwnLeaveCandidateTx(tx,actor.ctx,{action:'leave.apply',contractVersion:1,employmentId:actor.employmentId,leaveTypeId:typeId,date:value,durationType:'full_day'},{employmentId:actor.employmentId,leaveTypeId:typeId},humanText,'en'));if(result.kind==='candidate'&&result.candidate.deductionDays===1&&result.candidate.availableBalance!==null&&Number.isFinite(result.candidate.availableBalance)&&result.candidate.availableBalance>=1)return{date:value,humanText};}return fail();
 }
 async function requested(actor:AiDeliveryFixtureActor,typeId:string,label:string){
  const human=await suitable(actor,typeId,label),native=await requestLeave(actor.ctx,{employmentId:actor.employmentId,leaveTypeId:typeId,startDate:human.date,endDate:human.date,durationType:'full_day',...human.humanText});requireFact(native.days===1);
  // Ordinary requestLeave deliberately returns no receipt event ID. Read the real native event as
  // its actual original actor, then reconcile through the maintained minimal own-reference owner.
  const events=await withTenant(actor.ctx,tx=>tx.select({id:s.domainEvent.id}).from(s.domainEvent).where(and(eq(s.domainEvent.tenantId,actor.ctx.tenantId),eq(s.domainEvent.aggregateType,'leave-request'),eq(s.domainEvent.aggregateId,native.leaveRequestId),eq(s.domainEvent.eventType,'leave-request.submitted'),eq(s.domainEvent.actorType,'user'),eq(s.domainEvent.actorId,actor.userId),eq(s.domainEvent.subjectEmploymentId,actor.employmentId))));requireFact(events.length===1);
  const reference=await withTenant(actor.ctx,tx=>readOwnLeaveSubmissionReferenceTx(tx,actor.ctx,native.leaveRequestId,events[0].id));requireFact(reference?.request.employmentId===actor.employmentId&&reference.event.actorId===actor.userId);
  const [row]=await c.owner.db.select({id:s.leaveRequest.id,status:s.leaveRequest.status,employmentId:s.leaveRequest.employmentId}).from(s.leaveRequest).where(and(eq(s.leaveRequest.tenantId,actor.ctx.tenantId),eq(s.leaveRequest.id,native.leaveRequestId)));requireFact(row?.status==='pending'&&row.employmentId===actor.employmentId);
  return{leaveTypeId:typeId,...human,requestId:native.leaveRequestId,submittedEventId:events[0].id,status:row.status};
 }

 const otherRequest=await requested(sameTenant,annual.id,'other-company'),foreignRequest=await requested(foreignActor,foreignAnnual.id,'foreign-tenant'),revocableHuman=await suitable(revocable,annual.id,'revocable');
 const after={tenant:await counters(c.tenantId),self:await counters(c.tenantId,c.actors.self.employmentId),review:await candidate(c.actors.self,annual.id,selected.selfLeave.date,selected.selfLeave.humanText)};
 requireFact(after.tenant.requests===before.tenant.requests+1&&after.tenant.submittedEvents===before.tenant.submittedEvents+1&&JSON.stringify(before.self)===JSON.stringify(after.self)&&JSON.stringify(before.review)===JSON.stringify(after.review));
 const revocableCounts=await counters(c.tenantId,revocable.employmentId);requireFact(revocableCounts.requests===0&&revocableCounts.submittedEvents===0);
 const people=[c.actors.self.personId,sameTenant.personId,foreignActor.personId,revocable.personId];requireFact(new Set(people).size===4&&otherCompany.id!==c.companyId);
 return{format:1 as const,state:'scope_denial_prerequisites_not_experienced' as const,
  sameTenantOtherCompany:{tenantId:c.tenantId,companyId:otherCompany.id,actor:reference(sameTenant),request:otherRequest},
  foreignTenant:{tenantId:foreign.tenantId,companyId:foreign.companyId,actor:reference(foreignActor),request:foreignRequest},
  revocable:{tenantId:c.tenantId,companyId:c.companyId,actor:reference(revocable),human:{leaveTypeId:annual.id,...revocableHuman},assistantGrant:'initially_granted_browser_revocation_pending' as const,requestCount:0 as const},
  primaryBaseline:{before:{tenant:before.tenant,self:before.self},after:{tenant:after.tenant,self:after.self},setupAddedRequests:1 as const,setupAddedSubmissionEvents:1 as const},
  limits:{browserEffects:'not_executed' as const,scopeDenial:'UNVERIFIED' as const,revocation:'NOT_PERFORMED' as const,productionAuthentication:'UNVERIFIED' as const,provider:'NOT_CALLED' as const,fixtureIdentity:'selected_cookie_user_only_not_verified_provider_identity' as const},
 };
}
