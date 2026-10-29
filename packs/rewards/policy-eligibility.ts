import type {RewardPolicy} from './model';
/** Safe effective policy facts, shared with every policy-summary consumer; never PAT or employee pay. */
export type RewardEligibilitySummary={activeAsOf:string|null;joinedBefore:string;confirmedBy:string;effectiveFrom:string;blockedFrom:string;blockedTo:string;minimumBonusRating:'UA'|'BE'|'ME'|'AE'|'OU'|null;excludeNotice:boolean;excludeErCase:boolean;seniorMembershipMode:'legacy-grades'|'named-members';legacyDefaults:boolean};
export function rewardEligibilitySummary(policy:RewardPolicy):RewardEligibilitySummary{
 const p=policy as RewardPolicy&{activeAsOf?:string;minimumBonusRating?:RewardEligibilitySummary['minimumBonusRating'];excludeNotice?:boolean;excludeErCase?:boolean};
 return {activeAsOf:p.activeAsOf??null,joinedBefore:p.joinedBefore,confirmedBy:p.confirmedBy,effectiveFrom:p.effectiveFrom,blockedFrom:p.blockedFrom,blockedTo:p.blockedTo,minimumBonusRating:p.minimumBonusRating??null,excludeNotice:p.excludeNotice??true,excludeErCase:p.excludeErCase??true,seniorMembershipMode:p.seniorMembershipMode??'legacy-grades',legacyDefaults:p.activeAsOf===undefined||p.minimumBonusRating===undefined||p.excludeNotice===undefined||p.excludeErCase===undefined};
}
