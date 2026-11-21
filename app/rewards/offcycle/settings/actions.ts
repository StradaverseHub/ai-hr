'use server';
import {revalidatePath} from 'next/cache';
import {getTranslations} from 'next-intl/server';
import {getSession} from '@/lib/session';
import {previewRewardOffcycleYearSave,saveRewardOffcycleYear,RewardError} from '@/packs/rewards/service';
import {RewardConfigReviewError,type RewardConfigSummary} from '@/packs/rewards/config-change-model';

/** b945f0cc: opening the off-cycle year and the mid-year window follow board 60f1fdcd: "Review before saving" (server
 * summary and digest), a reason and one change-log row; no second person. The service enforces Group Rewards authority. */
export type OffcycleReview={summary:RewardConfigSummary;digest:string};
export type OffcycleInput={cycleId:string;expectedRevision:number;midyearFrom:string|null;midyearTo:string|null};
async function failure(e:unknown){
 if(e instanceof RewardError||e instanceof RewardConfigReviewError)return e.message;
 if(e instanceof Error&&/off-cycle|mid-year|year-end|Group Rewards/i.test(e.message))return e.message;
 console.error('Off-cycle settings command failed',{name:e instanceof Error?e.name:'Unknown'});
 return(await getTranslations('rewardDashboard'))('offcycle.systemError');
}
export async function previewOffcycleYearAction(input:OffcycleInput):Promise<{error:string;review?:OffcycleReview}>{
 try{return{error:'',review:await previewRewardOffcycleYearSave(await getSession(),input)};}catch(e){return{error:await failure(e)};}
}
export async function saveOffcycleYearAction(input:OffcycleInput,reason:string,summaryDigest:string):Promise<{ok:true}|{ok:false;error:string;review?:OffcycleReview}>{
 const s=await getSession();
 try{await saveRewardOffcycleYear(s,{...input,reason,summaryDigest});revalidatePath('/rewards','layout');revalidatePath('/admin/rewards','layout');return{ok:true};}
 catch(e){
  if(e instanceof RewardConfigReviewError&&e.code==='changed'){try{return{ok:false,error:e.message,review:await previewRewardOffcycleYearSave(s,input)};}catch(again){return{ok:false,error:await failure(again)};}}
  return{ok:false,error:await failure(e)};
 }
}
