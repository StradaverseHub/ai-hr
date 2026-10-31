'use server';
import {revalidatePath} from 'next/cache';
import {z,ZodError} from 'zod';
import {adminCompanies} from '@/core/read';
import {getSession} from '@/lib/session';
import {changeRewardCompanyExclusion,rewardPolicyTaken,listRewardPolicyGroups,saveRewardPolicyGroup,RewardPolicyGroupError,defaultPolicy} from '@/packs/rewards/service';
import {rewardPolicyFromForm,RewardPolicyInputError} from '@/app/(app)/rewards/policy-input';
import type {SharedRewardSaveResult} from './editor';
export async function saveSharedRewardPolicyAction(form:FormData):Promise<SharedRewardSaveResult>{
 const session=await getSession();
 try{
  const groupId=String(form.get('groupId')??'')||null,expectedRevision=z.coerce.number().int().min(0).parse(form.get('revision'));
  const year=z.coerce.number().int().min(2000).max(2200).parse(form.get('year'));
  const current=groupId?(await listRewardPolicyGroups(session)).find(group=>group.groupId===groupId):null;
  if(groupId&&(!current||current.revision!==expectedRevision))return {ok:false,code:'changed'};
  const rawTargets=form.get('targets');if(typeof rawTargets!=='string'||rawTargets.length>100000)return {ok:false,code:'invalid'};
  const base=current?.policy??defaultPolicy(year),policy=rewardPolicyFromForm(form,{...base,year},{context:'shared'});
  const version=await saveRewardPolicyGroup(session,{groupId,expectedRevision,name:String(form.get('name')??''),policy,targets:JSON.parse(rawTargets)});
  revalidatePath('/admin/rewards','layout');return {ok:true,value:{groupId:version.groupId,revision:version.revision}};
 }catch(error){
  if(error instanceof RewardPolicyGroupError)return {ok:false,code:error.code,conflicts:error.conflicts};
  if(error instanceof ZodError||error instanceof SyntaxError||error instanceof RewardPolicyInputError)return {ok:false,code:'invalid'};
  console.error('Shared rewards configuration failed',{name:error instanceof Error?error.name:'Unknown'});return {ok:false,code:'system'};
 }
}

/** Fresh session and native company authority on every year change; no client-provided scope. */
export async function loadSharedRewardTakenAction(year:number){
 const session=await getSession();
 const parsed=z.number().int().min(2000).max(2200).parse(year);
 const companies=await adminCompanies(session);
 return rewardPolicyTaken(session,companies.map(company=>company.id),parsed);
}

export async function changeSharedRewardExclusionAction(form:FormData):Promise<{ok:boolean}>{
 const session=await getSession();
 try{
  await changeRewardCompanyExclusion(session,{companyId:form.get('companyId'),year:Number(form.get('year')),reason:form.get('reason'),endId:form.get('endId')||null});
  revalidatePath('/admin/rewards','layout');return {ok:true};
 }catch{return {ok:false};}
}
