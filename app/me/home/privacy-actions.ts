'use server';

import {revalidatePath} from 'next/cache';
import {redirect,unstable_rethrow} from 'next/navigation';
import {getSession} from '@/lib/session';
import {saveOwnHomePersonPrivacy,HomePersonPrivacyAccessError,HomePersonPrivacyChangedError} from '@/core/employee-home-person-privacy';
import {parseHomePersonPrivacyForm,HomePersonPrivacyInputError} from '@/lib/employee-home-person-privacy';

export type HomePersonPrivacySaveState={error:null|'invalid'|'forbidden'|'changed'|'failed'};
export async function saveHomePersonPrivacyAction(_state:HomePersonPrivacySaveState,data:FormData):Promise<HomePersonPrivacySaveState>{
 let input:ReturnType<typeof parseHomePersonPrivacyForm>;
 try{input=parseHomePersonPrivacyForm(data);}catch{return {error:'invalid'};}
 const s=await getSession();
 try{await saveOwnHomePersonPrivacy(s,input);}
 catch(error){
  unstable_rethrow(error);
  return {error:error instanceof HomePersonPrivacyAccessError?'forbidden':error instanceof HomePersonPrivacyChangedError?'changed':error instanceof HomePersonPrivacyInputError?'invalid':'failed'};
 }
 revalidatePath('/me/home');revalidatePath('/');revalidatePath('/me/calendar');
 redirect('/me/home?privacySaved=1');
}
