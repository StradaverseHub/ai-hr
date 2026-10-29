import type {RewardPolicy} from './model';
/** Shared configuration no longer owns unit inputs. Redact legacy values in DTOs, never rewrite stored versions. */
export function sharedRewardPolicyProjection(policy:RewardPolicy):RewardPolicy{
 const {unitGovernanceDigest:_unitDigest,...group}=policy as RewardPolicy&{unitGovernanceDigest?:string};
 return {...group,patActual:0,patTarget:100,targetMonthsBp:0,multiplierBp:null,branchRatings:{},exemptReason:'',lumpUnitCents:null};
}
