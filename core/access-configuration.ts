/**
 * Transactional access-edit orchestration. Page/actions use the private SQL owner.
 * Domain capability availability is installed separately by the restricted storage-owner publisher;
 * customer permission editing cannot publish unsupported capabilities or invent enforcement bindings.
 */
import {randomUUID} from 'node:crypto';
import {withTenant,type SessionContext,type Tx} from '../db/client';
import {lockAccessConfigurationTx} from './access-configuration-lock';
import {
  AccessPermissionError,previewEffectiveAccess,type AccessCapability,type AccessPreviewChange,
  assertSystemAdministratorSurvives,type AccessSnapshot,type CompanyScopeEvidence,
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
  /** Internal only: accounts that do not automatically expire under known lifecycle facts. */
  recoveryUserIds:ReadonlySet<string>;
};

/**
 * Server-owned dependency, never derived from a request. An adapter must re-read the actual login,
 * principal, configuration and dated scope under this transaction, without a session-grant fallback.
 * persist replaces only configuration rows, performs a revision CAS and preserves membership history.
 * It must append the bounded audit atomically inside its database write seam, including raw SQL calls.
 * It must not write app_user activity or turn a group flag into an installation-operator grant.
 */
export interface AccessConfigurationOwner{
  loadCurrent(tx:Tx,ctx:SessionContext):Promise<CurrentAccessConfiguration>;
  persist(tx:Tx,ctx:SessionContext,change:{before:AccessSnapshot;after:AccessSnapshot;command:AccessConfigurationCommand;scopeFingerprint:string}):Promise<boolean>;
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
  const recovery={...after,users:after.users.map(user=>({...user,active:user.active&&current.recoveryUserIds.has(user.id)}))};
  assertSystemAdministratorSurvives(current.snapshot,recovery,current.catalog,current.evidence);
  const binding:AccessPreviewBinding={actorUserId:ctx.userId,snapshot:current.snapshot,catalog:current.catalog,command:p.command,scopeFingerprint:current.scopeFingerprint};
  return {current,after,binding,command:p.command};
}

function previewTargets(current:CurrentAccessConfiguration,capabilityIds:ReadonlySet<string>){
  const companies=[...current.evidence.knownCompanyIds].sort();
  return current.catalog.filter(capability=>capabilityIds.has(capability.id)&&capability.supported&&capability.bindings.length).flatMap(capability=>
    (capability.scope==='tenant'?[null]:companies).map(companyId=>({capabilityId:capability.id,target:{tenantId:current.snapshot.tenantId,companyId}})),
  );
}

function affectedPreview(current:CurrentAccessConfiguration,command:AccessConfigurationCommand){
  if(command.kind==='setOverride')return {users:[command.userId],capabilities:new Set([command.capabilityId])};
  if(command.kind==='createGroup'||command.kind==='renameGroup')return {users:[],capabilities:new Set<string>()};
  const group=current.snapshot.groups.find(row=>row.id===command.groupId);
  const grants=[...(group?.grants??[]),...(command.kind==='replaceGroupGrants'?command.grants:[])];
  const users=command.kind==='setMembership'?[command.userId]:current.snapshot.memberships.filter(row=>row.groupId===command.groupId).map(row=>row.userId);
  return {users:[...new Set(users)],capabilities:new Set(grants.map(grant=>grant.capabilityId))};
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
    const affected=affectedPreview(current,command);
    return {
      revision:current.snapshot.revision,
      fingerprint:accessPreviewFingerprint(binding),
      changes:previewEffectiveAccess(current.snapshot,after,current.catalog,affected.users,previewTargets(current,affected.capabilities),current.evidence),
      changesUnrestrictedScope:unrestrictedScopeChanged(command,current.snapshot),
    };
  });
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
    if(!await owner.persist(tx,ctx,{before:current.snapshot,after:committed,command,scopeFingerprint:current.scopeFingerprint}))throw new AccessPermissionError('changed');
    return {revision:committed.revision};
  });
}
