'use client';
import {EmailBodyEditor,type EmailBodyEditorHandle} from '@/components/email-body-editor';
import {emptyTableCells,EMAIL_TABLE_WARN_COLUMNS,summariseEmailBody} from '@/lib/email-body/doc';
import {AutomationEmailAssets,AutomationEmailFileSlots} from './automation-email-assets';
import {emailHtmlNearLimit} from '@/lib/email-body/render';
import {automationEmailPreview,type AutomationEmailSample} from '@/lib/automation-email-preview';
import {automationEmailBodyDoc,automationEmailBodyText} from '@/lib/automation/email';
import {useRef,useState,useTransition} from 'react';
import {useRouter} from 'next/navigation';
import {useTranslations} from 'next-intl';
import {PROBATION_AUTOMATION_CATALOGUE} from '@/lib/automation/catalogues/probation';
import {automationEmailMergeWarnings,automationEmailTemplateProblems,type AutomationEmailTemplate} from '@/lib/automation/email';
import {MultiSelect} from '../multi-select';
import {recipientKey,recipientOptions,recipientsFromKeys} from '../recipients';
import {saveEmailTemplateAction,sendTestEmailAction} from '../actions';
import {automationCatalogue} from '@/lib/automation/catalogues';


import type {ListedEmailTemplate,Refs} from './templates-workspace';
/** Email template editor (prototype EmailDrawer, plain text): name, on/off, subject and message with merge fields, CC. */
export function EmailEditor({initial,refs,onClose,documents=[]}:{initial:ListedEmailTemplate;refs:Refs;onClose:()=>void;documents?:{id:string;name:string}[]}){
 const catalogue=automationCatalogue(initial.template.module)??PROBATION_AUTOMATION_CATALOGUE;
 const t=useTranslations('automation'),p=useTranslations('automation.emailPreview'),router=useRouter(),[busy,start]=useTransition();
 const [draft,setDraft]=useState(initial.template),[revision,setRevision]=useState(initial.revision),[dirty,setDirty]=useState(initial.revision===0),[message,setMessage]=useState<{kind:'error'|'status';text:string;problems?:string[]}|null>(null);
 const [mode,setMode]=useState<'edit'|'preview'>('edit'),[sample,setSample]=useState<AutomationEmailSample>('complete'),[width,setWidth]=useState<'desktop'|'phone'>('desktop'),[format,setFormat]=useState<'email'|'text'>('email'),[confirmEmpty,setConfirmEmpty]=useState(false);
 const editor=useRef<EmailBodyEditorHandle>(null),doc=automationEmailBodyDoc(draft),emptyCells=emptyTableCells(doc),wide=doc.content.some(block=>block.type==='table'&&block.content.some(row=>row.content.length>=EMAIL_TABLE_WARN_COLUMNS));
 let preview:ReturnType<typeof automationEmailPreview>|null=null,previewError:string|null=null;
 if(mode==='preview')try{preview=automationEmailPreview(draft,catalogue,sample,documents);}catch{previewError=p('unavailable');}
 const fields=useRef<Record<string,HTMLInputElement|HTMLTextAreaElement|null>>({}),readOnly=initial.retired||busy;
 const change=(patch:Partial<AutomationEmailTemplate>)=>{setDraft(d=>({...d,...patch}));setDirty(true);setConfirmEmpty(false);setMessage(null);};
 const references={routingExists:(id:string)=>refs.routings.some(r=>r.id===id&&!r.retired),groupExists:(id:string)=>refs.groups.some(g=>g.id===id),personExists:(id:string)=>refs.people.some(p=>p.id===id)};
 const problems=initial.retired?[]:[...automationEmailTemplateProblems(draft,catalogue,references),...((draft.documentIds??[]).some(id=>!documents.some(document=>document.id===id))?[p('documentUnavailable')]:[])],warnings=automationEmailMergeWarnings(draft,catalogue);
 const groups=[...new Set(catalogue.mergeFields.map(m=>m.group))];
 const recipients=recipientOptions(catalogue,{routings:refs.routings,groups:refs.groups,people:refs.people},{routing:name=>t('recipients.routing',{name}),group:name=>t('recipients.group',{name})}).filter(o=>o.value!=='pending');
 const insert=(field:'subject'|'body',key:string)=>{const element=fields.current[field],current=draft[field],token=`{{${key}}}`,from=element?.selectionStart??current.length,to=element?.selectionEnd??current.length;const next=current.slice(0,from)+token+current.slice(to);change(field==='subject'?{subject:next}:{body:next});};
 const picker=(field:'subject'|'body')=><select className="automation-merge-picker" aria-label={t('templates.insertMerge',{where:t(field==='subject'?'editor.subject':'editor.message')})} value="" disabled={readOnly} onChange={e=>e.target.value&&insert(field,e.target.value)}>
  <option value="">{t('editor.insertMergeField')}</option>{groups.map(g=><optgroup key={g} label={g}>{catalogue.mergeFields.filter(m=>m.group===g).map(m=><option key={m.key} value={m.key}>{m.label}</option>)}</optgroup>)}</select>;
 const save=(retired:boolean,acceptEmpty=false)=>{if(!retired&&problems.length){setMessage({kind:'error',text:t('templates.fixFirst'),problems});return;}
  if(!retired&&emptyCells.length&&!acceptEmpty){setConfirmEmpty(true);return;}
  start(async()=>{try{const result=await saveEmailTemplateAction({template:draft,retired,expectedRevision:revision,reason:retired?t('templates.reasonRetire'):revision?t('templates.reasonSave'):t('templates.reasonCreate')});
   if(!result.ok){setMessage({kind:'error',text:result.detail??t('errors.unavailable'),problems:result.problems});return;}
   setRevision(result.result.revision);setDirty(false);setConfirmEmpty(false);setMessage({kind:'status',text:t('editor.saved')});router.refresh();if(retired)onClose();}catch{setMessage({kind:'error',text:t('errors.unavailable')});}});};
 const sendTest=()=>start(async()=>{
  try{const result=await sendTestEmailAction({templateId:draft.id,revision,sample,requestId:crypto.randomUUID()});
  setMessage(result.ok?{kind:'status',text:p('queued')}:{kind:'error',text:result.detail??p('failed')});
  }catch{setMessage({kind:'error',text:p('failed')});}
 });
 return <section className="pcg-card automation-editor" aria-label={t('templates.editorTitle',{name:draft.name})}>
  <div className="automation-row automation-between"><h2>{draft.name||t('templates.newName')}</h2><button type="button" className="v9-button" onClick={()=>{if(!dirty||window.confirm(t('editor.leaveUnsaved')))onClose();}}>{t('templates.close')}</button></div>
  <div className="v9-fields">
   <label className="v9-field"><span>{t('templates.name')}</span><input value={draft.name} maxLength={200} disabled={readOnly} onChange={e=>change({name:e.target.value})}/></label>
   <label className="automation-check"><input type="checkbox" checked={draft.active} disabled={readOnly} onChange={e=>change({active:e.target.checked})}/><span>{t('templates.active')}</span></label>
  </div>
  {!draft.active&&<p className="v9-notice">{t('templates.offNote')}</p>}
  <p className="v9-muted">{p('senderHelp')}</p>
  <div className="v9-field"><div className="automation-row automation-between"><label htmlFor="automation-email-subject">{t('editor.subject')}</label>{picker('subject')}</div>
   <input id="automation-email-subject" ref={element=>{fields.current.subject=element;}} value={draft.subject} maxLength={500} disabled={readOnly} aria-invalid={!draft.subject.trim()} onChange={e=>change({subject:e.target.value})}/></div>
  <div className="automation-row" role="tablist" aria-label={p('view')}>{(['edit','preview']as const).map(value=><button key={value} type="button" role="tab" aria-selected={mode===value} className={'v9-button'+(mode===value?' v9-button-primary':'')} onClick={()=>setMode(value)}>{value==='edit'?p('edit'):p('preview')}</button>)}</div>
  {mode==='edit'?<div className="v9-field"><span>{t('editor.message')}</span><EmailBodyEditor ref={editor} value={doc} onChange={bodyDoc=>change({bodyDoc,body:automationEmailBodyText(bodyDoc)})} disabled={readOnly} fields={catalogue.mergeFields.map(field=>({key:field.key,label:field.label}))}
   images={(draft.assets??[]).filter(asset=>asset.kind==='image').map(asset=>({id:asset.id,name:asset.name,alt:asset.alt??'',src:'/automation/templates/assets/'+asset.id}))}
   documents={documents.map(document=>({...document,kind:'form'}))} onDocumentLinked={id=>{if(!(draft.documentIds??[]).includes(id))change({documentIds:[...(draft.documentIds??[]),id]});}} aria-label={t('editor.message')}/></div>:<section className="v9-stack" aria-label={p('label')}>
   <div className="automation-row"><label className="v9-field"><span>{p('sample')}</span><select value={sample} onChange={event=>setSample(event.target.value as AutomationEmailSample)}><option value="complete">{p('complete')}</option><option value="noDecision">{p('noDecision')}</option></select></label><div className="automation-row" role="group" aria-label={p('width')}>{(['desktop','phone']as const).map(value=><button key={value} type="button" className="v9-button" aria-pressed={width===value} onClick={()=>setWidth(value)}>{value==='desktop'?p('desktop'):p('phone')}</button>)}</div><div className="automation-row" role="group" aria-label={p('format')}>{(['email','text']as const).map(value=><button key={value} type="button" className="v9-button" aria-pressed={format===value} onClick={()=>setFormat(value)}>{value==='email'?p('email'):p('text')}</button>)}</div></div>
   <p className="v9-muted">{p('fictional')}</p>
   {!initial.retired&&<div className="automation-row"><button type="button" className="v9-button" disabled={busy||dirty||revision===0||problems.length>0} onClick={sendTest}>{busy?p('wait'):p('sendTest')}</button>{(dirty||revision===0)&&<span className="v9-muted">{p('saveFirst')}</span>}</div>}
   {previewError&&<p className="v9-notice v9-error" role="alert">{previewError}</p>}
   {preview&&<>{preview.missing.length>0&&<p className="v9-notice v9-warning" role="status">{p('missing',{fields:preview.missing.map(key=>catalogue.mergeFields.find(field=>field.key===key)?.label??key).join(', ')})}</p>}{emailHtmlNearLimit(preview.html)&&<p className="v9-notice v9-warning">{p('nearLimit')}</p>}<div className="automation-email-preview" data-preview-width={width}><p><strong>{p('subject')}</strong> {preview.subject}</p>{format==='email'?<div dangerouslySetInnerHTML={{__html:preview.html.replace(/src="cid:v9-image\.([0-9a-f-]{36})@aihr"/g,(_,id:string)=>`src="/automation/templates/assets/${id}"`)}}/>:<pre className="v9-prewrap">{preview.text}</pre>}</div>{format==='text'&&<p className="v9-muted">{p('plainHint')}</p>}</>}
  </section>}
  {wide&&<p className="v9-notice v9-warning">{p('wide')}</p>}
  <div className="v9-field"><span>{t('templates.cc')}</span><MultiSelect label={t('templates.cc')} value={draft.cc.map(recipientKey)} options={recipients} disabled={readOnly} onChange={keys=>change({cc:recipientsFromKeys(keys)})}/></div>
  <p className="v9-muted">{t('editor.mergeHelp',{example:'{{employee.name}}'})}</p>
  <AutomationEmailAssets template={draft} revision={revision} ready={!dirty&&revision>0} disabled={readOnly} onChange={change}/>
  {draft.module==='contract_staff'&&<>
   <fieldset className="v9-stack" disabled={readOnly}><legend>{p('documents')}</legend><p className="v9-muted">{p('documentsHelp')}</p>{documents.map(document=><label key={document.id} className="automation-check"><input type="checkbox" checked={(draft.documentIds??[]).includes(document.id)} onChange={event=>{if(!event.target.checked&&summariseEmailBody(doc).documentLinks.has(document.id)){setMessage({kind:'error',text:p('removeDocumentLink')});return;}change({documentIds:event.target.checked?[...(draft.documentIds??[]),document.id]:(draft.documentIds??[]).filter(id=>id!==document.id)});}}/>{document.name}</label>)}{!documents.length&&<p className="v9-muted">{p('noDocuments')}</p>}</fieldset>
   <AutomationEmailFileSlots slots={draft.slots??[]} disabled={readOnly} onChange={slots=>change({slots})}/>
  </>}
  {problems.length>0&&<section className="automation-issues" aria-label={t('editor.problems')}><b>{t('editor.problems')}</b><ul>{problems.map((p,i)=><li key={i}>{p}</li>)}</ul></section>}
  {warnings.length>0&&<section className="automation-notes" aria-label={t('editor.warnings')}><b>{t('editor.warnings')}</b><ul>{warnings.map((w,i)=><li key={i}>{w}</li>)}</ul></section>}
  {message&&<div className={message.kind==='error'?'v9-notice v9-error':'v9-notice'} role={message.kind==='error'?'alert':'status'}>{message.text}{message.problems?.length?<ul>{message.problems.map((p,i)=><li key={i}>{p}</li>)}</ul>:null}</div>}
  {!initial.retired&&<div className="automation-row">
   <button type="button" className="v9-button v9-button-primary" disabled={busy||!dirty||problems.length>0} onClick={()=>save(false)}>{t('templates.save')}</button>
   {revision>0&&<button type="button" className="v9-button" disabled={busy} onClick={()=>{if(window.confirm(t('templates.retireConfirm')))save(true);}}>{t('templates.retire')}</button>}
  </div>}
  {confirmEmpty&&<div className="v9-notice v9-warning" role="alert"><p>{p('emptyCells',{count:emptyCells.length})}</p><div className="automation-row"><button type="button" className="v9-button" onClick={()=>{setMode('edit');setConfirmEmpty(false);requestAnimationFrame(()=>editor.current?.focusTableCell(emptyCells[0]));}}>{p('show')}</button><button type="button" className="v9-button" disabled={busy} onClick={()=>save(false,true)}>{p('saveAnyway')}</button></div></div>}
 </section>;
}
