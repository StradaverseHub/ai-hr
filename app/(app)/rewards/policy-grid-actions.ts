'use server';
import {z} from 'zod';
import {getSession} from '@/lib/session';
import {listRewardPolicyGroups} from '@/packs/rewards/service';
/** Only already-authorised complete-scope versions are candidates; no PAT, employees or pay leave this boundary. */
export async function loadPreviousRewardPolicyMatrices(year:number){
 const target=z.number().int().min(2001).max(2200).parse(year),session=await getSession();
 const groups=await listRewardPolicyGroups(session);
 return groups.filter(group=>group.policy.year===target-1).map(group=>({id:group.versionId,name:group.name,revision:group.revision,year:group.policy.year,ranges:group.policy.ranges,bonusMatrix:group.policy.bonusMatrix,branchFactors:group.policy.branchFactors}));
}
