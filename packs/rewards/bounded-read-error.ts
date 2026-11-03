import {pgErrorChain} from '../../lib/db-error';

// Only fixed messages owned by the bounded read functions can become domain copy. The
// Drizzle query/parameters and arbitrary PostgreSQL error text remain database errors.
const messages=new Set([
 'Reward unit not found or access has been removed.',
 'Ask an administrator to assign your Reward Desk role for this unit.',
 'Group Rewards membership access is required.',
 'Senior plan evidence is restricted.',
 'Evidence is not available.',
 'Reward review function unavailable',
 'Rewards configuration requires company administrator or Group Rewards access.',
 'Rewards configuration unavailable',
]);
export function boundedRewardReadFailure(error:unknown,RewardError:new(message:string)=>Error):unknown {
 const refusal=pgErrorChain(error).find(link=>link.code==='42501'&&typeof link.message==='string'&&messages.has(link.message));
 if(!refusal?.message)return error;
 return new RewardError(refusal.message);
}
