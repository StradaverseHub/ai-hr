'use server';
import {revalidatePath} from 'next/cache';
import {getBrowserCommandSession} from '@/lib/session';
import {rewardVisibleCompanies} from '@/packs/rewards/access-policy';
import {getRewardDashboardPreference,saveRewardDashboardPreference} from '@/packs/rewards/service';
/** Saves a presentation choice for the current login; the next dashboard read re-checks its scope. */
export async function saveDashboardAction(choice:{period:string;businessUnit:string;companies:string[];year:number}){
 const ctx=await getBrowserCommandSession(),companies=await rewardVisibleCompanies(ctx);
 await saveRewardDashboardPreference(ctx,companies.map(company=>company.id),{version:2,kind:'annual',period:choice?.period,businessUnit:choice?.businessUnit,companies:choice?.companies,year:choice?.year});
 revalidatePath('/rewards');
}
/** b945f0cc: the Year-end cycle / Off-cycle switch. Keeps the rest of the saved choice; the next read re-checks scope. */
export async function saveDashboardKindAction(kind:string){
 const ctx=await getBrowserCommandSession(),companies=await rewardVisibleCompanies(ctx);
 const current=await getRewardDashboardPreference(ctx);
 const base=current&&typeof current==='object'&&!Array.isArray(current)?current as Record<string,unknown>:{};
 await saveRewardDashboardPreference(ctx,companies.map(company=>company.id),{version:2,period:'monthly',businessUnit:'',companies:[],...base,kind:kind==='offcycle'?'offcycle':'annual'});
 revalidatePath('/rewards');
}
