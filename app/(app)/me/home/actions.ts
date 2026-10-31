'use server';

import {sql} from 'drizzle-orm';
import {revalidatePath} from 'next/cache';
import {redirect,unstable_rethrow} from 'next/navigation';
import {getSession} from '@/lib/session';
import {withTenant} from '@/db/client';
import {setLocale} from '@/app/i18n-actions';
import {listEmployeeHomeCards} from '@/core/dashboard-card-config';
import {setEmployeeHomePreferences,resetEmployeeHomePreferences} from '@/core/dashboard-prefs';
import {HomeConfigurationError} from '@/lib/employee-home';
import {parseHomePreferenceForm} from '@/lib/employee-home-preferences-form';

export type HomePreferenceSaveState={error:null|'invalid'|'forbidden'|'failed'};
export async function saveHomePreferencesAction(_state:HomePreferenceSaveState,data:FormData):Promise<HomePreferenceSaveState>{
 let parsed:ReturnType<typeof parseHomePreferenceForm>;
 try{parsed=parseHomePreferenceForm(data);}catch{return {error:'invalid'};}
 const s=await getSession();
 try{
  const [proof]=await withTenant(s,tx=>tx.execute(sql`SELECT app.principal_snapshot_current() AS ok`)) as unknown as {ok:boolean}[];
  if(!s.userId||!proof?.ok)return {error:'forbidden'};
  if(parsed.command==='reset')await resetEmployeeHomePreferences(s);
  else{
   // Re-read HR's catalogue at submit time; a rendered or posted choice grants no card access.
   await setEmployeeHomePreferences(s,parsed.preferences,await listEmployeeHomeCards(s));
   const locale=new FormData();locale.set('locale',parsed.locale);await setLocale(locale);
  }
 }catch(error){unstable_rethrow(error);return {error:error instanceof HomeConfigurationError?'invalid':'failed'};}
 revalidatePath('/me/home');revalidatePath('/');
 // Cookie changes refresh the Server Component tree. The successful destination must travel with
 // this action response, before a refreshed editor can replace client-side confirmation state.
 redirect('/me/home?saved=1');
}
