/** Versioned completion of missing Personnel fields. Templates keep their original pmLocked ownership. */
import {isSupportedCountry,parsePhoneNumberWithError,type CountryCode} from 'libphonenumber-js/max';
import type {Actor,Document,Field} from './lifecycle-v9-model';
import {signingContentLocked} from './document-signing-model';
import {isCalendarDate} from './calendar-date';
export const PERSONNEL_COMPLETION_VERSION=1 as const;
export const PERSONNEL_COMPLETION_CLASSIFICATION='2026-11-18' as const;
export const personnelCompletionClassification={
 'employee.icNo':'personal',race:'personal',religion:'personal',nationality:'personal',gender:'personal',marital:'personal',
 'employee.passportNo':'personal',mobile:'personal',homePhone:'personal',personalEmail:'personal',address:'personal',
 'employee.empNo':'employment','employee.name':'employment',email:'employment','company.name':'employment',
 'employee.department':'employment','employee.position':'employment','employee.supervisor':'employment',
 'joiner.joinDate':'employment','leaver.lastDay':'employment',
} as const;
export type PersonnelCompletionGroup='personal'|'employment'|'unknown';
export type PersonnelCompletionOwner='employee'|'hr'|'pmLocked';
export type PersonnelCompletionEntry={key:string|null;group:PersonnelCompletionGroup;sourceValue:string;sourceFingerprint:string;
 override?:{owner:'employee'|'hr';by:Actor;at:string;reason:string};
 draft?:{value:string;by:Actor;at:string};
 /** Active case answer is distinct from a preserved employee draft after an HR takeover. */
 answer?:{value:string;owner:'employee'|'hr';by:Actor;at:string};
 conflict?:{draft:string;official:string;at:string};};
export type PersonnelCompletionPolicy={version:1;classification:typeof PERSONNEL_COMPLETION_CLASSIFICATION;country:string|null;sourceFingerprint:string;
 adoptedAt:string;adoptedBy:Actor;fields:Record<string,PersonnelCompletionEntry>;
 preparation?:{at:string;by:Actor};submitted?:{at:string;by:Actor;sourceFingerprint:string};
 history:{fieldId:string;action:'override'|'reconciled';by:Actor;at:string;before:string;after:string;reason:string}[];};
export type CompletionDocument=Pick<Document,'fields'|'values'|'status'|'sentAt'|'employeeSignature'|'hrSignature'|'signing'>&{personnelCompletion?:PersonnelCompletionPolicy};
export function personnelCompletionGroup(key:string|null|undefined):PersonnelCompletionGroup{return key&&Object.hasOwn(personnelCompletionClassification,key)?personnelCompletionClassification[key as keyof typeof personnelCompletionClassification]:'unknown';}
export function personnelCompletionLocked(document:CompletionDocument){return !!document.employeeSignature||!!document.hrSignature||!!document.signing&&signingContentLocked(document.signing)||['withdrawn','superseded'].includes(document.status)||!document.signing&&['signed','completed','acknowledged'].includes(document.status);}
/** Only newly generated or explicitly recovered unsigned drafts may adopt the new rule. Existing released snapshots stay legacy. */
export function initializePersonnelCompletion(document:CompletionDocument,input:{country:string|null;sourceFingerprint:string;officialValues:Record<string,string>;actor:Actor;at:string}){
 if(document.personnelCompletion)return;
 if(document.sentAt||document.status!=='draft'||personnelCompletionLocked(document))throw new Error('Only an unsigned, unreleased draft can adopt Personnel completion.');
 const fields:PersonnelCompletionPolicy['fields']={};
 for(const field of document.fields)if(field.owner==='pmLocked'){const official=input.officialValues[field.id]??'';fields[field.id]={key:field.pmKey,group:personnelCompletionGroup(field.pmKey),sourceValue:official,sourceFingerprint:input.sourceFingerprint};document.values[field.id]=official;}
 document.personnelCompletion={version:1,classification:PERSONNEL_COMPLETION_CLASSIFICATION,country:input.country,sourceFingerprint:input.sourceFingerprint,adoptedAt:input.at,adoptedBy:{...input.actor},fields,history:[]};
 if(document.fields.some(field=>field.required&&effectivePersonnelCompletion(document,field)==='employee'))document.personnelCompletion.preparation={at:input.at,by:{...input.actor}};
}
export function effectivePersonnelCompletion(document:CompletionDocument,field:Field):PersonnelCompletionOwner{
 if(field.owner!=='pmLocked')return field.owner;
 const entry=document.personnelCompletion?.fields[field.id];
 if(!entry||entry.key!==field.pmKey||entry.sourceValue.trim())return 'pmLocked';
 if(personnelCompletionGroup(field.pmKey)==='unknown')return 'hr';
 return entry.override?.owner??(entry.group==='personal'?'employee':'hr');
}
export function missingPersonnelCompletion(document:CompletionDocument,owner:'employee'|'hr'){
 return document.fields.filter(field=>field.owner==='pmLocked'&&effectivePersonnelCompletion(document,field)===owner&&(!field.when||document.values[field.when.field]===field.when.value)&&(!document.values[field.id]?.trim()||field.required&&(field.type==='checkbox'&&document.values[field.id]!=='true'||field.type==='table'&&document.values[field.id]==='[]')));
}
/** The authorized case service supplies the actor and persists its normal immutable case revision/audit. */
export function overridePersonnelCompletion(document:CompletionDocument,input:{fieldId:string;owner:'employee'|'hr';reason:string;actor:Actor;at:string}){
 const entry=document.personnelCompletion?.fields[input.fieldId],field=document.fields.find(f=>f.id===input.fieldId);
 if(!entry||!field||field.owner!=='pmLocked'||entry.sourceValue.trim()||personnelCompletionLocked(document))throw new Error('Only a missing unsigned Personnel field can change who completes it.');
 if(input.owner==='employee'&&personnelCompletionGroup(field.pmKey)==='unknown')throw new Error('Unclassified Personnel fields remain with HR.');
 if(!input.reason.trim())throw new Error('Record why completion is changing.');
 const before=effectivePersonnelCompletion(document,field);
 if(before!==input.owner){document.values[field.id]='';delete entry.answer;}
 delete document.personnelCompletion!.submitted;
 entry.override={owner:input.owner,reason:input.reason.trim(),by:{...input.actor},at:input.at};
 if(input.owner==='employee'&&field.required&&!document.personnelCompletion!.preparation)document.personnelCompletion!.preparation={at:input.at,by:{...input.actor}};
 document.personnelCompletion!.history.push({fieldId:field.id,action:'override',by:{...input.actor},at:input.at,before,after:input.owner,reason:input.reason.trim()});
}
/** Official values win only while editable; conflicting saved employee drafts remain available for HR review. */
export function reconcilePersonnelCompletion(document:CompletionDocument,input:{values:Record<string,string>;sourceFingerprint:string;actor:Actor;at:string}){
 const policy=document.personnelCompletion;if(!policy||personnelCompletionLocked(document))return false;
 let changed=false;
 for(const field of document.fields){const entry=policy.fields[field.id];if(!entry||entry.key!==field.pmKey)continue;const official=input.values[field.id]??'';
  if(official===entry.sourceValue)continue;
  const draft=document.values[field.id]??'';
  if(official.trim()){
   if(draft&&draft!==entry.sourceValue&&draft!==official)entry.conflict={draft,official,at:input.at};
   document.values[field.id]=official;
  }else if(entry.sourceValue.trim())document.values[field.id]=entry.answer?.value??entry.draft?.value??'';
  policy.history.push({fieldId:field.id,action:'reconciled',by:{...input.actor},at:input.at,before:entry.sourceValue,after:official,reason:'Current authorized Personnel source'});
  entry.sourceValue=official;entry.sourceFingerprint=input.sourceFingerprint;changed=true;
 }
 if(changed){policy.sourceFingerprint=input.sourceFingerprint;delete policy.submitted;if(!policy.preparation&&document.fields.some(field=>field.required&&effectivePersonnelCompletion(document,field)==='employee'))policy.preparation={at:input.at,by:{...input.actor}};}return changed;
}
/** Full numbering-plan metadata, with an evidenced company jurisdiction for national numbers. No length-only inference. */
export function normalizeCompletionPhone(value:string,country:string|null):string{
 if(!value.trim())return '';
 const jurisdiction=country&&isSupportedCountry(country)?country as CountryCode:undefined;
 if(!value.trim().startsWith('+')&&!jurisdiction)throw new Error('Use an international phone number with a country calling code.');
 try{const phone=parsePhoneNumberWithError(value.trim(),{defaultCountry:jurisdiction,extract:false});if(!phone.isValid()||phone.ext)throw new Error();return phone.number;}
 catch{throw new Error('Enter a valid phone number including its area or country calling code.');}
}
export function validateCompletionPhone(value:string,country:string|null){normalizeCompletionPhone(value,country);}
export function validatePersonnelCompletionScalar(field:Field,value:string,country:string|null){
 if(value.length>20000)throw new Error('Keep this value within 20,000 characters.');
 if(field.type==='phone')validateCompletionPhone(value,country);
 if(field.type==='email'&&value&&!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value))throw new Error('Enter a valid email address.');
 if(field.type==='date'&&value&&!isCalendarDate(value))throw new Error('Enter a valid calendar date.');
 if(field.type==='number'&&value&&(!/^-?(?:\d+(?:\.\d+)?|\.\d+)$/.test(value)||!Number.isFinite(Number(value))))throw new Error('Enter a valid number.');
}
export function savePersonnelCompletionValue(document:CompletionDocument,field:Field,value:string,input:{actor:Actor;at:string}){
 return savePersonnelCompletionAnswer(document,field,value,{...input,owner:'employee'});
}
/** This records who supplied the active answer; only the authorized subject service may select the owner. */
export function savePersonnelCompletionAnswer(document:CompletionDocument,field:Field,value:string,input:{owner:'employee'|'hr';actor:Actor;at:string}){
 const policy=document.personnelCompletion,entry=policy?.fields[field.id];
 if(!entry||effectivePersonnelCompletion(document,field)!==input.owner||personnelCompletionLocked(document))throw new Error('This Personnel field is locked.');
 validatePersonnelCompletionScalar(field,value,policy!.country);
 if(field.type==='phone')value=normalizeCompletionPhone(value,policy!.country);
 document.values[field.id]=value;
 delete policy!.submitted;
 entry.answer={value,owner:input.owner,by:{...input.actor},at:input.at};
 if(input.owner==='employee')entry.draft={value,by:{...input.actor},at:input.at};
}
/** Proposals concern an actually submitted employee answer, never an HR replacement or an old preserved draft. */
export function personnelCompletionEmployeeAnswers(document:CompletionDocument,actorId:string){
 return document.fields.flatMap(field=>{const entry=document.personnelCompletion?.fields[field.id],answer=entry?.answer;
  if(!entry?.key||!answer||answer.owner!=='employee'||answer.by.id!==actorId||entry.sourceValue.trim()||effectivePersonnelCompletion(document,field)!=='employee'||answer.value!==document.values[field.id]||!answer.value.trim()||field.when&&document.values[field.when.field]!==field.when.value)return [];
  return [{fieldId:field.id,key:entry.key,value:answer.value,by:{...answer.by},at:answer.at}];
 });
}
export type PersonnelCompletionIssue={fieldId:string;code:'required'|'phone'|'email'|'date'|'number'|'length';message:string};
/** UI and services share scalar rules; draft saves permit blank required answers, final submission does not. */
export function personnelCompletionIssues(document:CompletionDocument,options:{owner?:'employee'|'hr';final:boolean}):PersonnelCompletionIssue[]{
 const issues:PersonnelCompletionIssue[]=[];
 for(const field of document.fields){
  if(field.when&&document.values[field.when.field]!==field.when.value)continue;
  const effective=effectivePersonnelCompletion(document,field);if(options.owner&&effective!==options.owner)continue;
  const value=document.values[field.id]??'';
  if(options.final&&field.required&&(!value.trim()||field.type==='checkbox'&&value!=='true'||field.type==='table'&&value==='[]')){issues.push({fieldId:field.id,code:'required',message:'Complete this required field.'});continue;}
  if(effective==='pmLocked')continue;
  try{validatePersonnelCompletionScalar(field,value,document.personnelCompletion?.country??null);}catch(error){issues.push({fieldId:field.id,code:value.length>20000?'length':['phone','email','date','number'].includes(field.type)?field.type as 'phone'|'email'|'date'|'number':'length',message:(error as Error).message});}
 }
 return issues;
}
/** Resolve a missing source token from its per-document answer without changing the official PM snapshot. */
export function personnelCompletionMergeValues(document:CompletionDocument,values:Record<string,string>=document.values):Record<string,string>{
 const result:Record<string,string>={};
 for(const field of document.fields){const entry=document.personnelCompletion?.fields[field.id];if(!entry?.key||field.when&&values[field.when.field]!==field.when.value)continue;if(entry.sourceValue.trim()){result[entry.key]=field.type==='date'&&isCalendarDate(entry.sourceValue)?entry.sourceValue.slice(8)+'/'+entry.sourceValue.slice(5,7)+'/'+entry.sourceValue.slice(0,4):entry.sourceValue;continue;}if(effectivePersonnelCompletion(document,field)==='pmLocked')continue;result[entry.key]=values[field.id]??'';if(!field.required&&!result[entry.key])result[entry.key]='—';}
 return result;
}
