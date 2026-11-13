'use server';
import {revalidatePath} from 'next/cache';
import {getTranslations} from 'next-intl/server';
import {getSession} from '@/lib/session';
import {previewRewardLimitReapply,previewRewardLimitSave,reapplyRewardLimits,saveRewardLimits} from '@/packs/rewards/limit-controls';
import {RewardConfigReviewError,type RewardConfigSummary} from '@/packs/rewards/config-change-model';
import {RewardSetupError} from '@/packs/rewards/setup-model';
import type {RewardLimitVersionValues} from '@/packs/rewards/limit-controls-model';

/** Board fc804e8c: Limit Controls commands. Every save is previewed (server summary and digest), confirmed with a reason
 * in "Review before saving" and recomputed by the command; there is no second-person confirmation (board 60f1fdcd).
 * The service enforces Group Rewards authority on every call. */
export type LimitReview={summary:RewardConfigSummary;digest:string};
export type LimitResult={ok:true;revision?:number;applied?:number}|{ok:false;error:string;review?:LimitReview};
async function failure(e:unknown){
 if(e instanceof RewardSetupError||e instanceof RewardConfigReviewError)return e.message;
 console.error('Limit Controls command failed',{name:e instanceof Error?e.name:'Unknown'});
 return(await getTranslations('rewardLimits'))('errors.system');
}
export async function previewLimitSaveAction(year:number,expectedRevision:number,values:RewardLimitVersionValues):Promise<{error:string;review?:LimitReview}>{
 try{return{error:'',review:await previewRewardLimitSave(await getSession(),{year,expectedRevision,values})};}catch(e){return{error:await failure(e)};}
}
export async function saveLimitAction(year:number,expectedRevision:number,values:RewardLimitVersionValues,reason:string,summaryDigest:string):Promise<LimitResult>{
 const s=await getSession();
 try{const saved=await saveRewardLimits(s,{year,expectedRevision,values,reason,summaryDigest});revalidatePath('/admin/rewards','layout');revalidatePath('/rewards','layout');return{ok:true,revision:saved.revision};}
 catch(e){
  if(e instanceof RewardConfigReviewError&&e.code==='changed'){try{return{ok:false,error:e.message,review:await previewRewardLimitSave(s,{year,expectedRevision,values})};}catch(again){return{ok:false,error:await failure(again)};}}
  return{ok:false,error:await failure(e)};
 }
}
export async function previewReapplyAction(year:number,revision:number,reviewIds:string[]):Promise<{error:string;review?:LimitReview}>{
 try{return{error:'',review:await previewRewardLimitReapply(await getSession(),{year,revision,reviewIds})};}catch(e){return{error:await failure(e)};}
}
export async function reapplyAction(year:number,revision:number,reviewIds:string[],reason:string,summaryDigest:string):Promise<LimitResult>{
 const s=await getSession();
 try{const result=await reapplyRewardLimits(s,{year,revision,reviewIds,reason,summaryDigest});revalidatePath('/admin/rewards','layout');revalidatePath('/rewards','layout');return{ok:true,applied:result.applied.length};}
 catch(e){
  if(e instanceof RewardConfigReviewError&&e.code==='changed'){try{return{ok:false,error:e.message,review:await previewRewardLimitReapply(s,{year,revision,reviewIds})};}catch(again){return{ok:false,error:await failure(again)};}}
  return{ok:false,error:await failure(e)};
 }
}
