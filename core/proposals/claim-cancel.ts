/** AI v2 W2 — `claims.cancel` from chat: one of the caller's own PENDING claims, prepared for one Confirm.
 *
 * The claims owner decides what may be cancelled: only a pending claim, through the native cancellation (its row lock,
 * state machine and event). Drafts are deleted on Claims itself; approved, paid or rejected claims are final here. The
 * model may nominate the date incurred (the inline-card selector, `incurredOn?`); the caller's own pending claims come
 * from the cancellation owner's own choices (readClaimCancellationChoices), never from what the model says. One match
 * saves a sealed cancellation review (the existing claims.cancel custody) and issues a signed proposal; several are
 * returned numbered, with type, date and amount, for one question; two on the same date are left to the review page,
 * which lists them. Nothing is cancelled here. */
import type {SessionContext} from '../../db/client';
import {OWN_CLAIM_CANCELLATION_ACTION} from '../../lib/assistant-actions/own-claim-cancellation-contract';
import {prepareClaimCancellationReview,readClaimCancellationChoices} from '../assistant-actions/claim-cancellation-review-store';
import {SEMANTIC_ACTIONS} from '../semantic-model/entities';
import {MAX_CLAIM_OPTIONS,type ClaimOption,type OwnChangeOutcome} from './claim-submit';
import {isCalendarDate} from './leave-apply';
import {assertProposalsConfigured,issueProposal} from './proposal';

export const CLAIM_CANCEL_ROUTE='/assistant/claims' as const;
export const CLAIM_CANCEL_ASK_NOTE='More than one of the person\'s pending claims could be meant (listed in options, numbered, with type, date and amount). Nothing is prepared. List them and ask which one to cancel; when they say which, suggest again with that claim\'s incurredOn date. Never choose one yourself.';
const declared=SEMANTIC_ACTIONS.find(action=>action.id===OWN_CLAIM_CANCELLATION_ACTION)!;

export async function prepareChatClaimCancelProposal(ctx:SessionContext,details:Readonly<Record<string,unknown>>):Promise<OwnChangeOutcome|null>{
 const choices=await readClaimCancellationChoices(ctx);
 if(choices.kind!=='choices'||!choices.claims.length||!ctx.userId||!ctx.personId)return null;
 const date=isCalendarDate(details.incurredOn)?details.incurredOn:null;
 const dated=date===null?choices.claims:choices.claims.filter(row=>row.incurredOn===date);
 const candidates=dated.length?dated:choices.claims;
 if(candidates.length!==1||dated.length===0){
  // Choosing comes back as a date, so a choice between two claims of one date is the review page's to make.
  if(new Set(candidates.map(row=>row.incurredOn)).size!==candidates.length)return null;
  const options:ClaimOption[]=candidates.slice(0,MAX_CLAIM_OPTIONS).map((row,index)=>Object.freeze({option:index+1,claimType:row.claimTypeName.slice(0,64),incurredOn:row.incurredOn,amount:row.amount}));
  return Object.freeze({kind:'ask' as const,missing:Object.freeze(['claim']),options:Object.freeze(options),note:CLAIM_CANCEL_ASK_NOTE});
 }
 const claim=candidates[0];
 assertProposalsConfigured();
 const prepared=await prepareClaimCancellationReview(ctx,{action:OWN_CLAIM_CANCELLATION_ACTION,contractVersion:1,employmentId:claim.employmentId,claimId:claim.claimId,cancel:true});
 if(prepared.kind!=='prepared')return null;
 const review=prepared.review;
 if(review.content.claimId!==claim.claimId||review.review.status!=='pending')return null;
 return Object.freeze({kind:'proposal' as const,proposal:issueProposal({
  what:{action:OWN_CLAIM_CANCELLATION_ACTION,contractVersion:1,entity:declared.entity,effect:declared.effect,selectors:{incurredOn:review.review.incurredOn},reviewedDigest:review.reviewedDigest},
  forWhom:{tenantId:ctx.tenantId,subject:'own_employment',subjectId:review.content.employmentId},
  authority:{kind:'person',tenantId:ctx.tenantId,userId:ctx.userId,personId:ctx.personId},
  checks:declared.checks.map(check=>({check:check.check,owner:check.owner,ruleVersion:null,result:'pass' as const})),
  review:{route:CLAIM_CANCEL_ROUTE,href:`${CLAIM_CANCEL_ROUTE}?flow=cancel&review=${review.actionId}`,reference:review.actionId},
  facts:{claimType:review.review.claimTypeName.slice(0,64),incurredOn:review.review.incurredOn,amount:review.review.amount,outcome:'claim_cancelled_now'},
  createdAt:review.createdAt,expiresAt:review.expiresAt})});
}
