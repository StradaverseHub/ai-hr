'use client';
import {useState,useTransition} from 'react';
import {useRouter} from 'next/navigation';
import {useTranslations} from 'next-intl';
import type {StoredAutomationDocumentTemplate} from '@/packs/automation/service';
import type {AutomationDocumentTemplate} from '@/lib/automation/document-template';
import type {TemplateVersion} from '@/lib/lifecycle-v9-model';
import {CONTRACT_AUTOMATION_CATALOGUE} from '@/lib/automation/catalogues/contracts';
import {TemplateVersionEditor} from '@/app/lifecycle/v9/template-version-editor';
import {TemplateRoutingEditor,type RoutingChoices} from '@/app/lifecycle/probation/templates/routing-editor';
import {saveDocumentTemplateAction,documentTemplateVersionsAction} from '../actions';
import {MultiSelect,type MultiSelectOption} from '../multi-select';

export type ContractDocumentReferences=RoutingChoices&{conditions:Record<string,MultiSelectOption[]>};
export function ContractDocuments({templates,refs}:{templates:StoredAutomationDocumentTemplate[];refs:ContractDocumentReferences}){
 const t=useTranslations('automation'),tc=useTranslations('automation.contract'),router=useRouter();
 const [selected,setSelected]=useState<StoredAutomationDocumentTemplate|null>(null),[draft,setDraft]=useState<AutomationDocumentTemplate|null>(null),[revision,setRevision]=useState(0),[liveVersion,setLiveVersion]=useState<number|null>(null),[editing,setEditing]=useState(false),[dirty,setDirty]=useState(false),[busy,start]=useTransition(),[notice,setNotice]=useState('');
 const [previewVersion,setPreviewVersion]=useState<number|null>(null);
 const [history,setHistory]=useState<{version:number;template:AutomationDocumentTemplate;savedAt:string}[]>([]);
 const fields=CONTRACT_AUTOMATION_CATALOGUE.mergeFields,groups=[...new Set(fields.map(f=>f.group))].map(label=>({label,fields:fields.filter(f=>f.group===label).map(f=>({key:f.key,label:f.label}))}));
 const open=(row:StoredAutomationDocumentTemplate)=>{if(dirty&&!window.confirm(t('editor.leaveUnsaved')))return;setSelected(row);setDraft(structuredClone(row.template));setRevision(row.revision);setLiveVersion(row.liveVersion);setEditing(row.liveVersion!==row.revision&&!row.retired);setDirty(false);setNotice('');setHistory([]);setPreviewVersion(null);};
 const create=()=>{if(dirty&&!window.confirm(t('editor.leaveUnsaved')))return;setSelected(null);setDraft({id:crypto.randomUUID(),module:'contract_staff',name:tc('newDocument'),description:'',blocks:[],fields:[],routing:[],rules:{}});setRevision(0);setLiveVersion(null);setEditing(true);setDirty(true);setNotice('');setHistory([]);setPreviewVersion(null);};
 const change=(patch:Partial<AutomationDocumentTemplate>)=>{setDraft(value=>value?{...value,...patch}:value);setDirty(true);setNotice('');};
 const save=(publish:boolean,retired=false)=>{if(!draft)return;start(async()=>{const result=await saveDocumentTemplateAction({template:draft,expectedRevision:revision,publish,retired});if(!result.ok){setNotice(result.detail??t('errors.unavailable'));return;}setRevision(result.result.revision);if(publish)setLiveVersion(result.result.revision);setDirty(false);setPreviewVersion(null);setEditing(!publish&&!retired);setNotice([t('editor.saved'),...result.result.warnings].join(' '));router.refresh();if(retired){setDraft(null);setSelected(null);}});};
 const close=()=>{if(dirty&&!window.confirm(t('editor.leaveUnsaved')))return;setDraft(null);setSelected(null);setDirty(false);};
 if(draft){const readOnly=!editing||busy||selected?.retired===true;
  const version:TemplateVersion={version:editing?revision+1:previewVersion??revision,state:editing?'draft':'published',at:'',by:'',blocks:draft.blocks,fields:draft.fields};
  return <section className="v9-stack" aria-label={draft.name}>
   <div className="pcg-row pcg-between"><h2>{draft.name}</h2><button className="v9-button" type="button" disabled={busy} onClick={close}>{t('templates.close')}</button></div>
   <p>{tc('versionLine',{version:revision,live:liveVersion??0})}</p>
   <label className="v9-field"><span>{t('templates.name')}</span><input value={draft.name} maxLength={200} disabled={readOnly} onChange={e=>change({name:e.target.value})}/></label>
   <label className="v9-field"><span>{tc('description')}</span><textarea value={draft.description} maxLength={2000} disabled={readOnly} onChange={e=>change({description:e.target.value})}/></label>
   {!editing&&!selected?.retired&&<button type="button" className="v9-button" disabled={busy} onClick={()=>{setEditing(true);setDirty(true);}}>{tc('newDraft')}</button>}
   <fieldset className="v9-panel v9-stack" disabled={readOnly}><legend>{tc('matching')}</legend><div className="v9-fields">
    {(['businessGroup','company','department','jobTitle','decision'] as const).map(field=><MultiSelect key={field} label={tc('match.'+field)} value={draft.rules[field]??[]} options={field==='decision'?['Renew','End','Convert to permanent'].map(value=>({value,label:value})):refs.conditions[field]??[]} disabled={readOnly} onChange={values=>change({rules:{...draft.rules,[field]:values}})}/>)}
   </div></fieldset>
   <TemplateVersionEditor name={draft.name} version={version} disabled={readOnly} personnelPicker mergeFieldGroups={groups} change={mutate=>{const next=structuredClone(version);mutate(next);change({blocks:next.blocks,fields:next.fields});}}/>
   <TemplateRoutingEditor value={draft.routing} blocks={draft.blocks} choices={refs} editable={!readOnly} policy={{requireSign:false,requireOwner:true}} onChange={routing=>change({routing})} onBlocksChange={blocks=>change({blocks})} newId={()=>crypto.randomUUID()}/>
   <p className="v9-muted">{tc('routingPolicy')}</p>
   {notice&&<p className="v9-notice" role="status">{notice}</p>}
   <div className="v9-actions">
    {editing&&<><button type="button" className="v9-button" disabled={busy||!dirty} onClick={()=>save(false)}>{tc('saveDraft')}</button><button type="button" className="v9-button v9-button-primary" disabled={busy} onClick={()=>save(true)}>{tc('publish')}</button></>}
    {revision>0&&<button type="button" className="v9-button" disabled={busy} onClick={()=>start(async()=>{const result=await documentTemplateVersionsAction(draft.id);if(result.ok)setHistory(result.result);else setNotice(result.detail??t('errors.unavailable'));})}>{tc('history')}</button>}
    {revision>0&&!selected?.retired&&<button type="button" className="v9-button" disabled={busy||dirty} onClick={()=>{if(window.confirm(t('templates.retireConfirm')))save(false,true);}}>{t('templates.retire')}</button>}
   </div>
   {history.length>0&&<section className="v9-panel"><h3>{tc('history')}</h3><ul className="v9-list">{history.map(row=><li key={row.version}><button type="button" className="v9-button" disabled={busy||dirty} onClick={()=>{setDraft(structuredClone(row.template));setPreviewVersion(row.version);setEditing(false);}}>{tc('version',{version:row.version})}</button> · {row.version===liveVersion?tc('inUse'):tc('historical')}</li>)}</ul></section>}
  </section>;
 }
 return <section className="pcg-card" aria-label={tc('documents')}><div className="pcg-row pcg-between"><div><h2>{tc('documents')}</h2><p className="pcg-sub">{tc('documentsHelp')}</p></div><button type="button" className="v9-button v9-button-primary" onClick={create}>{tc('newDocument')}</button></div>
  {!templates.length&&<p className="v9-muted">{t('templates.noLetters')}</p>}
  <ul className="pcg-tl">{templates.map(row=><li key={row.template.id} className="pcg-tl-row"><div><h3>{row.template.name}</h3><p>{row.template.description}</p></div><div className="pcg-tl-pills"><span className="pcg-kp">{t('modules.contract_staff')}</span><span className="pcg-kp">{row.retired?t('status.retired'):row.liveVersion?tc('versionLine',{version:row.revision,live:row.liveVersion}):tc('draftOnly')}</span><button type="button" className="v9-button" onClick={()=>open(row)}>{t('workflows.edit')}</button></div></li>)}</ul>
 </section>;
}
