/** Pure configuration transition for the trusted access owner. No persistence or runtime grant here. */
import {
  AccessPermissionError, assertAccessGrantCeiling, assertSystemAdministratorSurvives,
  resolveAccessCapability, type AccessCapability, type AccessSnapshot, type CapabilityGrant,
  type CompanyScopeEvidence,
} from './access-permission-model';

export type AccessConfigurationCommand =
  | {kind:'createGroup';groupId:string;name:string}
  | {kind:'renameGroup';groupId:string;name:string}
  | {kind:'retireGroup';groupId:string}
  | {kind:'replaceGroupGrants';groupId:string;grants:CapabilityGrant[]}
  | {kind:'setMembership';groupId:string;userId:string;companyId:string|null;enabled:boolean}
  | {kind:'setOverride';userId:string;capabilityId:string;companyId:string|null;effect:'allow'|'deny'|null};

// PostgreSQL UUID identities include existing seeded values without RFC version/variant bits.
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CAPABILITY=/^[a-z][a-z0-9_]*(?:\.[a-z][a-z0-9_]*){1,5}$/;
const isId=(v:unknown):v is string=>typeof v==='string'&&UUID.test(v);
const isScope=(v:unknown):v is string|null=>v===null||isId(v);
const isName=(v:unknown):v is string=>typeof v==='string'&&v===v.trim()&&v.length>0&&v.length<=100&&!/[\u0000-\u001f\u007f]/.test(v);
function record(v:unknown):v is Record<string,unknown>{return !!v&&typeof v==='object'&&!Array.isArray(v);}
function exact(v:Record<string,unknown>,keys:string[]){return Object.keys(v).length===keys.length&&keys.every(k=>Object.hasOwn(v,k));}
function isGrant(v:unknown):v is CapabilityGrant{return record(v)&&exact(v,['capabilityId','companyId'])&&typeof v.capabilityId==='string'&&CAPABILITY.test(v.capabilityId)&&isScope(v.companyId);}

/** Forms carry one bounded command, never a user-provided effective snapshot or protected flag. */
export function isAccessConfigurationCommand(value:unknown):value is AccessConfigurationCommand{
  if(!record(value))return false;
  switch(value.kind){
    case 'createGroup':case 'renameGroup':return exact(value,['kind','groupId','name'])&&isId(value.groupId)&&isName(value.name);
    case 'retireGroup':return exact(value,['kind','groupId'])&&isId(value.groupId);
    case 'replaceGroupGrants':{
      if(!exact(value,['kind','groupId','grants'])||!isId(value.groupId)||!Array.isArray(value.grants)||value.grants.length>256||!value.grants.every(isGrant))return false;
      return new Set(value.grants.map(g=>g.capabilityId+':'+g.companyId)).size===value.grants.length;
    }
    case 'setMembership':return exact(value,['kind','groupId','userId','companyId','enabled'])&&isId(value.groupId)&&isId(value.userId)&&isScope(value.companyId)&&typeof value.enabled==='boolean';
    case 'setOverride':return exact(value,['kind','userId','capabilityId','companyId','effect'])&&isId(value.userId)&&typeof value.capabilityId==='string'&&CAPABILITY.test(value.capabilityId)&&isScope(value.companyId)&&(value.effect===null||value.effect==='allow'||value.effect==='deny');
    default:return false;
  }
}

function scopeGrant(grant:CapabilityGrant,membershipScope:string|null,evidence:CompanyScopeEvidence):CapabilityGrant|null{
  if(grant.companyId===null)return {...grant,companyId:membershipScope};
  if(membershipScope===null||grant.companyId===membershipScope||evidence.covers(membershipScope,grant.companyId))return {...grant};
  if(evidence.covers(grant.companyId,membershipScope))return {...grant,companyId:membershipScope};
  return null; // Unrelated subtrees confer no permission through this membership.
}
function validateGrants(grants:readonly CapabilityGrant[],catalog:readonly AccessCapability[],evidence:CompanyScopeEvidence){
  for(const grant of grants){
    const definition=catalog.find(c=>c.id===grant.capabilityId);
    if(!definition?.supported||!definition.bindings.length)throw new AccessPermissionError('unsupported');
    if(definition.scope==='tenant'&&grant.companyId!==null||grant.companyId!==null&&!evidence.knownCompanyIds.has(grant.companyId))throw new AccessPermissionError('invalid');
  }
}

/**
 * Call under the canonical tenant access lock with a freshly loaded actor, users, revision and scope
 * evidence. The persistence owner must then compare the complete preview fingerprint before writing.
 * A returned object alone is not authority to mutate anything.
 */
export function applyAccessConfigurationCommand(
  before:AccessSnapshot,catalog:readonly AccessCapability[],actorUserId:string,
  expectedRevision:string,value:unknown,evidence:CompanyScopeEvidence,
):AccessSnapshot{
  if(before.revision!==expectedRevision)throw new AccessPermissionError('changed');
  if(!isAccessConfigurationCommand(value)||before.tenantId!==evidence.tenantId)throw new AccessPermissionError('invalid');
  if(!resolveAccessCapability(before,catalog,actorUserId,'access.configure',{tenantId:before.tenantId,companyId:null},evidence).allowed)throw new AccessPermissionError('ceiling');
  const command=value;
  const after:AccessSnapshot={...before,groups:before.groups.map(g=>({...g,grants:g.grants.map(grant=>({...grant}))})),memberships:before.memberships.map(m=>({...m})),overrides:before.overrides.map(o=>({...o}))};
  const ceiling=(grants:readonly CapabilityGrant[])=>{validateGrants(grants,catalog,evidence);assertAccessGrantCeiling(before,catalog,actorUserId,grants,evidence);};
  const requireUser=(id:string)=>{if(!before.users.some(u=>u.id===id))throw new AccessPermissionError('invalid');};
  if(command.kind==='createGroup'){
    if(before.groups.length>=256||before.groups.some(g=>g.id===command.groupId||g.name.toLocaleLowerCase('en')===command.name.toLocaleLowerCase('en')))throw new AccessPermissionError('invalid');
    after.groups=[...after.groups,{id:command.groupId,name:command.name,retired:false,systemAdministrator:false,grants:[]}];
  }else if(command.kind==='setOverride'){
    requireUser(command.userId);
    const grant={capabilityId:command.capabilityId,companyId:command.companyId};
    // Removing a deny can restore inherited access. Its scope needs the same grant ceiling as allow.
    ceiling([grant]);
    const same=(row:AccessSnapshot['overrides'][number])=>row.userId===command.userId&&row.capabilityId===command.capabilityId&&row.companyId===command.companyId;
    after.overrides=[...after.overrides.filter(row=>!same(row)),...(command.effect===null?[]:[{...grant,userId:command.userId,effect:command.effect}])];
  }else{
    const group=before.groups.find(g=>g.id===command.groupId);
    if(!group||group.retired)throw new AccessPermissionError('invalid');
    if(command.kind==='setMembership'){
      requireUser(command.userId);
      if(command.enabled&&!before.users.some(u=>u.id===command.userId&&u.active)||command.companyId!==null&&!evidence.knownCompanyIds.has(command.companyId))throw new AccessPermissionError('invalid');
      if(group.systemAdministrator&&command.companyId!==null)throw new AccessPermissionError('invalid');
      // Intersect the membership with every grant; do not require global authority for a scoped join.
      ceiling(group.grants.map(g=>command.companyId!==null&&catalog.find(c=>c.id===g.capabilityId)?.scope==='tenant'?null:scopeGrant(g,command.companyId,evidence)).filter((g):g is CapabilityGrant=>g!==null));
      const same=(row:AccessSnapshot['memberships'][number])=>row.userId===command.userId&&row.groupId===command.groupId&&row.companyId===command.companyId;
      after.memberships=[...after.memberships.filter(row=>!same(row)),...(command.enabled?[{userId:command.userId,groupId:command.groupId,companyId:command.companyId}]:[])];
    }else{
      ceiling(group.grants);
      if(command.kind==='replaceGroupGrants'){
        ceiling(command.grants);
        after.groups=after.groups.map(g=>g.id===group.id?{...g,grants:command.grants.map(grant=>({...grant}))}:g);
      }else if(command.kind==='retireGroup'){
        if(group.systemAdministrator)throw new AccessPermissionError('lastAdministrator');
        after.groups=after.groups.map(g=>g.id===group.id?{...g,retired:true}:g);
      }else{
        if(before.groups.some(g=>g.id!==group.id&&g.name.toLocaleLowerCase('en')===command.name.toLocaleLowerCase('en')))throw new AccessPermissionError('invalid');
        after.groups=after.groups.map(g=>g.id===group.id?{...g,name:command.name}:g);
      }
    }
  }
  if(after.memberships.length>100000||after.overrides.length>100000)throw new AccessPermissionError('invalid');
  assertSystemAdministratorSurvives(before,after,catalog,evidence);
  return after;
}
