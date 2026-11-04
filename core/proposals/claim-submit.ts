/** AI v2 W2 — `claims.submit` from chat: a new own expense claim, prepared for one Confirm.
 *
 * Prepare (in the chat turn, as the caller): the model names a claim type (and item), the date incurred, the amount and
 * at most a description. The type and item resolve only against the caller's own claim choices (the claims owner's own
 * catalogue, read through readClaimModuleActionChoices); the amount and the description count only when the person's
 * own words this turn state them. Missing or unclear details are asked for in one question, with the types or items
 * numbered when that is what is unclear; nothing is guessed. When everything is clear, the existing claim draft review
 * custody (claims.draft.save) seals the person's entries with the claims service's own normalisation, and only then is
 * a signed proposal issued, carrying that review's digest, expiry and handle. Nothing is saved as a draft or submitted.
 *
 * The card shows the claims service's normalised amount (provisionalAmount), never a figure the model computed. Limits,
 * caps, the receipt window and custom fields are the claims service's own checks, run when the person confirms
 * (core/assistant-actions/own-change-proposal-confirm.ts). A claim type priced by distance (mileage) or with its own
 * required questions is left to the form: the suggestion stays a pointer. A type that needs a receipt is prepared as a
 * draft the person completes with the receipt on Claims, since chat takes no receipt. */
import type {SessionContext} from '../../db/client';
import {todayInKualaLumpur} from '../../lib/hr-date';
import {OWN_CLAIM_DRAFT_ACTION} from '../../lib/assistant-actions/own-claim-contract';
import {readClaimModuleActionChoices} from '../assistant-actions/module-action-server';
import {prepareClaimModuleActionReview} from '../assistant-actions/module-action-review-store';
import {SEMANTIC_ACTIONS} from '../semantic-model/entities';
import {isCalendarDate} from './leave-apply';
import {matchNamed,ownWords,parseStatedAmount,wordsStateAmount} from './own-words';
import {assertProposalsConfigured,issueProposal,type Proposal} from './proposal';
import {wordsNameNumber} from './suggested';

export const CLAIM_SUBMIT_ACTION='claims.submit' as const;
export const CLAIM_SUBMIT_ROUTE='/assistant/claims' as const;
/** The details a chat claim needs; the person is asked for any that is missing or unclear. */
export const CLAIM_SUBMIT_DETAILS=['claimType','claimItem','amount','incurredOn'] as const;
export type ClaimSubmitDetail=typeof CLAIM_SUBMIT_DETAILS[number];
/** One numbered choice from the caller's own claim catalogue, in its fixed order. */
export type ClaimOption=Readonly<{option:number;claimType?:string;claimItem?:string;incurredOn?:string;amount?:string}>;
export type OwnChangeAsk=Readonly<{kind:'ask';missing:readonly string[];options:readonly ClaimOption[];note:string}>;
export type OwnChangeOutcome=Readonly<{kind:'proposal';proposal:Proposal}>|OwnChangeAsk;

export const CLAIM_ASK_NOTE='Some details for this claim are missing or unclear (listed in missing). Nothing is prepared. Ask the person one short question for them; when options are listed, show them numbered as given and ask for the number. Never guess a claim type, an amount or a date: the amount is only ever the one the person states.';
/** At most this many options are listed in one question. */
export const MAX_CLAIM_OPTIONS=12;

const declared=SEMANTIC_ACTIONS.find(action=>action.id===CLAIM_SUBMIT_ACTION)!;
type Named=Readonly<{id:string;name:string;code:string}>;
/** The model's name or code for a type or item, or the number the person chose from the listed options (counted only
 * when the person's own words say that number). Unclear is null. */
function chooseNamed<T extends Named>(rows:readonly T[],given:string,personWords:string|undefined):T|null{
 if(/^\d{1,2}$/.test(given)){const number=Number(given);return wordsNameNumber(personWords,number)&&number>=1&&number<=rows.length?rows[number-1]:null;}
 return matchNamed(rows,given);
}
const text=(details:Readonly<Record<string,unknown>>,key:string)=>typeof details[key]==='string'?(details[key] as string).trim():typeof details[key]==='number'?String(details[key]):'';

/** A new own claim from a chat turn. Null when the caller cannot claim here at all, or the type is left to the form
 * (the suggestion stays a pointer). Throws a pause, as the owners do. */
export async function prepareChatClaimSubmitProposal(ctx:SessionContext,details:Readonly<Record<string,unknown>>,personWords:string|undefined,now:Date=new Date()):Promise<OwnChangeOutcome|null>{
 const choices=await readClaimModuleActionChoices(ctx);
 if(choices.kind!=='choices'||choices.employments.length!==1||!choices.types.length||!ctx.userId||!ctx.personId)return null;
 const missing:ClaimSubmitDetail[]=[];
 const type=text(details,'claimType')?chooseNamed(choices.types,text(details,'claimType'),personWords):null;
 if(!type)missing.push('claimType');
 const item=type&&type.items.length?(text(details,'claimItem')?chooseNamed(type.items,text(details,'claimItem'),personWords):null):null;
 if(type&&type.items.length&&!item)missing.push('claimItem');
 const amount=parseStatedAmount(details.amount);
 if(amount===null||!wordsStateAmount(personWords,amount))missing.push('amount');
 const incurredOn=text(details,'incurredOn')||text(details,'date');
 if(!isCalendarDate(incurredOn)||incurredOn>todayInKualaLumpur(now))missing.push('incurredOn');
 if(missing.length){
  const options:ClaimOption[]=missing.includes('claimType')?choices.types.slice(0,MAX_CLAIM_OPTIONS).map((row,index)=>Object.freeze({option:index+1,claimType:row.name.slice(0,64)}))
   :missing.includes('claimItem')&&type?type.items.slice(0,MAX_CLAIM_OPTIONS).map((row,index)=>Object.freeze({option:index+1,claimItem:row.name.slice(0,64)})):[];
  return Object.freeze({kind:'ask' as const,missing:Object.freeze(missing),options:Object.freeze(options),note:CLAIM_ASK_NOTE});
 }
 const chosen=type!;
 // Distance-priced and custom-question types are filled in on the claim form itself.
 if(chosen.isMileage||chosen.fields.some(field=>field.required))return null;
 const description=ownWords(details.description,personWords,500);
 assertProposalsConfigured();
 const prepared=await prepareClaimModuleActionReview(ctx,{action:OWN_CLAIM_DRAFT_ACTION,contractVersion:1,employmentId:choices.employments[0].employmentId,draftId:null,
  claimTypeId:chosen.id,claimItemId:item?.id??null,enteredAmount:amount!,quantityKm:null,incurredOn,description,fieldValues:null,retainedAttachmentIds:[]});
 if(prepared.kind!=='prepared')return null;
 const review=prepared.review;
 // The service could not price it from the person's entry: nothing to show, so the form takes it.
 if(!/^\d{1,9}\.\d{2}$/.test(review.provisionalAmount)||Number(review.provisionalAmount)<=0)return null;
 const checks=declared.checks.map(check=>({check:check.check,owner:check.owner,ruleVersion:null,
  result:check.check==='receipt_attached'&&chosen.requiresReceipt?'needs_review' as const:'pass' as const}));
 return Object.freeze({kind:'proposal' as const,proposal:issueProposal({
  what:{action:CLAIM_SUBMIT_ACTION,contractVersion:1,entity:declared.entity,effect:declared.effect,selectors:{incurredOn,claimTypeId:chosen.id},reviewedDigest:review.reviewedDigest},
  forWhom:{tenantId:ctx.tenantId,subject:'own_employment',subjectId:review.content.employmentId},
  authority:{kind:'person',tenantId:ctx.tenantId,userId:ctx.userId,personId:ctx.personId},
  checks,
  review:{route:CLAIM_SUBMIT_ROUTE,href:`${CLAIM_SUBMIT_ROUTE}?review=${review.actionId}`,reference:review.actionId},
  facts:{claimType:chosen.name.slice(0,64),...(item?{claimItem:item.name.slice(0,64)}:{}),incurredOn,amount:review.provisionalAmount,
   outcome:chosen.requiresReceipt?'claim_draft_receipt_needed':'claim_submitted_if_checks_pass'},
  createdAt:review.createdAt,expiresAt:review.expiresAt})});
}
