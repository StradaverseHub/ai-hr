/** Named HR routing is an authority-narrowing adapter over the canonical organisation resolver. */
import {createHash,randomUUID} from 'node:crypto';
import {and,asc,eq,isNull,inArray,sql} from 'drizzle-orm';
import {withTenant,type SessionContext,type Tx} from '../db/client';
import {employment,assignment,profileChangeRequest,person} from '../db/schema';
import {appendEvent,actorOf} from '../db/events';
import {getSetting} from './entitlements';
import {freshProfileEditPolicyTx} from './profile-edit-policy';
import {setTenantSetting} from './tenant-settings';
import {isAdmin,isGroupAdmin} from '../lib/authz-model';
import {todayInKualaLumpur} from '../lib/hr-date';
import {resolveOrgCriteriaTargets,ORG_CRITERIA_FIELDS,ORG_CRITERIA_DATE_FIELDS,ORG_CRITERIA_NUMBER_FIELDS,type OrgCriteria} from './org-criteria';
import {EMPTY_PROFILE_ROUTING,PROFILE_ROUTING_KEY,isProfileRoutingPolicy,type ProfileRoutingPolicy,type ProfileRouteRule} from '../lib/profile-routing-policy';
export class ProfileRoutingError extends Error{
 constructor(readonly code:'invalid'|'missing'|'overlap'|'unauthorized'|'changed'|'reasonRequired'){super(`Profile routing: ${code}`);this.name='ProfileRoutingError';}
}
export function readProfileRoutingPolicy(ctx:SessionContext):ProfileRoutingPolicy{
 const raw=getSetting(ctx,PROFILE_ROUTING_KEY);if(raw==null)return EMPTY_PROFILE_ROUTING;
 if(!isProfileRoutingPolicy(raw))throw new ProfileRoutingError('invalid');
 for(const rule of raw.rules)validateCriteria(rule.criteria);
 return raw;
}
function validateCriteria(criteria:ProfileRouteRule['criteria']){
 for(const [key,value] of Object.entries(criteria)){
  if(ORG_CRITERIA_FIELDS.includes(key)){if(!Array.isArray(value))throw new ProfileRoutingError('invalid');}
  else if((ORG_CRITERIA_DATE_FIELDS as readonly string[]).includes(key)){if(typeof value!=='string'||!/^\d{4}-\d{2}-\d{2}$/.test(value)||!Number.isFinite(Date.parse(value+'T00:00:00Z'))||new Date(value+'T00:00:00Z').toISOString().slice(0,10)!==value)throw new ProfileRoutingError('invalid');}
  else if((ORG_CRITERIA_NUMBER_FIELDS as readonly string[]).includes(key)){if(typeof value!=='number'||!Number.isInteger(value)||value<0||value>150)throw new ProfileRoutingError('invalid');}
  else throw new ProfileRoutingError('invalid');
 }
 if(typeof criteria.hiredFrom==='string'&&typeof criteria.hiredTo==='string'&&criteria.hiredFrom>criteria.hiredTo)throw new ProfileRoutingError('invalid');
 if(typeof criteria.minYearsOfService==='number'&&typeof criteria.maxYearsOfService==='number'&&criteria.minYearsOfService>criteria.maxYearsOfService)throw new ProfileRoutingError('invalid');
}
async function routeTargets(tx:Tx,rule:ProfileRouteRule,subjectId?:string){
 const ids=subjectId?[subjectId]:rule.employmentIds;
 if(subjectId&&rule.employmentIds.length&&!rule.employmentIds.includes(subjectId))return [];
 return resolveOrgCriteriaTargets(tx,{criteria:rule.criteria as OrgCriteria,asOf:todayInKualaLumpur(),...(ids.length?{employmentIds:ids}:{})});
}
/** The SQL helper checks the candidate's current login, active employment and real company-tree grants. */
async function namedPrincipal(tx:Tx,approverEmploymentId:string,subjectId:string){
 const rows=await tx.execute(sql`select * from app.profile_route_principal(${approverEmploymentId}::uuid,${subjectId}::uuid)`);
 const values=rows as unknown as {user_id:string;employment_id:string}[];
 if(values.length!==1)throw new ProfileRoutingError('unauthorized');return values[0];
}
async function subjectContext(tx:Tx,ctx:SessionContext,subjectId:string){
 const [e]=await tx.select({companyId:employment.companyId,gradeId:employment.gradeId,orgDivision:employment.orgDivision,orgBranch:employment.orgBranch,orgRegion:employment.orgRegion,orgLine:employment.orgLine,orgSection:employment.orgSection,orgTeam:employment.orgTeam,orgBase:employment.orgBase,employmentCategory:employment.employmentCategory,hiredOn:employment.hiredOn,confirmationDate:employment.confirmationDate,resignationDate:employment.resignationDate,lastWorkingDate:employment.lastWorkingDate,terminatedOn:employment.terminatedOn,blacklistedAt:employment.blacklistedAt,gender:person.gender,nationality:person.nationality,religion:person.religion,race:person.race}).from(employment).innerJoin(person,eq(person.id,employment.personId)).where(and(eq(employment.id,subjectId),eq(employment.tenantId,ctx.tenantId))).limit(1).for('update');
 if(!e)throw new ProfileRoutingError('unauthorized');
 const today=todayInKualaLumpur();
 const rows=await tx.select({id:assignment.id,companyId:assignment.companyId,departmentId:assignment.departmentId,businessUnitId:assignment.businessUnitId,positionId:assignment.positionId,costCenterId:assignment.costCenterId,employmentType:assignment.employmentType}).from(assignment).where(and(eq(assignment.employmentId,subjectId),isNull(assignment.supersededAt),sql`${assignment.validFrom}<=${today}::date AND (${assignment.validTo} IS NULL OR ${assignment.validTo}>${today}::date)`)).orderBy(asc(assignment.id)).limit(2);
 if(rows.length>1)throw new ProfileRoutingError('invalid');
 return {asOf:today,companyId:e.companyId,fingerprint:createHash('sha256').update(JSON.stringify({employment:e,assignment:rows[0]??null})).digest('hex')};
}
export async function resolveProfileRouteTx(tx:Tx,ctx:SessionContext,subjectId:string){
 const policy=readProfileRoutingPolicy(ctx);if(!policy.enabled)return null;
 const matches:ProfileRouteRule[]=[];
 for(const rule of policy.rules)if((await routeTargets(tx,rule,subjectId)).includes(subjectId))matches.push(rule);
 if(matches.length!==1)throw new ProfileRoutingError(matches.length?'overlap':'missing');
 const rule=matches[0],principal=await namedPrincipal(tx,rule.approverEmploymentId,subjectId);
 return {routeId:rule.id,routeRevision:policy.revision,routeApproverUserId:principal.user_id,routeApproverEmploymentId:principal.employment_id,routeContext:await subjectContext(tx,ctx,subjectId)};
}
export async function assertProfileRouteDecisionTx(tx:Tx,ctx:SessionContext,request:typeof profileChangeRequest.$inferSelect){
 const policy=readProfileRoutingPolicy(ctx);
 if(!request.routeId){if(policy.enabled)throw new ProfileRoutingError('changed');return;}
 const current=await resolveProfileRouteTx(tx,ctx,request.employmentId);
 if(!current||current.routeId!==request.routeId||current.routeRevision!==request.routeRevision||current.routeApproverUserId!==request.routeApproverUserId||current.routeApproverEmploymentId!==request.routeApproverEmploymentId||current.routeContext.fingerprint!==(request.routeContext as {fingerprint?:unknown}|null)?.fingerprint)throw new ProfileRoutingError('changed');
 if(ctx.userId!==current.routeApproverUserId)throw new ProfileRoutingError('unauthorized');
}
/** Used identically for queue, detail and decided counts; row RLS is an independent fence. */
export function profileRouteReaderPredicate(ctx:SessionContext){
 return sql`app.profile_route_reader(${profileChangeRequest.employmentId},${profileChangeRequest.routeApproverUserId},${profileChangeRequest.routeApproverEmploymentId},${profileChangeRequest.status}::text)`;
}
export function saveProfileRoutingPolicy(ctx:SessionContext,p:{expectedRevision:string;enabled:boolean;rules:ProfileRouteRule[]}){
 return withTenant(ctx,async tx=>{
  if(!isGroupAdmin(ctx))throw new ProfileRoutingError('unauthorized');
  const fresh=await freshProfileEditPolicyTx(tx,ctx),before=readProfileRoutingPolicy(fresh.ctx);
  if(before.revision!==p.expectedRevision||before.enabled&&!p.enabled)throw new ProfileRoutingError('changed');
  const value={version:1 as const,enabled:p.enabled,revision:randomUUID(),rules:p.rules};
  if(!isProfileRoutingPolicy(value))throw new ProfileRoutingError('invalid');
  const candidates=await tx.execute(sql`select employment_id from app.profile_route_candidates()`);
  const candidateIds=new Set((candidates as unknown as {employment_id:string}[]).map(row=>row.employment_id));
  if(value.rules.some(rule=>!candidateIds.has(rule.approverEmploymentId)))throw new ProfileRoutingError('unauthorized');
  const covered=new Set<string>();
  for(const rule of value.rules){validateCriteria(rule.criteria);const targets=await routeTargets(tx,rule);
   for(const id of targets){if(covered.has(id))throw new ProfileRoutingError('overlap');covered.add(id);await namedPrincipal(tx,rule.approverEmploymentId,id);}
  }
  if(value.enabled&&!value.rules.length)throw new ProfileRoutingError('missing');
  await setTenantSetting(fresh.ctx,{key:PROFILE_ROUTING_KEY,value},tx);
  // Existing requests retain their original route identity and history; no silent reassignment.
  return {revision:value.revision,covered:covered.size};
 });
}
/** Explicit reasoned reassignment; original and replacement identities are audit facts, never proposal values. */
export function rerouteProfileRequest(ctx:SessionContext,p:{requestId:string;reason:string}){
 if(!p.reason.trim()||p.reason.length>2000)throw new ProfileRoutingError('reasonRequired');
 return withTenant(ctx,async tx=>{
  if(!isGroupAdmin(ctx))throw new ProfileRoutingError('unauthorized');
  const fresh=await freshProfileEditPolicyTx(tx,ctx);
  await tx.execute(sql`select set_config('app.profile_route_maintenance','on',true)`);
  const [row]=await tx.select({id:profileChangeRequest.id,employmentId:profileChangeRequest.employmentId,status:profileChangeRequest.status,routeId:profileChangeRequest.routeId,routeRevision:profileChangeRequest.routeRevision,routeApproverUserId:profileChangeRequest.routeApproverUserId,routeApproverEmploymentId:profileChangeRequest.routeApproverEmploymentId,routeContext:profileChangeRequest.routeContext,routeHistory:profileChangeRequest.routeHistory}).from(profileChangeRequest).where(eq(profileChangeRequest.id,p.requestId)).limit(1).for('update');
  if(!row||row.status!=='pending')throw new ProfileRoutingError('changed');
  const route=await resolveProfileRouteTx(tx,fresh.ctx,row.employmentId)??{routeId:null,routeRevision:null,routeApproverUserId:null,routeApproverEmploymentId:null,routeContext:null};
  await tx.update(profileChangeRequest).set({...route,routeHistory:[...(Array.isArray(row.routeHistory)?row.routeHistory:[]),{before:{routeId:row.routeId,revision:row.routeRevision,approverUserId:row.routeApproverUserId,approverEmploymentId:row.routeApproverEmploymentId},after:route,reason:p.reason.trim(),changedAt:new Date().toISOString(),changedByUserId:ctx.userId}]}).where(eq(profileChangeRequest.id,row.id));
  await appendEvent(tx,{tenantId:ctx.tenantId,aggregateType:'profile-change',aggregateId:row.id,eventType:'profile-change.rerouted',actor:actorOf(ctx),subjectEmploymentId:row.employmentId,payload:{before:{routeId:row.routeId,revision:row.routeRevision,approverUserId:row.routeApproverUserId,approverEmploymentId:row.routeApproverEmploymentId},after:{routeId:route.routeId,revision:route.routeRevision,approverUserId:route.routeApproverUserId,approverEmploymentId:route.routeApproverEmploymentId},reasonProvided:true}});
  return {requestId:row.id};
 });
}

export function profileRouteCounts(ctx:SessionContext,companyIds?:string[]){
 return withTenant(ctx,async tx=>{
  const rows=await tx.select({status:profileChangeRequest.status,count:sql<number>`count(*)::int`}).from(profileChangeRequest).innerJoin(employment,eq(employment.id,profileChangeRequest.employmentId)).where(and(profileRouteReaderPredicate(ctx),companyIds?.length?inArray(employment.companyId,companyIds):undefined)).groupBy(profileChangeRequest.status);
  return {pending:rows.find(row=>row.status==='pending')?.count??0,approved:rows.find(row=>row.status==='approved')?.count??0,rejected:rows.find(row=>row.status==='rejected')?.count??0};
 });
}
/** Maintenance picker contains identities/status only, never another assignee's proposal or current facts. */
export function profileRerouteCandidates(ctx:SessionContext){
 if(!isGroupAdmin(ctx))return Promise.resolve([]);
 return withTenant(ctx,async tx=>{
  await tx.execute(sql`select set_config('app.profile_route_maintenance','on',true)`);
  return tx.select({id:profileChangeRequest.id,employeeCode:employment.employeeCode,name:person.fullName,createdAt:profileChangeRequest.createdAt}).from(profileChangeRequest).innerJoin(employment,eq(employment.id,profileChangeRequest.employmentId)).innerJoin(person,eq(person.id,profileChangeRequest.personId)).where(eq(profileChangeRequest.status,'pending')).orderBy(asc(profileChangeRequest.createdAt),asc(profileChangeRequest.id));
 });
}

export function profileApproverCandidates(ctx:SessionContext){
 if(!isAdmin(ctx))throw new ProfileRoutingError('unauthorized');
 return withTenant(ctx,async tx=>{
  const rows=await tx.execute(sql`select employment_id from app.profile_route_candidates()`);
  return (rows as unknown as {employment_id:string}[]).map(row=>row.employment_id);
 });
}
/** Configuration-only counts reuse the same target and authority owners; no profile values returned. */
export function previewProfileRoutingPolicy(ctx:SessionContext,input:{enabled:boolean;rules:ProfileRouteRule[]}){
 return withTenant(ctx,async tx=>{
  if(!isGroupAdmin(ctx))throw new ProfileRoutingError('unauthorized');
  const value={version:1 as const,revision:EMPTY_PROFILE_ROUTING.revision,...input};
  if(!isProfileRoutingPolicy(value))throw new ProfileRoutingError('invalid');
  const matches=new Map<string,number>();let ineligible=0;
  const candidateRows=await tx.execute(sql`select employment_id from app.profile_route_candidates()`);
  const candidateIds=new Set((candidateRows as unknown as {employment_id:string}[]).map(row=>row.employment_id));
  for(const rule of value.rules){validateCriteria(rule.criteria);const targets=await routeTargets(tx,rule);
   if(!candidateIds.has(rule.approverEmploymentId))ineligible++;
   for(const id of targets){matches.set(id,(matches.get(id)??0)+1);try{await namedPrincipal(tx,rule.approverEmploymentId,id);}catch{ineligible++;}}
  }
  const population=await resolveOrgCriteriaTargets(tx,{criteria:{},asOf:todayInKualaLumpur()});
  return {matched:matches.size,missing:population.filter(id=>!matches.has(id)).length,overlapping:[...matches.values()].filter(count=>count>1).length,ineligible};
 });
}
