/** Versioned proposals are rendered by field identity, never raw JSON or an inferred column name. */
import {PROFILE_PHOTO_FIELD} from './profile-photo-proposal';
import {parseEssProfileProposal} from './personnel-ess-contract';
import {personnelField,PERSONNEL_FIELDS} from './personnel-field-registry';
import {personnelFieldLabel,type PersonnelLabelResolver} from './personnel-field-label';
import {personnelFieldChoices} from './personnel-import-contract';
import {requestableField,formatProposedValue} from './profile-requestable-fields';
import {formatDmy} from './date-display';
export type ProfileProposalLine={key:string;fieldId:string|null;label:string;value:string;recordKind:'dependent'|'qualification'|'emergency'|null;newRecord:boolean};
export function profileProposalLines(raw:unknown,resolve:PersonnelLabelResolver,opts:{mask:boolean}):ProfileProposalLine[]{
 if(!raw||typeof raw!=='object'||Array.isArray(raw))return [];
 if('v' in raw&&raw.v===3&&'kind' in raw&&raw.kind==='photo'&&'fieldId' in raw&&raw.fieldId===PROFILE_PHOTO_FIELD)return [{key:PROFILE_PHOTO_FIELD,fieldId:PROFILE_PHOTO_FIELD,label:resolve('essProfile.photoRequests','Profile photo'),value:resolve('essProfile.photoProposed','Photo submitted for HR approval'),recordKind:null,newRecord:false}];
 if('v' in raw&&raw.v===2){
  let proposal;try{proposal=parseEssProfileProposal(raw);}catch{return [];}
  const render=(change:typeof proposal.fields[number],key:string,recordKind:ProfileProposalLine['recordKind'],newRecord:boolean)=>{
   const field=personnelField(change.fieldId)!;const value=change.value;
   const choice=personnelFieldChoices(field).find(choice=>choice.value===String(value));
   const display=value===null||value===''?resolve('me.proposedCleared','Cleared'):field.ess.masked&&opts.mask?`•••• ${String(value).slice(-4)}`:choice?resolve(choice.labelKey,choice.value):field.type==='date'?formatDmy(String(value)):typeof value==='boolean'?resolve(value?'people.import.registerYes':'people.import.registerNo',String(value)):String(value);
   return {key,fieldId:field.id,label:personnelFieldLabel(field,resolve),value:display,recordKind,newRecord};
  };
  return [...proposal.fields.map(change=>render(change,change.fieldId,null,false)),...proposal.registers.flatMap(row=>row.fields.map(change=>render(change,`${row.kind}:${row.id??row.clientId}:${change.fieldId}`,row.kind,row.id===null)))];
 }
 return Object.entries(raw).flatMap(([key,value])=>{
  const field=requestableField(key);if(!field||value!==null&&!['string','number','boolean'].includes(typeof value))return [];
  const descriptor=PERSONNEL_FIELDS.find(item=>item.ess.binding?.legacyKey===key);
  return [{key,fieldId:descriptor?.id??null,label:resolve(`people.detail.${field.labelKey}`,field.key),value:opts.mask&&descriptor?.ess.masked&&value!=null&&value!==''?`•••• ${String(value).slice(-4)}`:formatProposedValue(field,value,k=>resolve(`me.${k}`,k),opts),recordKind:null,newRecord:false}];
 });
}

/** Exact current record context is supplied by the scoped canonical owner, never inferred from array position. */
export type ProfileProposalCurrent=Record<string,{value:string|number|boolean|null|undefined;recordName:string|null;state:'existing'|'missing'|'new'}>;
export function profileProposalReviewLines(raw:unknown,current:ProfileProposalCurrent,resolve:PersonnelLabelResolver,opts:{mask:boolean}){
 return profileProposalLines(raw,resolve,opts).map(line=>{
  const found=current[line.key],field=line.fieldId?personnelField(line.fieldId):undefined,value=found?.value;
  const legacy=requestableField(line.key),choice=field?personnelFieldChoices(field).find(choice=>choice.value===String(value)):undefined;
  const display=!found||found.state==='missing'||value===undefined?resolve('essProfile.unavailable','Unavailable'):field?.ess.masked&&opts.mask&&value!=null&&value!==''?`•••• ${String(value).slice(-4)}`:legacy?formatProposedValue(legacy,value,key=>resolve(`me.${key}`,key),opts):value===null||value===''?resolve('essProfile.notRecorded','Not recorded'):field?.ess.masked&&opts.mask?`•••• ${String(value).slice(-4)}`:choice?resolve(choice.labelKey,choice.value):field?.type==='date'?formatDmy(String(value)):typeof value==='boolean'?resolve(value?'people.import.registerYes':'people.import.registerNo',String(value)):String(value);
  const recordKind=line.recordKind?resolve(`essProfile.register.${line.recordKind}`,line.recordKind):null;
  const recordLabel=!recordKind?null:found?.state==='new'?resolve('essProfile.newRecord','New record'):found?.state==='missing'?resolve('essProfile.missingRecord','The original record is no longer available.'):found?.recordName?`${recordKind}: ${found.recordName}`:recordKind;
  return {...line,currentValue:display,recordLabel};
 });
}
