/** Same policy advisory key for every canonical settings writer and profile mutation. */
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
 return {ctx:fresh,editable:resolveEssEditableIds(raw),legacyPrimary:resolveEssPrimaryEditableIds(raw)};
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
import {isGroupAdmin} from '../lib/authz';
import {essEditableFields} from '../lib/personnel-ess-contract';
import {resolveAllowedRequestKeys} from '../lib/profile-requestable-fields';
import {setTenantSetting,TenantSettingError} from './tenant-settings';
