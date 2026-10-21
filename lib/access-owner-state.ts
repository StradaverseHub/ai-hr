/** Validate the database owner's versioned state before it enters any authorization transition. */
import {AccessPermissionError,type AccessCapability,type AccessSnapshot,type CompanyScopeEvidence,type CapabilityGrant} from './access-permission-model';
const uuid=(v:unknown):v is string=>typeof v==='string'&&/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v);
const object=(v:unknown):v is Record<string,unknown>=>!!v&&typeof v==='object'&&!Array.isArray(v);
const list=(v:unknown,max:number):v is unknown[]=>Array.isArray(v)&&v.length<=max;
const text=(v:unknown,max:number):v is string=>typeof v==='string'&&v.length>0&&v.length<=max;
const scope=(v:unknown)=>v===null||uuid(v);
const unique=(rows:readonly string[])=>new Set(rows).size===rows.length;
const refuse=():never=>{throw new AccessPermissionError('invalid');};

export function parseAccessOwnerState(raw:unknown,tenantId:string){
  if(!object(raw)||!object(raw.snapshot)||!list(raw.catalog,256)||!list(raw.companyIds,5000)||!list(raw.coverage,1000000)||!text(raw.scopeFingerprint,64)||!/^[a-f0-9]{64}$/.test(raw.scopeFingerprint))return refuse();
  const s=raw.snapshot,catalog=raw.catalog;
  if(s.tenantId!==tenantId||!uuid(s.revision)||!list(s.users,5000)||!list(s.groups,256)||!list(s.memberships,100000)||!list(s.overrides,100000))return refuse();
  if(!raw.companyIds.every(uuid)||!unique(raw.companyIds))return refuse();
  const companies=new Set(raw.companyIds),userIds=new Set<string>(),groupIds=new Set<string>(),capIds=new Set<string>();
  if(!list(raw.recoveryUserIds,5000)||!raw.recoveryUserIds.every(uuid))return refuse();
  const validScope=(id:unknown)=>scope(id)&&(id===null||companies.has(id as string));
  for(const cap of raw.catalog){
    if(!object(cap)||!text(cap.id,200)||capIds.has(cap.id)||(cap.scope!=='tenant'&&cap.scope!=='company')||typeof cap.supported!=='boolean'||!list(cap.bindings,128))return refuse();
    if(!cap.bindings.every(b=>object(b)&&text(b.owner,300)&&text(b.operation,100))||cap.supported&&cap.bindings.length===0)return refuse();
    capIds.add(cap.id);
  }
  const validGrant=(v:unknown):v is CapabilityGrant=>object(v)&&typeof v.capabilityId==='string'&&capIds.has(v.capabilityId)&&validScope(v.companyId)&&!(v.companyId!==null&&catalog.some(c=>object(c)&&c.id===v.capabilityId&&c.scope==='tenant'));
  for(const user of s.users){if(!object(user)||!uuid(user.id)||userIds.has(user.id)||typeof user.active!=='boolean')return refuse();userIds.add(user.id);}
  if(raw.recoveryUserIds.some(id=>!userIds.has(id))||!unique(raw.recoveryUserIds))return refuse();
  for(const group of s.groups){
    if(!object(group)||!uuid(group.id)||groupIds.has(group.id)||!text(group.name,100)||typeof group.retired!=='boolean'||typeof group.systemAdministrator!=='boolean'||!list(group.grants,256)||!group.grants.every(validGrant))return refuse();
    if(!unique(group.grants.map(g=>g.capabilityId+':'+g.companyId)))return refuse();groupIds.add(group.id);
  }
  for(const member of s.memberships)if(!object(member)||typeof member.userId!=='string'||!userIds.has(member.userId)||typeof member.groupId!=='string'||!groupIds.has(member.groupId)||!validScope(member.companyId)||member.derived!==undefined&&typeof member.derived!=='boolean')return refuse();
  for(const override of s.overrides)if(!validGrant(override)||!object(override)||typeof override.userId!=='string'||!userIds.has(override.userId)||(override.effect!=='allow'&&override.effect!=='deny'))return refuse();
  const coverage=new Set<string>();
  for(const row of raw.coverage){if(!object(row)||typeof row.ancestor!=='string'||typeof row.company!=='string'||!companies.has(row.ancestor)||!companies.has(row.company))return refuse();coverage.add(row.ancestor+':'+row.company);}
  const evidence:CompanyScopeEvidence={tenantId,knownCompanyIds:companies,covers:(ancestor,company)=>coverage.has(ancestor+':'+company)};
  // The runtime validations above establish every field of these source-owned shapes.
  const checked=s as unknown as AccessSnapshot;
  const snapshot:AccessSnapshot={tenantId,revision:checked.revision,
    users:checked.users.map(u=>({id:u.id,active:u.active})),
    groups:checked.groups.map(g=>({id:g.id,name:g.name,retired:g.retired,systemAdministrator:g.systemAdministrator,grants:g.grants.map(a=>({capabilityId:a.capabilityId,companyId:a.companyId}))})),
    memberships:checked.memberships.map(m=>({userId:m.userId,groupId:m.groupId,companyId:m.companyId,derived:m.derived===true})),
    overrides:checked.overrides.map(o=>({userId:o.userId,capabilityId:o.capabilityId,companyId:o.companyId,effect:o.effect})),
  };
  const capabilities=(catalog as AccessCapability[]).map(c=>({id:c.id,scope:c.scope,supported:c.supported,bindings:c.bindings.map(b=>({owner:b.owner,operation:b.operation}))}));
  return {snapshot,catalog:capabilities,evidence,scopeFingerprint:raw.scopeFingerprint,recoveryUserIds:new Set(raw.recoveryUserIds)};
}
