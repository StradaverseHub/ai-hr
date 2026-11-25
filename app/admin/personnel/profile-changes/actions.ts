'use server';
import {getSession} from '@/lib/session';
import {decideProfileChange} from '@/core/profile';
import {rerouteProfileRequest} from '@/core/profile-routing';
import {redirect} from 'next/navigation';
import {revalidatePath} from 'next/cache';
import {getTranslations} from 'next-intl/server';
import {requestsClientNavigation,type ActionNavigation} from '@/lib/action-navigation';
const PAGE='/admin/personnel/profile-changes';
// ADR 0181 decision 4: from an <ActionNavigateForm> (components/profile-change-decide.tsx and the reassign form) the
// action returns where to go and the client re-reads the shell's approval facts, so the app frame is not drawn again.
// A plain form keeps the revalidate-and-redirect.
export async function decideProfileChangeAction(data:FormData):Promise<ActionNavigation>{
 const ctx=await getSession(),t=await getTranslations('essProfile');const client=requestsClientNavigation(data);
 try{
  const decision=data.get('decision');if(decision!=='approved'&&decision!=='rejected')throw new Error('invalid');
  await decideProfileChange(ctx,{requestId:String(data.get('requestId')??''),decision,reason:String(data.get('reason')??'')});
 }catch{const failed=`${PAGE}?error=${encodeURIComponent(t('routingDecisionFailed'))}`;if(client)return{navigate:failed};redirect(failed);}
 if(client)return{navigate:PAGE,refreshShellApprovals:true};
 revalidatePath(PAGE);revalidatePath('/me');revalidatePath('/','layout');redirect(PAGE);
}
export async function rerouteProfileChangeAction(data:FormData):Promise<ActionNavigation>{
 const ctx=await getSession(),t=await getTranslations('essProfile');const client=requestsClientNavigation(data);
 try{await rerouteProfileRequest(ctx,{requestId:String(data.get('requestId')??''),reason:String(data.get('reason')??'')});}
 catch{const failed=`${PAGE}?error=${encodeURIComponent(t('routingReassignFailed'))}`;if(client)return{navigate:failed};redirect(failed);}
 if(client)return{navigate:PAGE,refreshShellApprovals:true};
 revalidatePath(PAGE);revalidatePath('/','layout');redirect(PAGE);
}
