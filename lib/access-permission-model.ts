/** Canonical access algebra. Trusted owner snapshots only; never accept this shape from a form/session cookie.
 * Scope evidence is supplied by app.is_company_descendant, not a second JavaScript organisation tree.
 * This model is source-only until all registered bindings are enforced by their domain owners.
 */
export type AccessCapability={id:string;scope:'tenant'|'company';supported:boolean;bindings:readonly {owner:string;operation:string}[]};
export type CapabilityGrant={capabilityId:string;companyId:string|null};
export type AccessGroup={id:string;name:string;retired:boolean;systemAdministrator:boolean;grants:readonly CapabilityGrant[]};
export type UserCapabilityOverride=CapabilityGrant&{userId:string;effect:'allow'|'deny'};
export type AccessMembership={userId:string;groupId:string};
export type AccessUser={id:string;active:boolean};
export type AccessSnapshot={tenantId:string;revision:string;users:readonly AccessUser[];groups:readonly AccessGroup[];memberships:readonly AccessMembership[];overrides:readonly UserCapabilityOverride[]};
export type AccessTarget={tenantId:string;companyId:string|null};
export type AccessSource={kind:'group'|'individual';id:string;effect:'allow'|'deny';companyId:string|null};
export type AccessResolution={allowed:boolean;reason:'allowed'|'denied'|'unassigned'|'unsupported'|'unavailable';sources:readonly AccessSource[]};
export type CompanyScopeEvidence={tenantId:string;knownCompanyIds:ReadonlySet<string>;covers:(ancestor:string,company:string)=>boolean};
export class AccessPermissionError extends Error{
 constructor(readonly code:'invalid'|'changed'|'unsupported'|'ceiling'|'lastAdministrator'){super(`Access permission: ${code}`);this.name='AccessPermissionError';}
}
function covers(scope:string|null,target:AccessTarget,evidence:CompanyScopeEvidence){
 if(target.tenantId!==evidence.tenantId)return false;
 if(scope!==null&&!evidence.knownCompanyIds.has(scope))return false;
 if(target.companyId===null)return scope===null;
 if(!evidence.knownCompanyIds.has(target.companyId))return false;
 return scope===null||scope===target.companyId||evidence.covers(scope,target.companyId);
}
/** Groups and individual grants combine. A matching individual denial wins over every allow source. */
export function resolveAccessCapability(snapshot:AccessSnapshot,catalog:readonly AccessCapability[],userId:string,capabilityId:string,target:AccessTarget,evidence:CompanyScopeEvidence):AccessResolution{
 const definition=catalog.find(item=>item.id===capabilityId);
 if(!definition?.supported||!definition.bindings.length)return {allowed:false,reason:'unsupported',sources:[]};
 if(snapshot.tenantId!==target.tenantId||snapshot.tenantId!==evidence.tenantId||!snapshot.users.some(user=>user.id===userId&&user.active)||definition.scope==='company'&&target.companyId===null||definition.scope==='tenant'&&target.companyId!==null)return {allowed:false,reason:'unavailable',sources:[]};
 const membershipIds=new Set(snapshot.memberships.filter(row=>row.userId===userId).map(row=>row.groupId));
 const sources:AccessSource[]=[];
 for(const group of snapshot.groups){
  if(group.retired||!membershipIds.has(group.id))continue;
  for(const grant of group.grants)if(grant.capabilityId===capabilityId&&covers(grant.companyId,target,evidence))sources.push({kind:'group',id:group.id,effect:'allow',companyId:grant.companyId});
 }
 for(const override of snapshot.overrides)if(override.userId===userId&&override.capabilityId===capabilityId&&covers(override.companyId,target,evidence))sources.push({kind:'individual',id:userId,effect:override.effect,companyId:override.companyId});
 sources.sort((a,b)=>a.kind.localeCompare(b.kind)||a.id.localeCompare(b.id)||a.effect.localeCompare(b.effect)||(a.companyId??'').localeCompare(b.companyId??''));
 if(sources.some(source=>source.effect==='deny'))return {allowed:false,reason:'denied',sources};
 return {allowed:sources.length>0,reason:sources.length?'allowed':'unassigned',sources};
}
/** A grant ceiling applies to each precise target; a scoped holder cannot delegate a tenant grant. */
export function assertAccessGrantCeiling(snapshot:AccessSnapshot,catalog:readonly AccessCapability[],actorUserId:string,grants:readonly CapabilityGrant[],evidence:CompanyScopeEvidence){
 for(const grant of grants){
  const capability=catalog.find(item=>item.id===grant.capabilityId);if(!capability?.supported||!capability.bindings.length)throw new AccessPermissionError('unsupported');
  if(capability.scope==='company'&&grant.companyId===null){
   // A global grant covers future companies too: enumeration of today's children cannot prove it.
   const memberIds=new Set(snapshot.memberships.filter(row=>row.userId===actorUserId).map(row=>row.groupId));
   const globalAllow=snapshot.groups.some(group=>!group.retired&&memberIds.has(group.id)&&group.grants.some(item=>item.capabilityId===grant.capabilityId&&item.companyId===null))||snapshot.overrides.some(item=>item.userId===actorUserId&&item.capabilityId===grant.capabilityId&&item.companyId===null&&item.effect==='allow');
   const denied=snapshot.overrides.some(item=>item.userId===actorUserId&&item.capabilityId===grant.capabilityId&&item.effect==='deny');
   if(snapshot.tenantId!==evidence.tenantId||!snapshot.users.some(user=>user.id===actorUserId&&user.active)||!globalAllow||denied)throw new AccessPermissionError('ceiling');
  }else if(!resolveAccessCapability(snapshot,catalog,actorUserId,grant.capabilityId,{tenantId:snapshot.tenantId,companyId:grant.companyId},evidence).allowed)throw new AccessPermissionError('ceiling');
 }
}
/** Keep the bootstrap recovery authority explicit; an ordinary group cannot declare itself protected. */
export function assertSystemAdministratorSurvives(before:AccessSnapshot,after:AccessSnapshot,catalog:readonly AccessCapability[],evidence:CompanyScopeEvidence){
 if(before.tenantId!==after.tenantId||before.tenantId!==evidence.tenantId)throw new AccessPermissionError('invalid');
 const protectedIds=new Set(before.groups.filter(group=>group.systemAdministrator).map(group=>group.id));
 if(!protectedIds.size||after.groups.some(group=>group.systemAdministrator&&!protectedIds.has(group.id)))throw new AccessPermissionError('invalid');
 if([...protectedIds].some(id=>!after.groups.some(group=>group.id===id&&group.systemAdministrator&&!group.retired)))throw new AccessPermissionError('lastAdministrator');
 const target={tenantId:after.tenantId,companyId:null};
 const survives=after.users.some(user=>user.active&&after.memberships.some(membership=>membership.userId===user.id&&protectedIds.has(membership.groupId))&&resolveAccessCapability(after,catalog,user.id,'access.system_admin',target,evidence).allowed);
 if(!survives)throw new AccessPermissionError('lastAdministrator');
}
export type AccessPreviewChange={userId:string;capabilityId:string;companyId:string|null;before:AccessResolution;after:AccessResolution};
/** A preview identifies access retained through another group, alongside gains and losses. */
export function previewEffectiveAccess(before:AccessSnapshot,after:AccessSnapshot,catalog:readonly AccessCapability[],userIds:readonly string[],targets:readonly {capabilityId:string;target:AccessTarget}[],evidence:CompanyScopeEvidence):AccessPreviewChange[]{
 if(before.tenantId!==after.tenantId||userIds.length>5000||targets.length>1000||userIds.length*targets.length>100000)throw new AccessPermissionError('invalid');
 const out:AccessPreviewChange[]=[];
 for(const userId of [...new Set(userIds)].sort())for(const {capabilityId,target} of targets){
  const previous=resolveAccessCapability(before,catalog,userId,capabilityId,target,evidence),next=resolveAccessCapability(after,catalog,userId,capabilityId,target,evidence);
  if(previous.allowed!==next.allowed||previous.reason!==next.reason||JSON.stringify(previous.sources)!==JSON.stringify(next.sources))out.push({userId,capabilityId,companyId:target.companyId,before:previous,after:next});
 }
 return out;
}
