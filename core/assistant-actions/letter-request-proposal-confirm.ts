/** AI v2 Phase 1, slice 3 — Confirm and Edit for an own letter request card prepared in chat
 * (core/proposals/letter-request.ts).
 *
 * Confirm submits only on the person's explicit Confirm (`confirm: true`), under their own login, in one transaction:
 *  1. the signed proposal must verify for THIS caller (signature, expiry, tenant, login and person) and name the letter
 *     request action and its own form, so a tampered, expired, foreign or retargeted proposal is refused before any read;
 *  2. the caller must still hold the AI principal (the Assistant grant) and the AI action controls must be unpaused;
 *  3. the owner's list of letter types the caller may request is read again: the card's employment and template must
 *     still be on it, with the same published name (the digest), or nothing is written;
 *  4. the owner service writes the request (core/letter-requests.ts submitLetterRequestTx), and the database checks again
 *     that the template is open for requests and the employment is the caller's own. The card's own id is the request's
 *     client key, so a second press, or a lost reply, returns the same request and never a second one.
 * The request carries no purpose and no letter content: HR prepares and issues the letter. Errors are bounded to a refusal
 * code; no source detail or SQL parameter escapes. No model call. */
import {withTenant,type SessionContext} from '../../db/client';
import {assertAiActionUnpausedTx} from '../ai-governance';
import {assertAiPrincipalTx} from '../ai-principal';
import {assertLetterRequestsAvailable,letterRequestDigest,LetterRequestError,requestableLetterTypesTx,submitLetterRequestTx} from '../letter-requests';
import {LETTER_REQUEST_ACTION,letterRequestConfirmation,letterRequestEditHref,type LetterRequestEditResult,type LetterRequestProposalRefusal} from '../proposals/letter-request';

export type LetterRequestConfirmResult=Readonly<{kind:'submitted';action:typeof LETTER_REQUEST_ACTION;requestId:string}>
 |Readonly<{kind:'refused';reason:LetterRequestProposalRefusal|'not_confirmed'|'changed'|'duplicate'|'unavailable'}>;

const refused=(reason:Extract<LetterRequestConfirmResult,{kind:'refused'}>['reason']):LetterRequestConfirmResult=>Object.freeze({kind:'refused' as const,reason});
const capture=(ctx:SessionContext):SessionContext=>({...ctx,roles:ctx.roles?.slice(),grants:ctx.grants?.map(grant=>({...grant}))});
class Changed extends Error{constructor(){super('The card no longer matches.');this.name='Changed';}}

export async function confirmLetterRequestProposal(supplied:SessionContext,input:Readonly<{proposal:unknown;confirm:unknown}>,now:Date=new Date()):Promise<LetterRequestConfirmResult>{
 const ctx=capture(supplied);
 // Only the person's explicit Confirm submits; anything else (absent, "true", 1) is not a confirmation.
 if(input.confirm!==true)return refused('not_confirmed');
 let named:ReturnType<typeof letterRequestConfirmation>;
 // Proposals fail closed without their configured secret (ProposalUnavailable): nothing is submitted.
 try{named=letterRequestConfirmation(input.proposal,ctx,now);}catch{return refused('unavailable');}
 if(!named.ok)return refused(named.reason);
 const card=named;
 try{
  assertLetterRequestsAvailable(ctx);
  const done=await withTenant(ctx,async tx=>{
   await assertAiPrincipalTx(tx,ctx);
   await assertAiActionUnpausedTx(tx,ctx,'hr_assistant');
   const offered=(await requestableLetterTypesTx(tx)).find(type=>type.templateId===card.templateId&&type.employmentId===card.employmentId);
   if(!offered||letterRequestDigest(ctx.tenantId,offered)!==card.reviewedDigest)throw new Changed();
   return submitLetterRequestTx(tx,ctx,{templateId:card.templateId,employmentId:card.employmentId,clientKey:card.cardId});
  });
  return Object.freeze({kind:'submitted' as const,action:LETTER_REQUEST_ACTION,requestId:done.requestId});
 }catch(error){
  if(error instanceof Changed)return refused('changed');
  if(error instanceof LetterRequestError)return refused(error.code==='duplicate'?'duplicate':error.code==='not_requestable'?'changed':'unavailable');
  return refused('unavailable');
 }
}

/** Edit: the request form for a verified card, with its letter type chosen, validated as the caller. */
export async function editLetterRequestProposal(supplied:SessionContext,proposal:unknown,now:Date=new Date()):Promise<LetterRequestEditResult>{
 try{return await letterRequestEditHref(capture(supplied),proposal,now);}catch{return Object.freeze({ok:false as const,reason:'unavailable' as const});}
}
