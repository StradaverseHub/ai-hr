'use client';
import {useProbationEmailCopy} from './use-probation-email-copy';
import {useEffect,useMemo,useState,useTransition} from 'react';
import {useTranslations} from 'next-intl';
import {useRouter} from 'next/navigation';
import {EmailMergeInput} from '@/app/lifecycle/v9/email-merge-input';
import {RichBody} from '@/app/lifecycle/v9/email-definition';
import {EmailAssets} from '@/app/lifecycle/v9/email-assets';
import {convertProbationEmail,probationEmailFields,probationEmailFieldGroups,probationEmailLegacyBody,type ProbationEmailDefinition} from '@/lib/automation/probation-email-definition';
import {automationEmailTemplateProblems,automationEmailMergeWarnings,automationMergeTokens,type AutomationEmailTemplate} from '@/lib/automation/email';
import {PROBATION_AUTOMATION_CATALOGUE} from '@/lib/automation/catalogues/probation';
import {MultiSelect} from '../multi-select';
import {recipientKey,recipientOptions,recipientsFromKeys,type NamedOption} from '../recipients';
import {saveEmailTemplateAction,readEmailTemplateHistoryAction} from '../actions';
import type {ListedEmailTemplate} from './templates-workspace';

type Refs={routings:(NamedOption&{retired?:boolean})[];groups:NamedOption[];people:NamedOption[]};
export function ProbationEmailEditor({initial,refs,documents=[],onClose,onDirtyChange}:{initial:ListedEmailTemplate;refs:Refs;documents?:{id:string;name:string;type:'Letter'}[];onClose:()=>void;onDirtyChange?:(dirty:boolean)=>void}){
 const legacyCopy=useTranslations('automation');
 const{copy:t,fields,fieldGroups}=useProbationEmailCopy();
 const router=useRouter(),[busy,start]=useTransition(),[draft,setDraft]=useState<AutomationEmailTemplate>(initial.template),[revision,setRevision]=useState(initial.revision),[saved,setSaved]=useState(true),[isRetired,setRetired]=useState(initial.retired),[error,setError]=useState(''),[notice,setNotice]=useState(''),[history,setHistory]=useState<{revision:number;savedAt:string;savedBy:string;template:AutomationEmailTemplate}[]>([]),[viewing,setViewing]=useState<number|null>(null);
 useEffect(()=>onDirtyChange?.(!saved),[saved,onDirtyChange]);
 const conversion=useMemo(()=>draft.definition?{state:'ready' as const,definition:draft.definition}:convertProbationEmail(draft),[draft]);
 const definition=conversion.state==='ready'?conversion.definition:null;
 const disabled=busy||isRetired;
 const update=(change:(next:AutomationEmailTemplate)=>void)=>{setDraft(previous=>{const next=structuredClone(previous);change(next);return next;});setSaved(false);setError('');};
 const rich=(change:(next:ProbationEmailDefinition)=>void)=>update(next=>{const conversion=next.definition?{state:'ready' as const,definition:next.definition}:convertProbationEmail(next);if(conversion.state!=='ready')return;next.definition=structuredClone(conversion.definition);change(next.definition);next.body=probationEmailLegacyBody(next.definition.bodyDoc);});
 const email={id:draft.id,body:draft.body,bodyDoc:definition?.bodyDoc,images:definition?.images,files:definition?.files,links:definition?.links??[]};
 const references={routingExists:(id:string)=>refs.routings.some(row=>row.id===id&&!row.retired),groupExists:(id:string)=>refs.groups.some(row=>row.id===id),personExists:(id:string)=>refs.people.some(row=>row.id===id)};
 const warnings=definition?automationEmailMergeWarnings(draft,PROBATION_AUTOMATION_CATALOGUE):[];
 const problems=[...automationEmailTemplateProblems(draft,PROBATION_AUTOMATION_CATALOGUE,references),...warnings];
 const recipients=recipientOptions(PROBATION_AUTOMATION_CATALOGUE,{routings:refs.routings,groups:refs.groups,people:refs.people},{routing:name=>name,group:name=>name}).filter(option=>option.value!=='pending');
 const save=(retired=false)=>start(async()=>{
   const template=structuredClone(draft);if(definition)template.definition=definition;
   const result=await saveEmailTemplateAction({template,retired,expectedRevision:revision,reason:retired?'Retired Probation email in On/Off Boarding template builder':revision?'Updated Probation email in On/Off Boarding template builder':'Created Probation email in On/Off Boarding template builder'});
   if(!result.ok){setError(t('saveFailed'));return;}
   setRevision(result.result.revision);setDraft(template);setSaved(true);setNotice(t('saved'));router.refresh();if(retired)setRetired(true);
 });
 return <section className="v9-panel v9-stack" aria-label={t('editNamed',{name:draft.name})}>
  <header className="v9-heading"><h2>{draft.name}</h2><button type="button" className="v9-button" onClick={()=>{if(onDirtyChange||saved||window.confirm(t('leave')))onClose();}}>{t('back')}</button></header>
  <label className="v9-field"><span>{t('name')}</span><input value={draft.name} maxLength={200} disabled={disabled} onChange={event=>update(next=>{next.name=event.target.value;})}/></label>
  <div className="v9-email-metadata"><label className="v9-field"><span>{t('module')}</span><select value="probation" disabled><option value="probation">{t('probation')}</option></select></label><div className="v9-field"><span>{t('sender')}</span><output className="v9-input v9-readonly">OneHR</output></div><label className="v9-actions"><input type="checkbox" checked={draft.active} disabled={disabled} onChange={event=>update(next=>{next.active=event.target.checked;})}/>{t('active')}</label></div>
  {!draft.active&&<p className="v9-notice">{t('offNote')}</p>}
  <EmailMergeInput label={t('subject')} value={draft.subject} disabled={disabled} fieldGroups={fieldGroups} copy={t} tokenBraces={2} onChange={value=>update(next=>{next.subject=value;})}/>
  {definition?<>
   <RichBody email={email} templates={documents} fields={fields} copy={t} sampleValues={Object.fromEntries(fields.map(field=>[field.key,field.key==='employee.name'?t('sampleEmployee'):field.key==='case.link'?'https://example.test/sample-probation-case':t('sampleField',{field:field.label})]))} assetBaseUrl="/automation/templates/email-assets" previewCases={[]} disabled={disabled} change={change=>rich(next=>{const value={...email,bodyDoc:next.bodyDoc,images:next.images,files:next.files,links:next.links};change(value);next.bodyDoc=value.bodyDoc!;next.images=value.images??[];next.links=value.links;})} toggle={(document,checked)=>rich(next=>{next.links=next.links.filter(id=>id!==document.id);next.attachments=next.attachments.filter(id=>id!==document.id);if(checked){next.links.push(document.id);next.attachments.push(document.id);}})}/>
   <p className="v9-muted">{t('fieldHelp')}</p>
   <EmailAssets copy={t} section="images" richBody email={email} assetBaseUrl="/automation/templates/email-assets" revision={revision} ready={saved} disabled={disabled} change={change=>rich(next=>{const value={...email,bodyDoc:next.bodyDoc,images:next.images,files:next.files};change(value);next.bodyDoc=value.bodyDoc!;next.images=value.images??[];next.files=value.files??[];})}/>
  </>:<><p className="v9-notice v9-warning" role="status">{t('conversion',{name:draft.name,fields:conversion.state==='legacy'?conversion.fields.map(field=>`{{${field}}}`).join(', '):''})}</p><label className="v9-field"><span>{t('body')}</span><textarea rows={12} value={draft.body} disabled={disabled} onChange={event=>update(next=>{next.body=event.target.value;})}/></label></>}
  {warnings.length>0&&<p className="v9-notice v9-warning" role="alert">{t('conversion',{name:draft.name,fields:automationMergeTokens(draft.subject+'\n'+draft.body).filter(key=>!probationEmailFields.some(field=>field.key===key)).join(', ')})}</p>}
  <h3>{t('cc')}</h3><MultiSelect label={t('ccDefault')} value={draft.cc.map(recipientKey)} options={recipients} disabled={disabled} onChange={keys=>update(next=>{next.cc=recipientsFromKeys(keys);})}/>
  {definition&&<><fieldset className="v9-stack" disabled={disabled}><legend>{t('documents')}</legend><label className="v9-actions"><input type="checkbox" checked={definition.outcomeLetter===true} disabled={disabled} onChange={event=>rich(next=>{next.outcomeLetter=event.target.checked;})}/>{t('attachOutcome')}</label>{documents.map(document=><label key={document.id} className="v9-actions"><input type="checkbox" checked={definition.links.includes(document.id)||definition.attachments.includes(document.id)} onChange={event=>rich(next=>{next.links=next.links.filter(id=>id!==document.id);next.attachments=next.attachments.filter(id=>id!==document.id);if(event.target.checked){next.links.push(document.id);next.attachments.push(document.id);}})}/>{document.name} · {t('probationLetter')}</label>)}{!documents.length&&<p className="v9-muted">{t('noDocuments')}</p>}</fieldset>
   <EmailAssets copy={t} section="files" email={email} assetBaseUrl="/automation/templates/email-assets" revision={revision} ready={saved} disabled={disabled} change={change=>rich(next=>{const value={...email,files:next.files,images:next.images};change(value);next.files=value.files??[];next.images=value.images??[];next.bodyDoc=value.bodyDoc!;})}/>
   <h3>{t('perPerson')}</h3><p className="v9-muted">{t('perPersonHelp')}</p>{definition.slots.map(slot=><div className="v9-panel v9-stack" key={slot.id}><label className="v9-field"><span>{t('fileLabel')}</span><input value={slot.label} maxLength={500} disabled={disabled} onChange={event=>rich(next=>{next.slots.find(value=>value.id===slot.id)!.label=event.target.value;})}/></label><label><input type="checkbox" checked={slot.required} disabled={disabled} onChange={event=>rich(next=>{next.slots.find(value=>value.id===slot.id)!.required=event.target.checked;})}/>{t('required')}</label><button type="button" className="v9-button" disabled={disabled} onClick={()=>rich(next=>{next.slots=next.slots.filter(value=>value.id!==slot.id);})}>{t('removeSlot')}</button></div>)}<button type="button" className="v9-button" disabled={disabled||definition.slots.length>=50} onClick={()=>rich(next=>{next.slots.push({id:crypto.randomUUID(),label:t('newSlot'),required:false});})}>{t('addSlot')}</button>
  </>}
  {revision>0&&<details onToggle={event=>{if(event.currentTarget.open)void readEmailTemplateHistoryAction(draft.id).then(result=>{if(result.ok)setHistory(result.result);});}}><summary>{t('history')}</summary><ul className="v9-list">{history.map(item=><li key={item.revision}><button type="button" className="v9-button" onClick={()=>setViewing(viewing===item.revision?null:item.revision)}>{t('historyVersion',{version:item.revision,date:new Date(item.savedAt).toISOString().slice(0,10)})}</button>{viewing===item.revision&&<div className="v9-panel"><p>{item.template.name}</p><p>{item.template.subject}</p><pre className="v9-prewrap">{item.template.body}</pre></div>}</li>)}</ul></details>}
  {error&&<p role="alert" className="v9-notice v9-error">{error}</p>}{notice&&<p role="status">{notice}</p>}{!isRetired&&<button type="button" className="v9-button v9-button-primary" disabled={disabled||problems.length>0||(saved&&Boolean(draft.definition))} onClick={()=>save()}>{t('save')}</button>}
  {!isRetired&&revision>0&&<button type="button" className="v9-button" disabled={disabled} onClick={()=>{if(window.confirm(legacyCopy('templates.retireConfirm')))save(true);}}>{legacyCopy('templates.retire')}</button>}
 </section>;
}
