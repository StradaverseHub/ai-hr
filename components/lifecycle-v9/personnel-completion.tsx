'use client';
import {useState,useTransition,type ComponentProps} from 'react';
import {useTranslations} from 'next-intl';
import type {Document,Field,PMChange} from '@/lib/lifecycle-v9-model';
import {effectivePersonnelCompletion,personnelCompletionLocked,personnelCompletionIssues,personnelCompletionClassification} from '@/lib/lifecycle-v9-personnel-completion';
import {onboardingTimestamp} from '@/lib/onboarding-format';
import {DocumentBody,DocumentField} from './document-body';
export type PersonnelCompletionResult={ok:boolean;error?:string};
export type PersonnelCompletionOverride={fieldId:string;owner:'employee'|'hr';reason:string};
/** The caller supplies an already-authorized saved document; this component grants no case or PM authority. */
export function PersonnelCompletionDocumentBody(props:ComponentProps<typeof DocumentBody>){const t=useTranslations('personnelCompletion');return <DocumentBody {...props} completionCopy={key=>t(key)}/>;}
export function PersonnelCompletionEmployeeNotice({document}:{document:Document}){
 const t=useTranslations('personnelCompletion');if(!document.personnelCompletion||!document.fields.some(field=>field.owner==='pmLocked'&&effectivePersonnelCompletion(document,field)==='employee'))return null;
 return <p className="v9-notice">{t('employeeHelp')}</p>;
}
/** Used below the existing Personnel-locked ownership control; never an additional template option. */
export function PersonnelCompletionTemplateHelp(){const t=useTranslations('personnelCompletion');return <p className="v9-muted">{t('templateHelp')}</p>;}
export function PersonnelCompletionInventory(){
 const t=useTranslations('personnelCompletion');return <details><summary>{t('inventoryTitle')}</summary><p className="v9-muted">{t('inventoryHelp')}</p>{(['personal','employment']as const).map(group=><section className="v9-stack" key={group}><h4>{t(group==='personal'?'personalGroup':'employmentGroup')}</h4><ul>{Object.entries(personnelCompletionClassification).filter(([,category])=>category===group).map(([key])=><li key={key}>{t('fields.'+key.replaceAll('.','_'))}</li>)}</ul></section>)}</details>;
}
function Conflict({field,entry}:{field:Field;entry:NonNullable<Document['personnelCompletion']>['fields'][string]}){
 const t=useTranslations('personnelCompletion');if(!entry.conflict)return null;
 const protectedValue=field.sensitive||['employee.icNo','employee.passportNo'].includes(field.pmKey??'');
 const show=(value:string)=>protectedValue&&value?'••••':value||t('notInPm');
 return <aside className="v9-panel v9-stack" role="status"><h4>{t('conflictTitle',{field:field.label})}</h4><p>{t('conflictHelp')}</p><dl><dt>{t('officialValue')}</dt><dd className="v9-prewrap break-words">{show(entry.conflict.official)}</dd><dt>{t('savedDraft')}</dt><dd className="v9-prewrap break-words">{show(entry.conflict.draft)}</dd></dl></aside>;
}
function Assignment({document,field,busy,canOverride,onOverride}:{document:Document;field:Field;busy:boolean;canOverride:boolean;onOverride?:(input:PersonnelCompletionOverride)=>Promise<PersonnelCompletionResult>}){
 const t=useTranslations('personnelCompletion'),[choosing,setChoosing]=useState(false),[reason,setReason]=useState(''),[error,setError]=useState(''),[saving,start]=useTransition();
 const entry=document.personnelCompletion!.fields[field.id],owner=effectivePersonnelCompletion(document,field),target=owner==='employee'?'hr':'employee';
 const disabled=busy||saving||personnelCompletionLocked(document)||!canOverride||!onOverride;
 return <fieldset className="v9-panel v9-stack"><legend>{field.label}</legend><p>{t(owner==='employee'?'employeeCompletes':'hrCompletes')}</p>
  {entry.override&&<p className="v9-muted">{t('changedBy',{name:entry.override.by.name,when:onboardingTimestamp(entry.override.at)})}<br/>{entry.override.reason}</p>}
  {!choosing?<button type="button" className="v9-button" disabled={disabled} onClick={()=>{setChoosing(true);setError('');}}>{t(target==='employee'?'askEmployee':'fillMyself')}</button>:<><p className="v9-muted">{t('hrHelp')}</p><label className="v9-field"><span>{t('reason')}</span><input className="v9-input" autoFocus required maxLength={1000} disabled={disabled} value={reason} onChange={event=>setReason(event.target.value)}/></label><div className="v9-actions"><button type="button" className="v9-button v9-button-primary" disabled={disabled||!reason.trim()} onClick={()=>start(async()=>{setError('');try{const result=await onOverride!({fieldId:field.id,owner:target,reason:reason.trim()});if(result.ok){setChoosing(false);setReason('');}else setError(t('saveFailed'));}catch{setError(t('saveFailed'));}})}>{t('confirmChoice')}</button><button type="button" className="v9-button" disabled={saving} onClick={()=>setChoosing(false)}>{t('cancel')}</button></div></>}
  {error&&<p role="alert" className="v9-error">{error}</p>}
 </fieldset>;
}
export function PersonnelCompletionPanel({document,busy=false,canOverride=false,onOverride,onSave,onRefresh}:{document:Document;busy?:boolean;canOverride?:boolean;onOverride?:(input:PersonnelCompletionOverride)=>Promise<PersonnelCompletionResult>;onSave?:(values:Record<string,string>)=>Promise<PersonnelCompletionResult>;onRefresh?:()=>Promise<PersonnelCompletionResult>}){
 const t=useTranslations('personnelCompletion'),[draft,setDraft]=useState<Record<string,string>>({}),[error,setError]=useState(''),[notice,setNotice]=useState(''),[saving,start]=useTransition();
 const policy=document.personnelCompletion;if(!policy)return null;
 const locked=personnelCompletionLocked(document),disabled=busy||saving||locked;
 const values=locked?document.values:{...document.values,...draft};
 const fields=document.fields.filter(field=>field.owner==='pmLocked'&&policy.fields[field.id]&&(!field.when||values[field.when.field]===field.when.value));
 const missing=fields.filter(field=>!policy.fields[field.id].sourceValue.trim()),hr=missing.filter(field=>effectivePersonnelCompletion(document,field)==='hr'),conflicts=fields.filter(field=>policy.fields[field.id].conflict);
 const problems=personnelCompletionIssues({...document,values},{owner:'hr',final:false});
 const changed=hr.filter(field=>draft[field.id]!==undefined&&draft[field.id]!==document.values[field.id]);
 const run=(work:()=>Promise<PersonnelCompletionResult>)=>start(async()=>{setError('');setNotice('');try{const result=await work();if(result.ok)setNotice(t('saved'));else setError(t('saveFailed'));}catch{setError(t('saveFailed'));}});
 const saveHR=()=>{const changedValues=Object.fromEntries(changed.map(field=>[field.id,values[field.id]??'']));run(()=>onSave!(changedValues));};
 const issueMessage=(fieldId:string)=>{const issue=problems.find(problem=>problem.fieldId===fieldId);return issue?t('validation'+issue.code[0].toUpperCase()+issue.code.slice(1)):undefined;};
 if(!missing.length&&!conflicts.length)return null;
 return <section className="v9-panel v9-stack" aria-label={t('hrTitle')}><h3>{t('hrTitle')}</h3><p className="v9-muted">{t('hrHelp')}</p>
  {locked&&<p className="v9-notice">{t('locked')}</p>}
  {missing.map(field=><Assignment key={field.id} document={document} field={field} busy={disabled} canOverride={canOverride} onOverride={onOverride}/>)}
  {hr.length>0&&<section className="v9-stack"><h4>{t('completeMissing')}</h4>{hr.map(field=><DocumentField key={field.id} field={field} sourceLabel={null} value={values[field.id]??''} disabled={disabled||!onSave} error={issueMessage(field.id)} change={value=>setDraft(previous=>({...previous,[field.id]:value}))}/>)}<button type="button" className="v9-button v9-button-primary" disabled={disabled||!onSave||!changed.length||problems.length>0} onClick={saveHR}>{t('saveHR')}</button></section>}
  {conflicts.map(field=><Conflict key={field.id} field={field} entry={policy.fields[field.id]}/>)}
  {onRefresh&&<button type="button" className="v9-button" disabled={disabled||changed.length>0} onClick={()=>run(onRefresh)}>{t('refresh')}</button>}
  {error&&<p role="alert" className="v9-error">{error}</p>}{notice&&<p role="status" className="v9-notice">{notice}</p>}
  <p className="v9-muted">{t('keepDraftNote')}</p><PersonnelCompletionInventory/>
 </section>;
}
export function PersonnelChangeProvenance({change}:{change:PMChange}){const t=useTranslations('personnelCompletion');return change.provenance?.kind==='missing-personnel'?<small className="v9-muted">{t('changedBy',{name:change.provenance.by.name,when:onboardingTimestamp(change.provenance.at)})}</small>:null;}
