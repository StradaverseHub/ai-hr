/** Rewards configuration change summaries (board 60f1fdcd). Pure and client-safe: no database, session or pay value.
 *
 * Every Rewards configuration command computes one summary on the server, in the transaction that will apply the
 * change. A high-impact summary is shown to the editor ("Review before saving") together with its digest; the save
 * carries that digest and a reason, and the command refuses when the summary it recomputes no longer has the same
 * digest. Summaries describe configuration (company PAT, structure and matrix cells, plan bindings, access seats) and
 * the reviews a change affects. They never carry an individual's pay. */
import {createHash} from 'node:crypto';
import {z} from 'zod';

export const rewardConfigAreas=['salary','bonus','pat','plan','shared','exemption','senior','upload','preparation','access','role_permission','group_role','limit'] as const;
export type RewardConfigArea=typeof rewardConfigAreas[number];

/** One changed value: a cell, a field or a seat. Values are display text; money is formatted by the caller. */
export type RewardConfigLine={key:string;label:string;before:string|null;after:string|null};
/** A review the change reaches and what happens to it. */
export type RewardConfigAffected={reviewId:string;label:string;stage:string;consequence:RewardConfigConsequence};
export type RewardConfigConsequence='repriced'|'recalculation-required'|'keeps-version'|'released-to-bu'|'access-removed'|'none';
/** Why the change needs a reviewed summary. */
export type RewardHighImpactReason='released-pat'|'released-library'|'released-limit'|'release-review'|'remove-access';
export type RewardConfigSummary={
 area:RewardConfigArea;
 itemLabel:string;
 /** The changed values, bounded for display; changedCount is the full count. */
 lines:RewardConfigLine[];
 changedCount:number;
 affected:RewardConfigAffected[];
 highImpact:RewardHighImpactReason[];
};
export const REWARD_CONFIG_LINE_LIMIT=200;
export const REWARD_CONFIG_AFFECTED_LIMIT=200;

export class RewardConfigReviewError extends Error{
 constructor(public code:'reason'|'changed'|'unchanged',message:string){super(message);this.name='RewardConfigReviewError';}
}

/** Canonical JSON: object keys sorted, so the digest depends only on content. */
function canonical(value:unknown):unknown{
 if(Array.isArray(value))return value.map(canonical);
 if(value&&typeof value==='object')return Object.fromEntries(Object.keys(value as Record<string,unknown>).sort().map(key=>[key,canonical((value as Record<string,unknown>)[key])]));
 return value;
}
export function rewardConfigSummaryDigest(summary:RewardConfigSummary):string{
 return createHash('sha256').update(JSON.stringify(canonical(summary))).digest('hex');
}

/** Build a bounded summary; lines and affected reviews keep a stable order. */
export function rewardConfigSummary(input:{area:RewardConfigArea;itemLabel:string;lines:readonly RewardConfigLine[];affected?:readonly RewardConfigAffected[];highImpact?:readonly RewardHighImpactReason[]}):RewardConfigSummary{
 const lines=[...input.lines].sort((a,b)=>a.key.localeCompare(b.key));
 const affected=[...(input.affected??[])].sort((a,b)=>a.label.localeCompare(b.label)||a.reviewId.localeCompare(b.reviewId));
 return{area:input.area,itemLabel:input.itemLabel,lines:lines.slice(0,REWARD_CONFIG_LINE_LIMIT),changedCount:lines.length,
  affected:affected.slice(0,REWARD_CONFIG_AFFECTED_LIMIT),highImpact:[...new Set(input.highImpact??[])].sort()};
}

/** Lines for the values that differ between two flat records of display values. */
export function rewardConfigLines(before:Readonly<Record<string,string|null>>|null,after:Readonly<Record<string,string|null>>,label:(key:string)=>string):RewardConfigLine[]{
 return Object.keys({...(before??{}),...after}).sort().flatMap(key=>{
  const old=before?.[key]??null,next=after[key]??null;
  return old===next?[]:[{key,label:label(key),before:old,after:next}];
 });
}

export const rewardConfigReason=z.string().trim().min(10).max(4000);
export const rewardConfigDigest=z.string().regex(/^[a-f0-9]{64}$/);

/** The save-side check every command runs on its freshly recomputed summary. Every save needs a reason (the
 * versions it writes already require one); a high-impact save must also carry the digest the editor reviewed. */
export function assertRewardConfigReviewed(summary:RewardConfigSummary,input:{reason:string;digest?:string|null}){
 const reason=rewardConfigReason.safeParse(input.reason);
 if(!reason.success)throw new RewardConfigReviewError('reason','Give a reason of at least 10 characters.');
 if(summary.highImpact.length){
  if(!input.digest||input.digest!==rewardConfigSummaryDigest(summary))throw new RewardConfigReviewError('changed','This changed. Review the summary again.');
 }
 return reason.data;
}

/** Bounded money text for summaries: configuration amounts, never an individual's pay. */
export const rewardConfigMoney=(cents:number|null|undefined)=>cents===null||cents===undefined?null:(cents/100).toFixed(2);
export const rewardConfigMonths=(bp:number|null|undefined)=>bp===null||bp===undefined?null:(bp/10000).toFixed(2);
