'use server';
import {redirect} from 'next/navigation';
import {revalidatePath} from 'next/cache';
import {getBrowserCommandSession} from '@/lib/session';
import {rewardVisibleCompanies} from '@/packs/rewards/access-policy';
import {saveRewardDashboardPreference} from '@/packs/rewards/service';
export async function saveDashboardAction(form:FormData){
 const ctx=await getBrowserCommandSession(),companies=await rewardVisibleCompanies(ctx);
 await saveRewardDashboardPreference(ctx,companies.map(company=>company.id),{scope:String(form.get('scope')??''),period:String(form.get('period')??'monthly')});
 revalidatePath('/rewards');redirect('/rewards');
}
