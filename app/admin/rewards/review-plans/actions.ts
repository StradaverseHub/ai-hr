'use server';
import {revalidatePath} from 'next/cache';
import {getTranslations} from 'next-intl/server';
import {getSession} from '@/lib/session';
import {requireModule} from '@/lib/authz';
import {previewRewardYear,createRewardYear,previewRewardPlanGrid,saveRewardPlanGrid,enqueueRewardPlanReviews,rewardPreviousPlanChoices,rewardPlanBulkEdits} from '@/packs/rewards/review-plans';
import type {RewardYearInput,RewardPlanGridInput} from '@/packs/rewards/review-plans-model';
import {RewardSetupError} from '@/packs/rewards/setup-model';

async function session(){const s=await getSession();await requireModule('rewards',s);return s;}
async function errorMessage(error:unknown){return error instanceof RewardSetupError?error.message:(await getTranslations('rewardsReviewPlans'))('saveFailed');}
function refresh(){revalidatePath('/admin/rewards','layout');revalidatePath('/rewards','layout');}
export async function previewYearAction(input:RewardYearInput){try{return{ok:true as const,review:await previewRewardYear(await session(),input)};}catch(error){return{ok:false as const,error:await errorMessage(error)};}}
export async function createYearAction(input:RewardYearInput,digest:string,reason:string){try{await createRewardYear(await session(),input,digest,reason);refresh();return{ok:true as const};}catch(error){return{ok:false as const,error:await errorMessage(error)};}}
export async function previewGridAction(input:RewardPlanGridInput){try{return{ok:true as const,review:await previewRewardPlanGrid(await session(),input)};}catch(error){return{ok:false as const,error:await errorMessage(error)};}}
export async function saveGridAction(input:RewardPlanGridInput,digest:string,reason:string){try{await saveRewardPlanGrid(await session(),input,digest,reason);refresh();return{ok:true as const};}catch(error){return{ok:false as const,error:await errorMessage(error)};}}
export async function previousChoicesAction(year:number){try{return{ok:true as const,edits:await rewardPreviousPlanChoices(await session(),year)};}catch(error){return{ok:false as const,error:await errorMessage(error)};}}
export async function createReviewsAction(year:number,companyIds?:string[]){try{const result=await enqueueRewardPlanReviews(await session(),{year,companyIds});refresh();return{ok:true as const,...result};}catch(error){return{ok:false as const,error:await errorMessage(error)};}}
export async function reviewJobAction(id:string){try{const {readBulkJob,bulkJobProgress}=await import('@/core/bulk-job');return{ok:true as const,progress:bulkJobProgress(await readBulkJob(await session(),id))};}catch(error){return{ok:false as const,error:await errorMessage(error)};}}

export async function acceptSuggestionsAction(year:number){try{return{ok:true as const,edits:await rewardPlanBulkEdits(await session(),{year,operation:'accept-suggestions'})};}catch(error){return{ok:false as const,error:await errorMessage(error)};}}
/** The moved designation control retains its native company-administrator authority. */
export async function classifyCompanyAction(form:FormData):Promise<{ok:boolean}>{try{if(form.get('verified')!=='on')return{ok:false};const {classifyRewardCompany}=await import('@/packs/rewards/company-classification');await classifyRewardCompany(await session(),{companyId:form.get('companyId'),disposition:form.get('disposition'),canonicalCompanyId:form.get('canonicalCompanyId')||null,reason:form.get('reason')});refresh();return{ok:true};}catch{return{ok:false};}}
