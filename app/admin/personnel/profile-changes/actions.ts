'use server';
import {getSession} from '@/lib/session';
import {decideProfileChange} from '@/core/profile';
import {rerouteProfileRequest} from '@/core/profile-routing';
import {redirect} from 'next/navigation';
import {revalidatePath} from 'next/cache';
import {getTranslations} from 'next-intl/server';
const PAGE='/admin/personnel/profile-changes';
export async function decideProfileChangeAction(data:FormData){
 const ctx=await getSession(),t=await getTranslations('essProfile');
 try{
  const decision=data.get('decision');if(decision!=='approved'&&decision!=='rejected')throw new Error('invalid');
  await decideProfileChange(ctx,{requestId:String(data.get('requestId')??''),decision,reason:String(data.get('reason')??'')});
 }catch{redirect(`${PAGE}?error=${encodeURIComponent(t('routingDecisionFailed'))}`);}
 revalidatePath(PAGE);revalidatePath('/me');revalidatePath('/','layout');redirect(PAGE);
}
export async function rerouteProfileChangeAction(data:FormData){
 const ctx=await getSession(),t=await getTranslations('essProfile');
 try{await rerouteProfileRequest(ctx,{requestId:String(data.get('requestId')??''),reason:String(data.get('reason')??'')});}
 catch{redirect(`${PAGE}?error=${encodeURIComponent(t('routingReassignFailed'))}`);}
 revalidatePath(PAGE);revalidatePath('/','layout');redirect(PAGE);
}
