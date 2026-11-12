'use server';
import {revalidatePath} from 'next/cache';
import {getBrowserCommandSession} from '@/lib/session';
import {rewardVisibleCompanies} from '@/packs/rewards/access-policy';
import {saveRewardDashboardPreference} from '@/packs/rewards/service';
/** Saves a presentation choice for the current login; the next dashboard read re-checks its scope. */
export async function saveDashboardAction(choice:{period:string;businessUnit:string;companies:string[]}){
 const ctx=await getBrowserCommandSession(),companies=await rewardVisibleCompanies(ctx);
 await saveRewardDashboardPreference(ctx,companies.map(company=>company.id),{version:2,kind:'annual',period:choice?.period,businessUnit:choice?.businessUnit,companies:choice?.companies});
 revalidatePath('/rewards');
}
