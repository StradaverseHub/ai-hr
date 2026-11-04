/** AI v2 W2 (slice 2) — Confirm and Edit for a Leave Credit request (time off in lieu) card prepared in chat
 * (core/proposals/toil-request.ts).
 *
 * Confirm submits only on the person's explicit Confirm (`confirm: true`), under their own login:
 *  1. the signed proposal must verify for THIS caller (signature, expiry, tenant, login and person), so a tampered,
 *     expired or someone else's proposal is refused before any read;
 *  2. the card's sealed review is reopened through the existing TOIL review custody, which re-runs the leave service's
 *     own preparation as the caller and refuses when anything it reviewed has changed;
 *  3. a person outside the First Schedule needs no agreement: the custody's own confirm re-runs every owner check in its
 *     own top-level transaction (the actor and Assistant grant, the TOIL module, the AI and per-action pauses, the
 *     company switches, eligibility, the roster day type, the Leave Credit count, the First Schedule gate) and must
 *     reproduce the reviewed digest exactly before the request is written;
 *  4. a person within the First Schedule (the leave service decided it when the card was prepared, and the sealed review
 *     records the agreement as still to be asked for) must have ticked the agreement themselves: the posted
 *     `firstScheduleConsent` must be exactly `true`, or nothing is written. Only then is the review prepared again with
 *     their agreement, its lines and credit compared with what the card showed (any difference refuses), and confirmed;
 *     the card's own review, which can never be confirmed, is retired. Neither the proposal nor the model can carry the
 *     agreement: it is read only from the person's post.
 * The request goes to the existing approval; nothing is credited here. Errors are bounded to a refusal code; no source
 * detail, private text or SQL parameter escapes. No model call. */
import type {SessionContext} from '../../db/client';
import {withAgentActionPauseScope} from '../agent-action-pause-scope';
import {TOIL_REQUEST_ACTION,toilEditHref,toilReviewConfirmation,type ToilEditResult,type ToilProposalRefusal} from '../proposals/toil-request';
import {toilRequestReviews} from './toil-request-review-store';
import type {OwnToilReplacementHumanContent} from '../../lib/assistant-actions/own-toil-replacement-contract';

export type ToilRequestConfirmResult=Readonly<{kind:'submitted';action:string;requestId:string}>
 |Readonly<{kind:'refused';reason:ToilProposalRefusal|'not_confirmed'|'consent_required'|'changed'|'unavailable'|'retired'}>;

const refused=(reason:Extract<ToilRequestConfirmResult,{kind:'refused'}>['reason']):ToilRequestConfirmResult=>Object.freeze({kind:'refused' as const,reason});
const submitted=(requestId:string):ToilRequestConfirmResult=>Object.freeze({kind:'submitted' as const,action:TOIL_REQUEST_ACTION,requestId});
const capture=(ctx:SessionContext):SessionContext=>({...ctx,roles:ctx.roles?.slice(),grants:ctx.grants?.map(grant=>({...grant}))});
type Review=Extract<Awaited<ReturnType<typeof toilRequestReviews.prepare>>,{kind:'prepared'}>['review'];
/** What the person was shown and what is written, apart from the agreement itself. */
const reviewed=(review:Review)=>{const {firstScheduleConsent,...rest}=review.review;void firstScheduleConsent;return JSON.stringify(rest);};

export async function confirmToilRequestProposal(supplied:SessionContext,input:Readonly<{proposal:unknown;confirm:unknown;firstScheduleConsent?:unknown}>,now:Date=new Date()):Promise<ToilRequestConfirmResult>{
 const ctx=capture(supplied);
 // Only the person's explicit Confirm submits; anything else (absent, "true", 1) is not a confirmation.
 if(input.confirm!==true)return refused('not_confirmed');
 // The person's own tick, read from their post and nowhere else. Anything but exactly true is no agreement.
 const agreed=input.firstScheduleConsent===true;
 let named:ReturnType<typeof toilReviewConfirmation>;
 // Proposals fail closed without their configured secret (ProposalUnavailable): nothing is submitted.
 try{named=toilReviewConfirmation(input.proposal,ctx,now);}catch{return refused('unavailable');}
 if(!named.ok)return refused(named.reason);
 const card=named;
 try{
  // Each custody command owns its top-level transaction: never wrapped in another one here.
  return await withAgentActionPauseScope(TOIL_REQUEST_ACTION,async()=>{
   const held=await toilRequestReviews.reopen(ctx,card.actionId);
   // Confirmed already (a second press, or a lost reply): the same receipt, never a second request.
   if(held.kind==='completed')return submitted(held.receipt.receipt.requestId);
   if(held.kind!=='prepared')return refused('retired');
   const review=held.review;
   if(review.reviewedDigest!==card.reviewedDigest)return refused('changed');
   const agreementAsked=review.content.firstScheduleConsentPending===true;
   if(agreementAsked!==card.agreementAsked||review.review.totalDays!==card.creditDays)return refused('changed');
   if(!agreementAsked){
    const result=await toilRequestReviews.confirm(ctx,{actionId:card.actionId,reviewedDigest:card.reviewedDigest});
    return result.kind==='completed'?submitted(result.receipt.receipt.requestId):refused('retired');
   }
   // Within the First Schedule: nothing is written without the person's own agreement.
   if(!agreed)return refused('consent_required');
   const withAgreement:OwnToilReplacementHumanContent=structuredClone(review.content);
   delete withAgreement.firstScheduleConsentPending;withAgreement.firstScheduleConsent=true;
   const again=await toilRequestReviews.prepare(ctx,withAgreement);
   if(again.kind!=='prepared')return refused('unavailable');
   const fresh=again.review;
   // Exactly what the card showed (the date, the window, the day type, the leave service's credit), or nothing.
   if(fresh.review.firstScheduleConsent!==true||reviewed(fresh)!==reviewed(review)||fresh.review.totalDays!==card.creditDays){
    await toilRequestReviews.discard(ctx,{actionId:fresh.actionId}).catch(()=>undefined);
    return refused('changed');
   }
   const result=await toilRequestReviews.confirm(ctx,{actionId:fresh.actionId,reviewedDigest:fresh.reviewedDigest});
   if(result.kind!=='completed')return refused('retired');
   // The card's own review recorded no agreement and can never be confirmed; it is retired, not left waiting.
   await toilRequestReviews.discard(ctx,{actionId:card.actionId}).catch(()=>undefined);
   return submitted(result.receipt.receipt.requestId);
  });
 }catch{return refused('unavailable');}
}

/** Edit: the Leave Credit request dialog on My Leave for a verified card, prefilled and validated as the caller. */
export async function editToilRequestProposal(supplied:SessionContext,proposal:unknown,now:Date=new Date()):Promise<ToilEditResult>{
 try{return await toilEditHref(capture(supplied),proposal,now);}catch{return Object.freeze({ok:false as const,reason:'unavailable' as const});}
}
