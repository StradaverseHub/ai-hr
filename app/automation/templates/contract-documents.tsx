'use client';
import {TemplateSurface} from '@/components/lifecycle-v9/template-surface';
import {useState,useTransition} from 'react';
import {useRouter} from 'next/navigation';
import {useTranslations} from 'next-intl';
import type {AutomationDocumentUsage,StoredAutomationDocumentTemplate} from '@/packs/automation/service';
import type {AutomationDocumentTemplate} from '@/lib/automation/document-template';
import type {TemplateVersion} from '@/lib/lifecycle-v9-model';
import {CONTRACT_AUTOMATION_CATALOGUE} from '@/lib/automation/catalogues/contracts';
import {TemplateVersionEditor} from '@/app/lifecycle/v9/template-version-editor';
import {TemplateRoutingEditor,type RoutingChoices} from '@/app/lifecycle/probation/templates/routing-editor';
import {saveDocumentTemplateAction,documentTemplateUsageAction,documentTemplateAction,searchContractTemplateCasesAction,loadContractTemplatePreviewAction} from '../actions';
import {MultiSelect,type MultiSelectOption} from '../multi-select';

export type ContractDocumentReferences=RoutingChoices&{conditions:Record<string,MultiSelectOption[]>;previewCases?:{id:string;label:string}[]};
export function ContractDocuments({templates,refs}:{templates:StoredAutomationDocumentTemplate[];refs:ContractDocumentReferences}){
 const t=useTranslations('automation'),tc=useTranslations('automation.contract'),router=useRouter();
 const [selected,setSelected]=useState<StoredAutomationDocumentTemplate|null>(null),[draft,setDraft]=useState<AutomationDocumentTemplate|null>(null),[revision,setRevision]=useState(0),[liveVersion,setLiveVersion]=useState<number|null>(null),[editing,setEditing]=useState(false),[dirty,setDirty]=useState(false),[busy,start]=useTransition(),[notice,setNotice]=useState('');
 const [previewCases,setPreviewCases]=useState(refs.previewCases??[]),[previewSearch,setPreviewSearch]=useState('');
 const [previewVersion,setPreviewVersion]=useState<number|null>(null),[tab,setTab]=useState<'content'|'routing'|'history'>('content');
 const [usage,setUsage]=useState<AutomationDocumentUsage|null>(null),[versionNote,setVersionNote]=useState('');
 const history=usage?.versions??[];
 const refreshHistory=async(id:string)=>{const result=await documentTemplateUsageAction(id);if(result.ok)setUsage(result.result);else setNotice(result.detail??t('errors.unavailable'));};
 const act=(action:'publishVersion'|'deleteVersion'|'deleteTemplate',version?:number)=>{if(!draft)return;start(async()=>{try{const result=await documentTemplateAction({id:draft.id,expectedRevision:revision,action,version});if(!result.ok){setNotice(result.detail??t('errors.unavailable'));return;}setRevision(result.result.revision);if(action==='publishVersion'){setLiveVersion(version??null);const published=history.find(row=>row.version===version);if(published){setDraft(structuredClone(published.template));setPreviewVersion(published.version);setEditing(false);}}if(action==='deleteTemplate'){setDraft(null);setSelected(null);setUsage(null);}else await refreshHistory(draft.id);router.refresh();}catch{setNotice(t('errors.unavailable'));}});};
 const fields=CONTRACT_AUTOMATION_CATALOGUE.mergeFields,groups=[...new Set(fields.map(f=>f.group))].map(label=>({label,fields:fields.filter(f=>f.group===label).map(f=>({key:f.key,label:f.label}))}));
 const open=(row:StoredAutomationDocumentTemplate)=>{if(dirty&&!window.confirm(t('editor.leaveUnsaved')))return;setTab('content');setSelected(row);setDraft(structuredClone(row.template));setRevision(row.revision);setLiveVersion(row.liveVersion);setEditing(row.liveVersion!==(row.currentVersion??row.revision)&&!row.retired);setDirty(false);setNotice('');setUsage(null);setVersionNote('');setPreviewVersion(row.currentVersion??row.revision);void refreshHistory(row.template.id);};
 const create=()=>{if(dirty&&!window.confirm(t('editor.leaveUnsaved')))return;setTab('content');setSelected(null);setDraft({id:crypto.randomUUID(),module:'contract_staff',name:tc('newDocument'),description:'',blocks:[],fields:[],routing:[],rules:{}});setRevision(0);setLiveVersion(null);setEditing(true);setDirty(true);setNotice('');setUsage(null);setVersionNote('');setPreviewVersion(null);};
 const change=(patch:Partial<AutomationDocumentTemplate>)=>{setDraft(value=>value?{...value,...patch}:value);setDirty(true);setNotice('');};
 const save=(publish:boolean,retired=false)=>{if(!draft)return;start(async()=>{const result=await saveDocumentTemplateAction({template:draft,expectedRevision:revision,publish,retired,note:versionNote});if(!result.ok){setNotice(result.detail??t('errors.unavailable'));return;}setRevision(result.result.revision);if(publish)setLiveVersion(result.result.revision);setDirty(false);setPreviewVersion(result.result.revision);setEditing(!publish&&!retired);setNotice([t('editor.saved'),...result.result.warnings].join(' '));router.refresh();if(retired){setDraft(null);setSelected(null);}});};
 const close=()=>{setDraft(null);setSelected(null);setDirty(false);};
 if(draft){const readOnly=!editing||busy||selected?.retired===true;
  const version:TemplateVersion={version:editing?revision+1:previewVersion??selected?.currentVersion??revision,state:editing?'draft':'published',at:'',by:'',blocks:draft.blocks,fields:draft.fields,routing:draft.routing};
  return <TemplateSurface kind="document" label="Edit document template" heading={<h2>{draft.name}</h2>} close={close} closeDisabled={busy} canClose={()=>!dirty||window.confirm(t('editor.leaveUnsaved'))}><section className="v9-stack" aria-label={draft.name}>
   <div role="tablist" className="v9-tabs" aria-label="Document template"><button type="button" role="tab" aria-selected={tab==='content'} onClick={()=>setTab('content')}>Content</button><button type="button" role="tab" aria-selected={tab==='routing'} onClick={()=>setTab('routing')}>Routing</button><button type="button" role="tab" aria-selected={tab==='history'} onClick={()=>{setTab('history');if(revision)start(()=>refreshHistory(draft.id));}}>Version history</button></div>
   <p>{tc('versionLine',{version:revision,live:liveVersion??0})}</p>
   <label className="v9-field"><span>{t('templates.name')}</span><input className="v9-input" value={draft.name} maxLength={200} disabled={readOnly} onChange={e=>change({name:e.target.value})}/></label>
   <label className="v9-field"><span>{tc('description')}</span><textarea value={draft.description} maxLength={2000} disabled={readOnly} onChange={e=>change({description:e.target.value})}/></label>
   {!editing&&!selected?.retired&&<button type="button" className="v9-button" disabled={busy} onClick={()=>{setEditing(true);setDirty(true);}}>{tc('newDraft')}</button>}
   {tab==='content'&&<><fieldset className="v9-panel v9-stack" disabled={readOnly}><legend>{tc('matching')}</legend><div className="v9-fields">
    {(['businessGroup','company','department','jobTitle','decision'] as const).map(field=><div key={field} className="v9-field"><span>{tc('match.'+field)}</span><MultiSelect label={tc('match.'+field)} value={draft.rules[field]??[]} options={field==='decision'?['Renew','End','Convert to permanent'].map(value=>({value,label:value})):refs.conditions[field]??[]} disabled={readOnly} onChange={values=>change({rules:{...draft.rules,[field]:values}})}/></div>)}
   </div></fieldset>
   <div className="v9-actions"><label className="v9-field"><span>Find a permitted Contract case for preview</span><input className="v9-input" value={previewSearch} maxLength={100} onChange={event=>setPreviewSearch(event.target.value)}/></label><button type="button" className="v9-button" disabled={busy} onClick={()=>start(async()=>{const result=await searchContractTemplateCasesAction(previewSearch);if(result.ok)setPreviewCases(result.result);else setNotice(result.detail??t('errors.unavailable'));})}>Find cases</button></div>
   <p className="v9-muted">Preview reads only cases you may view. Current Payroll pay is never included in this preview.</p>
   <TemplateVersionEditor useRoutingSigners allowPrefilledMergeFields={false} showMissingValues={false} previewCases={previewCases} loadPreview={async id=>{const result=await loadContractTemplatePreviewAction(id);return result.ok?{ok:true,values:result.result}:{ok:false,error:result.detail??t('errors.unavailable')};}} name={draft.name} version={version} disabled={readOnly} personnelPicker mergeFieldGroups={groups} change={mutate=>{const next=structuredClone(version);mutate(next);change({blocks:next.blocks,fields:next.fields});}}/>
   </>}
   {tab==='routing'&&<><TemplateRoutingEditor value={draft.routing} blocks={draft.blocks} choices={refs} editable={!readOnly} policy={{requireSign:false,requireOwner:true}} onChange={routing=>change({routing})} onBlocksChange={blocks=>change({blocks})} newId={()=>crypto.randomUUID()}/>
   <p className="v9-muted">{tc('routingPolicy')}</p></>}
   {notice&&<p className="v9-notice" role="status">{notice}</p>}
   <div className="v9-actions">
    {editing&&<><label className="v9-field"><span>Version note</span><input className="v9-input" value={versionNote} maxLength={1000} disabled={busy} onChange={event=>{setVersionNote(event.target.value);setDirty(true);}}/></label><button type="button" className="v9-button" disabled={busy||!dirty} onClick={()=>save(false)}>{tc('saveDraft')}</button><button type="button" className="v9-button v9-button-primary" disabled={busy} onClick={()=>save(true)}>{tc('publish')}</button></>}

    <button type="button" className="v9-button" disabled={busy||dirty||!usage||!!usage.deleteReason} title={usage?.deleteReason??(!usage?'Checking template usage':undefined)} onClick={()=>act('deleteTemplate')}>Delete template</button>
    {usage?.deleteReason&&<p className="v9-muted">{usage.deleteReason}</p>}
    {revision>0&&!selected?.retired&&<button type="button" className="v9-button" disabled={busy||dirty} onClick={()=>save(false,true)}>{t('templates.retire')}</button>}
   </div>
   {tab==='history'&&usage&&<section className="v9-panel"><h3>{tc('history')}</h3><p className="v9-muted">Latest 100 saved versions. New documents use the version in use; existing documents retain their saved version.</p><p>{usage.documents} generated documents</p><ul className="v9-list">{history.map(row=><li key={row.version}><div className="v9-actions"><button type="button" className="v9-button" disabled={busy||dirty} onClick={()=>{setDraft(structuredClone(row.template));setPreviewVersion(row.version);setEditing(false);setTab('content');}}>{tc('version',{version:row.version})}</button><span>{row.state==='inUse'?'In use':row.state==='published'?'Published':'Draft'} · {row.documents} documents · {new Date(row.savedAt).toLocaleString()}</span>{row.version!==liveVersion&&<button type="button" className="v9-button" disabled={busy||dirty||selected?.retired} onClick={()=>act('publishVersion',row.version)}>Publish</button>}<button type="button" className="v9-button" disabled={busy||dirty||!row.canDelete||history.length===1} onClick={()=>act('deleteVersion',row.version)}>Delete version</button></div>{row.note&&<p>{row.note}</p>}</li>)}</ul></section>}
  </section></TemplateSurface>;
 }
 return <section className="pcg-card" aria-label={tc('documents')}><div className="pcg-row pcg-between"><div><h2>{tc('documents')}</h2><p className="pcg-sub">{tc('documentsHelp')}</p></div><button type="button" className="v9-button v9-button-primary" onClick={create}>{tc('newDocument')}</button></div>
  {!templates.length&&<p className="v9-muted">{t('templates.noLetters')}</p>}
  <ul className="pcg-tl">{templates.map(row=><li key={row.template.id} className="pcg-tl-row"><div><h3>{row.template.name}</h3><p>{row.template.description}</p></div><div className="pcg-tl-pills"><span className="pcg-kp">{t('modules.contract_staff')}</span><span className="pcg-kp">{row.retired?t('status.retired'):row.liveVersion?tc('versionLine',{version:row.revision,live:row.liveVersion}):tc('draftOnly')}</span><button type="button" className="v9-button" onClick={()=>open(row)}>{t('workflows.edit')}</button></div></li>)}</ul>
 </section>;
}
