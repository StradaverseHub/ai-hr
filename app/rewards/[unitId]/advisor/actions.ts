'use server';
import {getSession} from '@/lib/session';
import {generateRewardAdvisor,decideRewardAdvisor,saveRewardAdvisorSettings} from '@/packs/rewards/advisor';
import {revalidatePath} from 'next/cache';
import {redirect} from 'next/navigation';
export async function advisorAction(fd:FormData){const id=String(fd.get('unitId'));let error='';try{const ctx=await getSession();if(fd.get('action')==='generate')await generateRewardAdvisor(ctx,id,String(fd.get('entryId')));else if(fd.get('action')==='settings')await saveRewardAdvisorSettings(ctx,id,{enabled:fd.get('enabled')==='on',overrideThresholdBp:Number(fd.get('overrideThresholdBp')),longWithoutIncreaseYears:Number(fd.get('longWithoutIncreaseYears')),equityGapBp:Number(fd.get('equityGapBp')),fairnessGapBp:Number(fd.get('fairnessGapBp'))});else await decideRewardAdvisor(ctx,id,String(fd.get('suggestionId')),{action:fd.get('action'),reason:String(fd.get('reason')??'')});revalidatePath(`/rewards/${id}`);}catch(e){error=e instanceof Error?e.message:'Unable to save.';}redirect(`/rewards/${encodeURIComponent(id)}/advisor${error?'?error='+encodeURIComponent(error):''}`);}
