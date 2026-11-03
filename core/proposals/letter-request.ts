/** AI v2 Phase 1, slice 3 — the caller's own letter request ("I need an employment confirmation letter"), prepared from
 * chat as a signed proposal for one Confirm.
 *
 * The model only nominates the letter type in the person's words (`letterType`), or the number of a listed option the
 * person chose. Everything else comes from the owner, and nothing here writes a request:
 *  - which letter types the person may request, for which of their own current employments, is the owner's own read
 *    (core/letter-requests.ts listRequestableLetterTypes: the templates their company opened for employee requests and
 *    has published). A type the model names resolves only against that list; unclear or missing is asked for in one
 *    question with the types numbered, never guessed;
 *  - the card carries the type's published name and what confirming does (HR prepares and issues the letter). The digest
 *    binds the caller's employment, the template and that name now; Confirm reads the list again and refuses any change
 *    (core/assistant-actions/letter-request-proposal-confirm.ts).
 * The AI never writes letter content, a purpose or any figure: the card submits no purpose (Edit opens the request form,
 * where the person may add their own). The proposal is never shown to the model. Not yet offered by suggest_action: the
 * action is not in the agent action registry (lib/ai/agent-action-registry.ts), whose entries need a review custody; until
 * it is registered the preparer is reached only by its own callers and tests. */
import type {SessionContext} from '../../db/client';
import {letterRequestDigest,listRequestableLetterTypes,type RequestableLetterType} from '../letter-requests';
import {issueProposal,verifyProposal,type Proposal,type ProposalRefusal} from './proposal';
import {squashWords} from './own-words';

export const LETTER_REQUEST_ACTION='letters.request.submit' as const;
const CONTRACT_VERSION=1 as const;
/** My Letters, whose "Request a letter" form (app/me/letters/page.tsx, `?request=1`) the card's Confirm stands in for and
 * Edit opens. */
export const LETTER_REQUEST_FORM_ROUTE='/me/letters' as const;
/** A card is good for ten minutes, as the review custodies' cards are. */
const CARD_MINUTES=10;
export const LETTER_REQUEST_DETAILS=['letterType'] as const;
export type LetterRequestDetail=typeof LETTER_REQUEST_DETAILS[number];
export const LETTER_REQUEST_ASK_NOTE='Which letter the person wants is missing or unclear (listed in missing). Nothing is prepared. Ask one short question; when options are listed, show them numbered as given and ask for the number. Never guess a letter type, and never write letter content.';
/** One numbered letter type the person may request, in the owner's fixed order. */
export type LetterRequestOption=Readonly<{option:number;letterType:string}>;
export type LetterRequestChatOutcome=Readonly<{kind:'proposal';proposal:Proposal}>
 |Readonly<{kind:'ask';missing:readonly LetterRequestDetail[];options:readonly LetterRequestOption[];note:string}>;

const capture=(ctx:SessionContext):SessionContext=>({...ctx,roles:ctx.roles?.slice(),grants:ctx.grants?.map(grant=>({...grant}))});
/** Words that do not tell letter types apart. */
const FILLER=new Set(['a','an','the','my','me','i','of','for','to','need','want','get','please','letter','letters','surat','request','pengesahan']);
const tokens=(value:string)=>squashWords(value).split(/[^\p{L}\p{N}\p{M}]+/u).filter(word=>word.length>1&&!FILLER.has(word));
const label=(type:RequestableLetterType,several:boolean)=>(several?`${type.name} (${type.companyName})`:type.name).slice(0,64);

/** The one type the words name: the same name; or the only name containing every distinguishing word given; or, for a
 * number, the option at that place when the person's own words say that number. Anything else is unclear (null). */
export function matchLetterType(types:readonly RequestableLetterType[],given:string,personWords:string|undefined):RequestableLetterType|null{
 const asked=given.trim();if(!asked)return null;
 if(/^\d{1,2}$/.test(asked)){
  const number=Number(asked);
  return typeof personWords==='string'&&new RegExp(`(?<![\\d.])${number}(?![\\d.])`).test(personWords)&&number>=1&&number<=types.length?types[number-1]:null;
 }
 const same=types.filter(type=>squashWords(type.name)===squashWords(asked));
 if(same.length===1)return same[0];
 const wanted=tokens(asked);if(!wanted.length)return null;
 const containing=types.filter(type=>{const have=new Set(tokens(type.name));return wanted.every(word=>have.has(word));});
 return containing.length===1?containing[0]:null;
}

/** A letter request for the caller's own employment, from a chat turn. `details`: letterType (the person's words for the
 * letter, or the number they chose). Null when the caller may request no letter here at all (the suggestion stays a
 * pointer to the request form) or anything fails. Never throws. */
export async function prepareChatLetterRequestProposal(supplied:SessionContext,details:Readonly<Record<string,unknown>>,personWords:string|undefined,now:Date=new Date()):Promise<LetterRequestChatOutcome|null>{
 const ctx=capture(supplied);
 try{
  const userId=ctx.userId,personId=ctx.personId;if(!userId||!personId)return null;
  const types=await listRequestableLetterTypes(ctx);if(!types.length)return null;
  const given=typeof details.letterType==='string'?details.letterType:typeof details.type==='string'?details.type:'';
  const chosen=matchLetterType(types,given,personWords);
  const several=new Set(types.map(type=>type.companyId)).size>1;
  if(!chosen)return Object.freeze({kind:'ask' as const,missing:Object.freeze(['letterType'] as const),note:LETTER_REQUEST_ASK_NOTE,
   options:Object.freeze(types.map((type,index)=>Object.freeze({option:index+1,letterType:label(type,several)})))});
  const createdAt=new Date(now.getTime()),expiresAt=new Date(now.getTime()+CARD_MINUTES*60_000);
  return Object.freeze({kind:'proposal' as const,proposal:issueProposal({
   what:{action:LETTER_REQUEST_ACTION,contractVersion:CONTRACT_VERSION,entity:'letter_request',effect:'create',selectors:{},reviewedDigest:letterRequestDigest(ctx.tenantId,chosen)},
   forWhom:{tenantId:ctx.tenantId,subject:'own_employment',subjectId:chosen.employmentId},
   authority:{kind:'person',tenantId:ctx.tenantId,userId,personId},
   checks:[{check:'letter_type_open_for_requests',owner:'core/letter-requests.ts#listRequestableLetterTypes',ruleVersion:null,result:'pass'}],
   // The request form takes the template; the card's own id makes a repeated Confirm the same request.
   review:{route:LETTER_REQUEST_FORM_ROUTE,href:LETTER_REQUEST_FORM_ROUTE,reference:chosen.templateId},
   facts:{...(chosen.name.length<=64?{letterType:chosen.name}:{}),outcome:'letter_requested_hr_prepares'},
   createdAt:createdAt.toISOString(),expiresAt:expiresAt.toISOString()})});
 }catch{return null;}
}

export type LetterRequestProposalRefusal=ProposalRefusal|'wrong_action';
/** What a verified letter request card names, for the current caller only. */
export function letterRequestConfirmation(value:unknown,caller:SessionContext,now:Date):Readonly<{ok:true;templateId:string;employmentId:string;reviewedDigest:string;cardId:string}>
 |Readonly<{ok:false;reason:LetterRequestProposalRefusal}>{
 const verified=verifyProposal(value,caller,now);
 if(!verified.ok)return verified;
 const {id,what,review,forWhom}=verified.proposal.body;
 if(what.action!==LETTER_REQUEST_ACTION||what.contractVersion!==CONTRACT_VERSION||what.entity!=='letter_request'||what.effect!=='create'
  ||review.route!==LETTER_REQUEST_FORM_ROUTE||forWhom.subject!=='own_employment')return{ok:false,reason:'wrong_action'};
 return Object.freeze({ok:true as const,templateId:review.reference,employmentId:forWhom.subjectId,reviewedDigest:what.reviewedDigest,cardId:id});
}

export type LetterRequestEditResult=Readonly<{ok:true;href:string}>|Readonly<{ok:false;reason:LetterRequestProposalRefusal|'unavailable'}>;
/** Edit: the request form, with the card's letter type chosen, after checking again as the caller that they may still
 * request it. The link carries the template only; the person adds any purpose and sends it themselves. */
export async function letterRequestEditHref(caller:SessionContext,value:unknown,now:Date=new Date()):Promise<LetterRequestEditResult>{
 const named=letterRequestConfirmation(value,caller,now);
 if(!named.ok)return named;
 let types:readonly RequestableLetterType[];
 try{types=await listRequestableLetterTypes(capture(caller));}catch{return{ok:false,reason:'unavailable'};}
 if(!types.some(type=>type.templateId===named.templateId&&type.employmentId===named.employmentId))return{ok:false,reason:'unavailable'};
 return{ok:true,href:LETTER_REQUEST_FORM_ROUTE+'?'+new URLSearchParams({request:'1',template:named.templateId}).toString()+'#request-letter'};
}
