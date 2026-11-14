'use server';
import {getSession} from '@/lib/session';
import {beginRewardViewAs,endRewardViewAs} from '@/packs/rewards/access-policy';
import {revalidatePath} from 'next/cache';
import {redirect} from 'next/navigation';
import type {RewardConfigSummary} from '@/packs/rewards/config-change-model';

/** Board db14e49c: typed outcomes for the Role permissions grid (never a bare ok:false). */
export type RolePermissionActionError='stale'|'locked'|'forbidden'|'invalid'|'held'|'changed'|'reason'|'decided'|'system';
async function code(error:unknown):Promise<RolePermissionActionError>{
 const {RewardRolePermissionError}=await import('@/packs/rewards/role-permission-grid');const {RewardConfigReviewError}=await import('@/packs/rewards/config-change-model');
 if(error instanceof RewardRolePermissionError)return error.code;
 if(error instanceof RewardConfigReviewError)return error.code==='changed'?'changed':'reason';
 if(error&&typeof error==='object'&&'issues' in error)return'invalid';
 return'system';
}
export async function previewRewardRolePermissionBatchAction(raw:unknown):Promise<{ok:true;summary:RewardConfigSummary;digest:string;mode:'apply'|'request'}|{ok:false;error:RolePermissionActionError}>{
 try{const {previewRewardRolePermissionBatch}=await import('@/packs/rewards/role-permission-grid');return{ok:true,...await previewRewardRolePermissionBatch(await getSession(),raw)};}
 catch(error){return{ok:false,error:await code(error)};}
}
export async function saveRewardRolePermissionBatchAction(raw:unknown):Promise<{ok:true;mode:'applied'|'requested'}|{ok:false;error:RolePermissionActionError}>{
 try{
  const {saveRewardRolePermissionBatch}=await import('@/packs/rewards/role-permission-grid');const result=await saveRewardRolePermissionBatch(await getSession(),raw);
  // A saved batch applies to menus, pages and actions straight away: the shared layout recomputes its menu.
  if(result.mode==='applied')revalidatePath('/','layout');else revalidatePath('/admin/rewards/access');
  return{ok:true,mode:result.mode};
 }catch(error){return{ok:false,error:await code(error)};}
}
export async function decideRewardRolePermissionRequestAction(raw:unknown):Promise<{ok:true;status:'applied'|'rejected'|'lapsed'}|{ok:false;error:RolePermissionActionError}>{
 try{
  const {decideRewardRolePermissionRequest}=await import('@/packs/rewards/role-permission-grid');const result=await decideRewardRolePermissionRequest(await getSession(),raw);
  revalidatePath(result.status==='applied'?'/':'/admin/rewards/access',result.status==='applied'?'layout':undefined);
  return{ok:true,status:result.status};
 }catch(error){return{ok:false,error:await code(error)};}
}
export async function beginRewardViewAsAction(fd:FormData){try{await beginRewardViewAs(await getSession(),String(fd.get('userId')??''));}catch{redirect('/admin/rewards/access?policyError=1');}redirect('/admin/rewards/access/view-as');}
export async function endRewardViewAsAction(){await endRewardViewAs(await getSession());redirect('/admin/rewards/access');}
export async function saveRewardPersonalPageAction(fd:FormData){let error=false;try{const{saveRewardPersonalPage}=await import('@/packs/rewards/access-policy');await saveRewardPersonalPage(await getSession(),{userId:String(fd.get('userId')),companyId:String(fd.get('companyId')),capability:fd.get('capability'),validFrom:String(fd.get('validFrom')),validTo:String(fd.get('validTo'))||null,active:fd.get('active')==='on',reason:String(fd.get('reason'))});revalidatePath('/admin/rewards/access');}catch{error=true;}redirect('/admin/rewards/access?tab=users'+(error?'&policyError=1':''));}
