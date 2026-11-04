/** AI v2 W2 — `ess.profile.request` from chat: an own address, emergency contact, dependant or bank change, sent to HR.
 *
 * The path is the existing employee profile change request (ADR-0159): the canonical owner (core/profile.ts) checks the
 * caller's own employment, which fields the company lets them request, the before-values, field validation and routing,
 * and HR approves before anything changes. Nothing here applies a change or widens that path: a field the company has
 * not opened for requests, one that needs a supporting document, or one the company applies without approval is left
 * to the profile page (the suggestion stays a pointer). Bank details are never applied on request: HR verifies them.
 *
 * What the model may pass, and what counts:
 *  - which change (address, emergency_contact, dependant, bank) and, for each, the details below;
 *  - a name, an address line, a postcode or a city counts only when the person's own words this turn contain it;
 *  - a relationship or gender resolves only against the owner's own vocabulary, a bank only against the country pack's
 *    bank list, a date of birth only when the person's own words name that date;
 *  - a bank account or phone number is NEVER taken from the model, which only ever sees "[bank_account removed]": it is
 *    read from the person's own words (./own-words.ts). It goes into the sealed review only; the signed proposal and
 *    the card carry the bank name and the last four digits at most, and nothing about it reaches the model.
 * Missing or unclear details are asked for in one question. */
import type {SessionContext} from '../../db/client';
import {todayInKualaLumpur} from '../../lib/hr-date';
import {DEPENDENT_GENDERS,DEPENDENT_RELATIONSHIPS} from '../../lib/dependent-vocabulary';
import type {EssFieldChange,EssRegisterChange,EssScalar} from '../../lib/personnel-ess-model';
import {OWN_PROFILE_CHANGE_ACTION} from '../../lib/assistant-actions/own-profile-change-contract';
import {packFor} from '../../localization/registry';
import {readOwnProfileWorkspace,type EssWorkspace} from '../profile-edit';
import {listProfileOptions} from '../profile-options';
import {prepareProfileModuleActionReview} from '../assistant-actions/module-action-review-store';
import {SEMANTIC_ACTIONS} from '../semantic-model/entities';
import {OWN_PROFILE_CHANGES} from '../semantic-model/entities-own-changes';
import type {OwnChangeOutcome} from './claim-submit';
import {isCalendarDate} from './leave-apply';
import {matchNamed,oneBankAccountIn,onePhoneIn,ownWords,squashWords} from './own-words';
import {assertProposalsConfigured,issueProposal} from './proposal';
import {wordsNameDate} from './suggested';

export type OwnProfileChange=typeof OWN_PROFILE_CHANGES[number];
export const PROFILE_CHANGE_ROUTE='/assistant/profile' as const;
/** The personnel fields each change may carry (lib/personnel-field-registry.ts identities). */
export const PROFILE_CHANGE_FIELDS=Object.freeze({
 address:Object.freeze({addressLine1:'profile.contact_and_permanent_address.permanentaddressline1',addressLine2:'profile.contact_and_permanent_address.permanentaddressline2',
  addressLine3:'profile.contact_and_permanent_address.permanentaddressline3',postcode:'profile.contact_and_permanent_address.permanentpostcode',
  city:'profile.contact_and_permanent_address.permanentcity',state:'profile.contact_and_permanent_address.permanentstate'}),
 emergency_contact:Object.freeze({contactName:'profile.emergency_contact.fullname',relationship:'profile.emergency_contact.relationship',
  mobilePhone:'profile.emergency_contact.mobilephone',priority:'profile.emergency_contact.priority'}),
 dependant:Object.freeze({dependantName:'family.family_and_dependents.fullname',relationship:'family.family_and_dependents.relationship',
  dateOfBirth:'family.family_and_dependents.dateofbirth',gender:'family.family_and_dependents.gender'}),
 bank:Object.freeze({bankName:'bank_statutory.bank_information.bankname',accountNumber:'bank_statutory.bank_information.bankaccountno'}),
});
export const PROFILE_ASK_NOTE='Some details for this profile change are missing or unclear (listed in missing). Nothing is prepared. Ask the person one short question for them. Every new value comes only from the person\'s own words. A bank account or phone number is read from their message by the system: never repeat, guess or invent one, and ask for it only when it is listed in missing.';
const declared=SEMANTIC_ACTIONS.find(action=>action.id===OWN_PROFILE_CHANGE_ACTION)!;

/** Everyday words for the owner's dependant relationships (lowercase owner values), in English and Malay. */
const DEPENDANT_RELATIONSHIP_WORDS:Readonly<Record<string,typeof DEPENDENT_RELATIONSHIPS[number]>>=Object.freeze({
 spouse:'spouse',wife:'spouse',husband:'spouse',isteri:'spouse',suami:'spouse',child:'child',son:'child',daughter:'child',anak:'child',
 parent:'parent',father:'parent',mother:'parent',bapa:'parent',ayah:'parent',ibu:'parent',emak:'parent',
 sibling:'sibling',brother:'sibling',sister:'sibling',abang:'sibling',kakak:'sibling',adik:'sibling',other:'other'});
const GENDER_WORDS:Readonly<Record<string,typeof DEPENDENT_GENDERS[number]>>=Object.freeze({male:'male',lelaki:'male',boy:'male',female:'female',perempuan:'female',girl:'female'});

type Built=Readonly<{missing:readonly string[]}>|Readonly<{fields:EssFieldChange[];registers:EssRegisterChange[];bankName?:string;accountEnding?:string}>;
const given=(details:Readonly<Record<string,unknown>>,key:string)=>typeof details[key]==='string'?(details[key] as string).trim():'';
const scalar=(workspace:EssWorkspace,fieldId:string,value:EssScalar):EssFieldChange|null=>{const before=workspace.baselines[fieldId];return typeof before==='string'?{fieldId,before,value}:null;};

async function build(ctx:SessionContext,change:OwnProfileChange,details:Readonly<Record<string,unknown>>,personWords:string|undefined,workspace:EssWorkspace,now:Date):Promise<Built|null>{
 if(change==='address'){
  const ids=PROFILE_CHANGE_FIELDS.address,fields:EssFieldChange[]=[];
  for(const [key,fieldId] of Object.entries(ids)){
   const raw=given(details,key);if(!raw)continue;
   const value=ownWords(raw,personWords,200);if(value===null)return{missing:[key]};
   const row=scalar(workspace,fieldId,value);if(!row)return null;fields.push(row);
  }
  return fields.some(row=>row.fieldId===ids.addressLine1)?{fields,registers:[]}:{missing:['addressLine1']};
 }
 if(change==='emergency_contact'){
  const ids=PROFILE_CHANGE_FIELDS.emergency_contact;
  const name=ownWords(given(details,'contactName'),personWords,200);
  if(!name)return{missing:['contactName']};
  const values:[string,EssScalar][]=[[ids.contactName,name]];
  if(given(details,'relationship')){
   const options=(await listProfileOptions(ctx,'relationship',{activeOnly:true})).map(row=>({name:row.label,code:row.value,value:row.value}));
   const relationship=matchNamed(options,given(details,'relationship'));if(!relationship)return{missing:['relationship']};
   values.push([ids.relationship,relationship.value]);
  }
  const phone=onePhoneIn(personWords);if(phone)values.push([ids.mobilePhone,phone]);
  const contacts=workspace.registers.filter(row=>row.kind==='emergency'),current=contacts.find(row=>row.primary)??(contacts.length===1?contacts[0]:undefined);
  if(current){
   const fields=values.map(([fieldId,value])=>{const before=current.baselines[fieldId];return typeof before==='string'?{fieldId,before,value}:null;});
   if(fields.some(row=>row===null))return null;
   return{fields:[],registers:[{kind:'emergency',id:current.id,clientId:'chat-emergency',fields:fields as EssFieldChange[]}]};
  }
  // The first contact is the primary one.
  return{fields:[],registers:[{kind:'emergency',id:null,clientId:'chat-emergency',fields:[...values,[ids.priority,'primary'] as [string,EssScalar]].map(([fieldId,value])=>({fieldId,before:null,value}))}]};
 }
 if(change==='dependant'){
  const ids=PROFILE_CHANGE_FIELDS.dependant,missing:string[]=[];
  const name=ownWords(given(details,'dependantName'),personWords,200);if(!name)missing.push('dependantName');
  const relationship=dependantRelationship(given(details,'relationship'));if(!relationship)missing.push('relationship');
  const born=given(details,'dateOfBirth');
  const dateOfBirth=born&&isCalendarDate(born)&&born<=todayInKualaLumpur(now)&&wordsNameDate(personWords,born)?born:null;
  if(born&&!dateOfBirth)missing.push('dateOfBirth');
  const gender=given(details,'gender')?GENDER_WORDS[squashWords(given(details,'gender'))]??null:null;
  if(given(details,'gender')&&!gender)missing.push('gender');
  if(missing.length)return{missing};
  const values:[string,EssScalar][]=[[ids.relationship,relationship],[ids.dependantName,name],...(dateOfBirth?[[ids.dateOfBirth,dateOfBirth] as [string,EssScalar]]:[]),...(gender?[[ids.gender,gender] as [string,EssScalar]]:[])];
  return{fields:[],registers:[{kind:'dependent',id:null,clientId:'chat-dependant',fields:values.map(([fieldId,value])=>({fieldId,before:null,value}))}]};
 }
 // Bank: the account number only from the person's own words, the bank only from the country pack's own list.
 const ids=PROFILE_CHANGE_FIELDS.bank,account=oneBankAccountIn(personWords);
 if(!account)return{missing:['accountNumber']};
 const banks=(packFor(workspace.country)?.client.bankNames??[]).map(name=>({name}));
 const bank=given(details,'bankName')?matchNamed(banks,given(details,'bankName')):null;
 if(given(details,'bankName')&&!bank)return{missing:['bankName']};
 const currentBank=typeof workspace.values[ids.bankName]==='string'&&workspace.values[ids.bankName]?String(workspace.values[ids.bankName]):null;
 if(!bank&&!currentBank)return{missing:['bankName']};
 const fields=[...(bank?[scalar(workspace,ids.bankName,bank.name)]:[]),scalar(workspace,ids.accountNumber,account)];
 if(fields.some(row=>row===null))return null;
 return{fields:fields as EssFieldChange[],registers:[],bankName:(bank?.name??currentBank!).slice(0,64),accountEnding:account.slice(-4)};
}
function dependantRelationship(value:string){return value?DEPENDANT_RELATIONSHIP_WORDS[squashWords(value)]??null:null;}

/** An own profile change from a chat turn. Null when the caller cannot request it here (the suggestion stays a pointer
 * to the profile page). Throws a pause, as the owners do. */
export async function prepareChatProfileChangeProposal(ctx:SessionContext,details:Readonly<Record<string,unknown>>,personWords:string|undefined,now:Date=new Date()):Promise<OwnChangeOutcome|null>{
 if(!ctx.userId||!ctx.personId)return null;
 const change=OWN_PROFILE_CHANGES.find(row=>row===given(details,'change'));
 if(!change)return Object.freeze({kind:'ask' as const,missing:Object.freeze(['change']),options:Object.freeze([]),note:PROFILE_ASK_NOTE});
 let workspace:EssWorkspace;
 try{workspace=await readOwnProfileWorkspace(ctx,{});}catch{return null;}
 if(workspace.personId!==ctx.personId)return null;
 const built=await build(ctx,change,details,personWords,workspace,now);
 if(!built)return null;
 if('missing' in built)return Object.freeze({kind:'ask' as const,missing:Object.freeze([...built.missing]),options:Object.freeze([]),note:PROFILE_ASK_NOTE});
 // Only fields the company lets this person request, with no supporting document required (chat takes no file).
 const editable=new Set(workspace.editable),changed=[...built.fields,...built.registers.flatMap(row=>row.fields)];
 if(!changed.length||changed.some(row=>!editable.has(row.fieldId)||workspace.approvals?.[row.fieldId]?.attachmentRequired||workspace.approvals?.[row.fieldId]?.required===false))return null;
 assertProposalsConfigured();
 const prepared=await prepareProfileModuleActionReview(ctx,{action:OWN_PROFILE_CHANGE_ACTION,contractVersion:1,employmentId:workspace.employmentId,proposal:{v:2,fields:built.fields,registers:built.registers}});
 if(prepared.kind!=='prepared')return null;
 const review=prepared.review,proposal=review.content.proposal;
 const fieldCount=proposal.fields.length+proposal.registers.reduce((sum,row)=>sum+row.fields.length,0);
 if(fieldCount<1)return null;
 return Object.freeze({kind:'proposal' as const,proposal:issueProposal({
  what:{action:OWN_PROFILE_CHANGE_ACTION,contractVersion:1,entity:declared.entity,effect:declared.effect,selectors:{change},reviewedDigest:review.reviewedDigest},
  forWhom:{tenantId:ctx.tenantId,subject:'own_employment',subjectId:review.content.employmentId},
  authority:{kind:'person',tenantId:ctx.tenantId,userId:ctx.userId,personId:ctx.personId},
  checks:declared.checks.map(check=>({check:check.check,owner:check.owner,ruleVersion:null,result:'pass' as const})),
  review:{route:PROFILE_CHANGE_ROUTE,href:`${PROFILE_CHANGE_ROUTE}?review=${review.actionId}`,reference:review.actionId},
  facts:{profileChange:change,fieldCount:Math.min(fieldCount,64),...(built.bankName?{bankName:built.bankName}:{}),...(built.accountEnding?{accountEnding:built.accountEnding}:{}),
   outcome:change==='bank'?'hr_verification_required':'hr_approval_required'},
  createdAt:review.createdAt,expiresAt:review.expiresAt})});
}
