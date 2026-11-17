'use server';
import {getSession} from '@/lib/session';
import {rewardReviewPublicError} from '@/packs/rewards/review-errors';
import {previewRewardPersonHistoryImport,importRewardPersonHistory,rewardPersonHistoryImportProgress,REWARD_HISTORY_IMPORT_KIND} from '@/packs/rewards/person-history-upload';
import {requestBulkJobCancel} from '@/core/bulk-job';
import {revalidatePath} from 'next/cache';
export async function previewHistoryAction(raw:unknown){try{return{ok:true as const,preview:await previewRewardPersonHistoryImport(await getSession(),raw)};}catch(error){return{ok:false as const,error:rewardReviewPublicError(error)};}}
export async function importHistoryAction(raw:unknown,token:string){try{const result=await importRewardPersonHistory(await getSession(),raw,token);return{ok:true as const,...result};}catch(error){return{ok:false as const,error:rewardReviewPublicError(error)};}}
export async function historyProgressAction(id:string){try{const progress=await rewardPersonHistoryImportProgress(await getSession(),id);if(progress.state==='completed')revalidatePath('/rewards');return{ok:true as const,progress};}catch(error){return{ok:false as const,error:rewardReviewPublicError(error)};}}
export async function stopHistoryAction(id:string){try{await requestBulkJobCancel(await getSession(),id,REWARD_HISTORY_IMPORT_KIND);return{ok:true as const};}catch(error){return{ok:false as const,error:rewardReviewPublicError(error)};}}
