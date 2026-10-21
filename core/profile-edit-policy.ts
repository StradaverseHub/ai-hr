/** Same policy advisory key for every canonical settings writer and profile mutation. */
import {profileVisibilityFingerprint} from '../lib/profile-policy-fingerprint';
import {resolveEssVisibleIds} from '../lib/personnel-ess-visibility';
import {sql} from 'drizzle-orm';
import type {SessionContext,Tx} from '../db/client';
import {getSetting,resolveEntitlementsTx} from './entitlements';
import {resolveEssEditableIds,resolveEssPrimaryEditableIds} from '../lib/personnel-ess-contract';
export async function lockProfileEditPolicyTx(tx:Tx,tenantId:string){
 await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${'profile-edit-policy:'+tenantId},0))`);
}
export async function freshProfileEditPolicyTx(tx:Tx,ctx:SessionContext){
 await lockProfileEditPolicyTx(tx,ctx.tenantId);
 const fresh={...ctx,entitlements:await resolveEntitlementsTx(tx,ctx.tenantId)};
 const raw=getSetting(fresh,'ess.profile_change_fields');
 return {ctx:fresh,editable:resolveEssEditableIds(raw),legacyPrimary:resolveEssPrimaryEditableIds(raw),visible:resolveEssVisibleIds(raw)};
}

/** Settings and withdrawal compose under the same policy lock as save/approval. */
export function saveProfileEditPolicy(ctx:SessionContext,p:{keys:readonly string[];withdrawnReason:string}){
 return withTenant(ctx,async tx=>{
  if(!isGroupAdmin(ctx))throw new TenantSettingError('not_group_admin');
  const fields=essEditableFields();
  const declared=new Set<string>(fields.flatMap(field=>[field.id,...(field.ess.legacyPrimaryKey?[field.ess.legacyPrimaryKey]:[])]));
  if(p.keys.length>512||new Set(p.keys).size!==p.keys.length||p.keys.some(key=>!declared.has(key)))throw new TenantSettingError('wrong_type');
  const before=await freshProfileEditPolicyTx(tx,ctx);
  const previousRequests=resolveAllowedRequestKeys(getSetting(before.ctx,'ess.profile_change_fields'));
  const policy={version:2 as const,fields:p.keys};
  const after=resolveEssEditableIds(policy),afterRequests=resolveAllowedRequestKeys(policy);
  const locked=[...new Set([...before.editable].filter(key=>!after.has(key)).concat([...previousRequests].filter(key=>!afterRequests.has(key))))];
  await setTenantSetting(before.ctx,{key:'ess.profile_change_fields',value:policy},tx);
  const {withdrawProfileChangesForLockedFields}=await import('./profile');
  return withdrawProfileChangesForLockedFields(before.ctx,{lockedKeys:locked,reason:p.withdrawnReason},tx);
 });
}

import {withTenant} from '../db/client';
import {isGroupAdmin} from '../lib/authz-model';
import {essEditableFields} from '../lib/personnel-ess-contract';
import {resolveAllowedRequestKeys} from '../lib/profile-requestable-fields';
import {setTenantSetting,TenantSettingError} from './tenant-settings';

/** Complete three-state policy, with finite primary-contact compatibility carried separately. */
export function saveProfileVisibilityPolicy(ctx:SessionContext,p:{policy:unknown;withdrawnReason:string;expectedFingerprint?:string}){
 return withTenant(ctx,async tx=>{
  if(!isGroupAdmin(ctx))throw new TenantSettingError('not_group_admin');
  if(!isProfileVisibilityPolicyValue(p.policy))throw new TenantSettingError('wrong_type');
  const policy=p.policy,visible=essVisibleFields(),ids=new Set(visible.map(field=>field.id));
  const groupIds=new Set(visible.flatMap(field=>[profileTabPolicyKey(field.tab),profileSectionPolicyKey(field.tab,field.section)]));
  if(policy.version===4&&Object.keys(policy.groups).some(id=>!groupIds.has(id)))throw new TenantSettingError('wrong_type');
  if(Object.keys(policy.fields).length!==ids.size||Object.keys(policy.fields).some(id=>!ids.has(id)))throw new TenantSettingError('wrong_type');
  if(visible.some(field=>policy.fields[field.id]==='editable'&&(!field.ess.binding||!['immediate','approval'].includes(field.ess.edit))))throw new TenantSettingError('wrong_type');
  if(policy.primaryOnly.some(id=>!visible.some(field=>field.id===id&&field.ess.legacyPrimaryKey)||policy.fields[id]!=='viewOnly'))throw new TenantSettingError('wrong_type');
  const before=await freshProfileEditPolicyTx(tx,ctx);
  if(p.expectedFingerprint!==undefined&&p.expectedFingerprint!==profileVisibilityFingerprint(getSetting(before.ctx,'ess.profile_change_fields')))throw new TenantSettingError('wrong_type');
  const nextVisible=resolveEssVisibleIds(policy),nextEditable=resolveEssEditableIds(policy),nextPrimary=resolveEssPrimaryEditableIds(policy);
  // Alias restrictions cannot silently retain mutation authority over the hidden source fact.
  if([...nextEditable,...nextPrimary].some(id=>!nextVisible.has(id)))throw new TenantSettingError('wrong_type');
  const previous=resolveAllowedRequestKeys(getSetting(before.ctx,'ess.profile_change_fields')),next=resolveAllowedRequestKeys(policy);
  const photo=visible.find(field=>field.id==='profile.personal_details.photo')!;
  const beforeRaw=getSetting(before.ctx,'ess.profile_change_fields');
  const photoClosed=before.visible.has(photo.id)&&(!isProfileVisibilityPolicyValue(beforeRaw)||profileGroupPermission(beforeRaw,photo)==='editable')&&(!nextVisible.has(photo.id)||profileGroupPermission(policy,photo)!=='editable');
  const locked=[...new Set([...before.editable].filter(id=>!nextEditable.has(id)).concat([...before.legacyPrimary].filter(id=>!nextPrimary.has(id)),[...previous].filter(id=>!next.has(id)),[...before.visible].filter(id=>!nextVisible.has(id)),photoClosed?[photo.id]:[]))];
  await setTenantSetting(before.ctx,{key:'ess.profile_change_fields',value:policy},tx);
  const {withdrawProfileChangesForLockedFields}=await import('./profile');
  return withdrawProfileChangesForLockedFields(before.ctx,{lockedKeys:locked,reason:p.withdrawnReason},tx);
 });
}
import {isProfileVisibilityPolicyValue,profileTabPolicyKey,profileSectionPolicyKey,profileGroupPermission} from '../lib/profile-edit-policy-value';
import {essVisibleFields} from '../lib/personnel-ess-contract';

/** One immutable policy generation for the initial own-profile presentation. Independent actions re-read. */
export function readProfilePresentationPolicy(ctx:SessionContext){return withTenant(ctx,tx=>freshProfileEditPolicyTx(tx,ctx));}
export type ProfilePresentationPolicy=Awaited<ReturnType<typeof freshProfileEditPolicyTx>>;

/** Disabling submission withdraws pending photos in the same locked policy transaction. */
export function saveOwnPhotoSubmissionSetting(ctx:SessionContext,p:{enabled:boolean;withdrawnReason:string}){
 return withTenant(ctx,async tx=>{
  if(!isGroupAdmin(ctx))throw new TenantSettingError('not_group_admin');
  const fresh=await freshProfileEditPolicyTx(tx,ctx);
  await setTenantSetting(fresh.ctx,{key:'ess.profile_photo_edit',value:p.enabled},tx);
  const {withdrawProfileChangesForLockedFields}=await import('./profile');
  return withdrawProfileChangesForLockedFields(fresh.ctx,{lockedKeys:p.enabled?[]:['profile.personal_details.photo'],reason:p.withdrawnReason},tx);
 });
}
