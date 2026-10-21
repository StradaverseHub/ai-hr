/**
 * Transactional access-edit orchestration. This is not yet wired to an application route.
 * The storage adapter and complete SQL/domain enforcement are still required before exposure.
 */
import {randomUUID} from 'node:crypto';
import {withTenant,type SessionContext,type Tx} from '../db/client';
import {actorOf,appendEvent} from '../db/events';
import {lockAccessConfigurationTx} from './access-configuration-lock';
import {
  AccessPermissionError,previewEffectiveAccess,type AccessCapability,type AccessPreviewChange,
  type AccessSnapshot,type CompanyScopeEvidence,
} from '../lib/access-permission-model';
import {
  applyAccessConfigurationCommand,isAccessConfigurationCommand,type AccessConfigurationCommand,
} from '../lib/access-configuration-command';
import {
  accessPreviewFingerprint,assertAccessPreviewCurrent,type AccessPreviewBinding,
} from '../lib/access-preview-fingerprint';

export type CurrentAccessConfiguration={
  snapshot:AccessSnapshot;
  catalog:readonly AccessCapability[];
  evidence:CompanyScopeEvidence;
  scopeFingerprint:string;
};

/**
 * Server-owned dependency, never derived from a request. An adapter must re-read the actual login,
 * principal, configuration and dated scope under this transaction, without a session-grant fallback.
 * persist replaces only configuration rows, performs a revision CAS and preserves membership history.
 * It must not write app_user activity or turn a group flag into an installation-operator grant.
 */
export interface AccessConfigurationOwner{
  loadCurrent(tx:Tx,ctx:SessionContext):Promise<CurrentAccessConfiguration>;
  persist(tx:Tx,ctx:SessionContext,change:{before:AccessSnapshot;after:AccessSnapshot;command:AccessConfigurationCommand}):Promise<boolean>;
}

export type AccessConfigurationEdit={expectedRevision:string;command:unknown};
export type AccessConfigurationPreview={
  revision:string;
  fingerprint:string;
  changes:AccessPreviewChange[];
  /** Scope grants also apply to future descendants; an empty current company list is not global proof. */
  changesUnrestrictedScope:boolean;
};

async function currentTransition(tx:Tx,ctx:SessionContext,p:AccessConfigurationEdit,owner:AccessConfigurationOwner){
  if(!ctx.userId||typeof p.expectedRevision!=='string'||!p.expectedRevision.length||p.expectedRevision.length>128||!isAccessConfigurationCommand(p.command))throw new AccessPermissionError('invalid');
  // All permission writers and account/role deactivation paths must join this same lock at integration.
  // Neither a per-user lock nor a lock acquired after the last-admin count protects concurrent removal.
  await lockAccessConfigurationTx(tx,ctx.tenantId);
  const current=await owner.loadCurrent(tx,ctx);
  if(current.snapshot.tenantId!==ctx.tenantId||current.evidence.tenantId!==ctx.tenantId)throw new AccessPermissionError('invalid');
  const after=applyAccessConfigurationCommand(current.snapshot,current.catalog,ctx.userId,p.expectedRevision,p.command,current.evidence);
  const binding:AccessPreviewBinding={actorUserId:ctx.userId,snapshot:current.snapshot,catalog:current.catalog,command:p.command,scopeFingerprint:current.scopeFingerprint};
  return {current,after,binding,command:p.command};
}

function previewTargets(current:CurrentAccessConfiguration){
  const companies=[...current.evidence.knownCompanyIds].sort();
  return current.catalog.filter(capability=>capability.supported&&capability.bindings.length).flatMap(capability=>
    (capability.scope==='tenant'?[null]:companies).map(companyId=>({capabilityId:capability.id,target:{tenantId:current.snapshot.tenantId,companyId}})),
  );
}

function unrestrictedScopeChanged(command:AccessConfigurationCommand,before:AccessSnapshot){
  if(command.kind==='setMembership'||command.kind==='setOverride')return command.companyId===null;
  const group=before.groups.find(row=>row.id===command.groupId);
  return Boolean(group?.grants.some(grant=>grant.companyId===null)||command.kind==='replaceGroupGrants'&&command.grants.some(grant=>grant.companyId===null));
}

/** Fresh authorization, exact same reducer and lock as commit; no preview is an access grant. */
export function previewAccessConfiguration(ctx:SessionContext,p:AccessConfigurationEdit,owner:AccessConfigurationOwner):Promise<AccessConfigurationPreview>{
  return withTenant(ctx,async tx=>{
    const {current,after,binding,command}=await currentTransition(tx,ctx,p,owner);
    return {
      revision:current.snapshot.revision,
      fingerprint:accessPreviewFingerprint(binding),
      changes:previewEffectiveAccess(current.snapshot,after,current.catalog,current.snapshot.users.map(user=>user.id),previewTargets(current),current.evidence),
      changesUnrestrictedScope:unrestrictedScopeChanged(command,current.snapshot),
    };
  });
}

/** Bounded audit identifiers and capability/scope changes; no user names, email, or free-text reason. */
function auditChange(command:AccessConfigurationCommand,before:AccessSnapshot,after:AccessSnapshot){
  const base={kind:command.kind,beforeRevision:before.revision,afterRevision:after.revision};
  if(command.kind==='setOverride'){
    const previous=before.overrides.find(row=>row.userId===command.userId&&row.capabilityId===command.capabilityId&&row.companyId===command.companyId);
    return {...base,userId:command.userId,capabilityId:command.capabilityId,companyId:command.companyId,beforeEffect:previous?.effect??null,afterEffect:command.effect};
  }
  if(command.kind==='setMembership')return {...base,userId:command.userId,groupId:command.groupId,companyId:command.companyId,enabled:command.enabled};
  if(command.kind==='replaceGroupGrants')return {...base,groupId:command.groupId,beforeGrants:before.groups.find(row=>row.id===command.groupId)?.grants??[],afterGrants:command.grants};
  return {...base,groupId:command.groupId,...(command.kind==='renameGroup'?{nameChanged:true}:command.kind==='retireGroup'?{retired:true}:{created:true})};
}

/**
 * A stale preview, revoked actor, changed scope or lost recovery administrator refuses before persist.
 * CAS and immutable domain event share the transaction: an audit failure rolls back the permission edit.
 */
export function saveAccessConfiguration(ctx:SessionContext,p:AccessConfigurationEdit&{previewFingerprint:unknown},owner:AccessConfigurationOwner){
  return withTenant(ctx,async tx=>{
    const {current,after,binding,command}=await currentTransition(tx,ctx,p,owner);
    assertAccessPreviewCurrent(binding,p.previewFingerprint);
    const committed={...after,revision:randomUUID()};
    if(!await owner.persist(tx,ctx,{before:current.snapshot,after:committed,command}))throw new AccessPermissionError('changed');
    await appendEvent(tx,{
      tenantId:ctx.tenantId,aggregateType:'access-configuration',aggregateId:ctx.tenantId,
      eventType:'access-configuration.changed',actor:actorOf(ctx),
      payload:auditChange(command,current.snapshot,committed),
    });
    return {revision:committed.revision};
  });
}
