'use client';
import Link from 'next/link';
import {useRef,useState,useTransition} from 'react';
import {useRouter} from 'next/navigation';
import {useTranslations} from 'next-intl';
import {PROBATION_AUTOMATION_CATALOGUE} from '@/lib/automation/catalogues/probation';
import {automationEmailMergeWarnings,automationEmailTemplateProblems,type AutomationEmailTemplate} from '@/lib/automation/email';
import {FilterChips,LegacyBuilderCard} from '../filter-chips';
import {MultiSelect} from '../multi-select';
import {recipientKey,recipientOptions,recipientsFromKeys,type NamedOption} from '../recipients';
import {saveEmailTemplateAction} from '../actions';
import {LEGACY_BUILDERS,type AutomationFilter,type AutomationPageAccess} from '../types';
import {ConfigBanner,ConfigHead} from '@/app/lifecycle/probation/settings/config-head';
import {sortedDocumentRouting,type DocumentRouting} from '@/lib/document-signing-routing';

export type ListedEmailTemplate = { template: AutomationEmailTemplate; revision: number; retired: boolean };
export type LetterSection = { companies: NamedOption[]; company: NamedOption; templates: { id: string; name: string; state: string; version: number; outcome: string; routing?: DocumentRouting }[] } | null;
type Refs = { routings: (NamedOption & { retired?: boolean })[]; groups: NamedOption[]; people: NamedOption[] };
const catalogue = PROBATION_AUTOMATION_CATALOGUE;

/** HR Automation › Templates (prototype TemplatesPage and EmailDrawer; mockup 14). Document signing routing stays in the letter editor. */
export function TemplatesWorkspace({filter,access,emails,letters,refs}:{filter:AutomationFilter;access:AutomationPageAccess;emails:ListedEmailTemplate[];letters:LetterSection;refs:Refs}){
 const b=useTranslations('probationEmailBuilder.ui');
 const t=useTranslations('automation'),[editing,setEditing]=useState<ListedEmailTemplate|null>(null);
 const showProbation=filter==='all'||filter==='probation',legacy=(['onb','off','contract_staff'] as const).filter(m=>filter==='all'||filter===m);
 const published=new Set(letters?.templates.filter(l=>l.state==='published').map(l=>l.outcome)??[]);
 // Prototype TemplatesPage (lane M3): head, module chips, the go-live check banner, Document templates rows (name,
 // module · signing summary, Probation / Letter / version pills, Edit), then Email templates rows.
 const ready=['confirm','extend','not_confirm'].filter(o=>published.has(o)).length;
 const who=(step:DocumentRouting[number])=>{const w=step.who;
  if(w.kind==='routing')return refs.routings.find(r=>r.id===w.routingId)?.name??t('templates.signing.missing');
  if(w.kind==='group')return refs.groups.find(g=>g.id===w.groupId)?.name??t('templates.signing.missing');
  if(w.kind==='people')return t('templates.signing.people',{count:w.userIds.length});
  return t('templates.signing.'+w.kind);};
 const signing=(routing:DocumentRouting|undefined)=>routing?.length?t('templates.signing.chain',{chain:sortedDocumentRouting(routing).map(step=>t('templates.signing.action.'+step.action)+' '+who(step)).join(' → ')}):t('templates.signing.existing');
 return <main className="v9-stack pcg">
  <ConfigHead crumb={t('crumb')+' / '+t('templates.title')} title={t('templates.title')} sub={t('templates.intro')}/>
  <FilterChips path="/automation/templates" current={filter}/>
  {showProbation&&!access.probation&&filter==='probation'&&<p className="v9-notice">{t('workflows.probationNotAllowed')}</p>}
  {showProbation&&access.probation&&<>
   {letters&&<ConfigBanner tone={ready===3?'ok':'warn'} role="status" lead={t('templates.goLive',{count:ready})}>{ready===3?t('templates.goLiveReady'):t('templates.goLiveMissing')}</ConfigBanner>}
   <section className="pcg-card" aria-label={t('templates.documents')}>
    <div className="pcg-row pcg-between" style={{alignItems:'flex-start'}}><div><h2>{t('templates.documents')}</h2><p className="pcg-sub">{t('templates.documentsIntro')}</p></div>
     {letters&&<Link className="v9-button" href={`/lifecycle/probation/templates?company=${letters.company.id}`}>{t('templates.openLetterEditor')}</Link>}</div>
    {!letters?<p className="v9-muted">{t('templates.noLetterCompany')}</p>:<>
     {letters.companies.length>1&&<nav className="pcg-chips" aria-label={t('templates.company')}>{letters.companies.map(c=><Link key={c.id} className="pcg-mchip" href={`/automation/templates?module=${filter}&company=${c.id}`} aria-current={c.id===letters.company.id?'page':undefined}>{c.name}</Link>)}</nav>}
     {letters.templates.length===0&&<p className="v9-muted">{t('templates.noLetters')}</p>}
     <ul className="pcg-tl">{letters.templates.map(l=><li key={l.id} className="pcg-tl-row"><div><h3>{l.name}</h3><p>{t('modules.probation')} · {signing(l.routing)}</p></div>
      <div className="pcg-tl-pills"><span className="pcg-kp">{t('modules.probation')}</span><span className="pcg-kp pcg-kp-letter">{t('templates.letter')}</span><span className={l.state==='draft'?'pcg-kp pcg-kp-warn':'pcg-kp'}>{t('templates.versionPill',{version:l.version,state:t('templates.state.'+l.state)})}</span>
       <Link className="v9-button" aria-label={t('templates.editLetter',{name:l.name})} href={`/lifecycle/probation/templates?company=${letters.company.id}`}>{t('workflows.edit')}</Link></div></li>)}</ul>
    </>}
   </section>
   <section className="pcg-card" aria-label={t('templates.emails')}><h2>{t('templates.emails')}</h2><p className="pcg-sub">{b('moved')}</p><Link className="v9-button" href={'/lifecycle/v9?view=templates&module=probation'+(letters?'&company='+encodeURIComponent(letters.company.id):'')}>{b('openEmails')}</Link></section>
  </>}
  {legacy.map(module=><LegacyBuilderCard key={module} module={module} kind="templates" href={LEGACY_BUILDERS.templates[module]} allowed={module==='contract_staff'?access.contractStaff:access.legacy}/>)}
 </main>;
}

/** Email template editor (prototype EmailDrawer, plain text): name, on/off, subject and message with merge fields, CC. */
export function EmailEditor({initial,refs,onClose}:{initial:ListedEmailTemplate;refs:Refs;onClose:()=>void}){
 const t=useTranslations('automation'),router=useRouter(),[busy,start]=useTransition();
 const [draft,setDraft]=useState(initial.template),[revision,setRevision]=useState(initial.revision),[dirty,setDirty]=useState(initial.revision===0),[message,setMessage]=useState<{kind:'error'|'status';text:string;problems?:string[]}|null>(null);
 const fields=useRef<Record<string,HTMLInputElement|HTMLTextAreaElement|null>>({}),readOnly=initial.retired||busy;
 const change=(patch:Partial<AutomationEmailTemplate>)=>{setDraft(d=>({...d,...patch}));setDirty(true);setMessage(null);};
 const references={routingExists:(id:string)=>refs.routings.some(r=>r.id===id&&!r.retired),groupExists:(id:string)=>refs.groups.some(g=>g.id===id),personExists:(id:string)=>refs.people.some(p=>p.id===id)};
 const problems=initial.retired?[]:automationEmailTemplateProblems(draft,catalogue,references),warnings=automationEmailMergeWarnings(draft,catalogue);
 const groups=[...new Set(catalogue.mergeFields.map(m=>m.group))];
 const recipients=recipientOptions(catalogue,{routings:refs.routings,groups:refs.groups,people:refs.people},{routing:name=>t('recipients.routing',{name}),group:name=>t('recipients.group',{name})}).filter(o=>o.value!=='pending');
 const insert=(field:'subject'|'body',key:string)=>{const element=fields.current[field],current=draft[field],token=`{{${key}}}`,from=element?.selectionStart??current.length,to=element?.selectionEnd??current.length;const next=current.slice(0,from)+token+current.slice(to);change(field==='subject'?{subject:next}:{body:next});};
 const picker=(field:'subject'|'body')=><select className="automation-merge-picker" aria-label={t('templates.insertMerge',{where:t(field==='subject'?'editor.subject':'editor.message')})} value="" disabled={readOnly} onChange={e=>e.target.value&&insert(field,e.target.value)}>
  <option value="">{t('editor.insertMergeField')}</option>{groups.map(g=><optgroup key={g} label={g}>{catalogue.mergeFields.filter(m=>m.group===g).map(m=><option key={m.key} value={m.key}>{m.label}</option>)}</optgroup>)}</select>;
 const save=(retired:boolean)=>{if(!retired&&problems.length){setMessage({kind:'error',text:t('templates.fixFirst'),problems});return;}
  start(async()=>{const result=await saveEmailTemplateAction({template:draft,retired,expectedRevision:revision,reason:retired?t('templates.reasonRetire'):revision?t('templates.reasonSave'):t('templates.reasonCreate')});
   if(!result.ok){setMessage({kind:'error',text:result.detail??t('errors.unavailable'),problems:result.problems});return;}
   setRevision(result.result.revision);setDirty(false);setMessage({kind:'status',text:t('editor.saved')});router.refresh();if(retired)onClose();});};
 return <section className="pcg-card automation-editor" aria-label={t('templates.editorTitle',{name:draft.name})}>
  <div className="automation-row automation-between"><h2>{draft.name||t('templates.newName')}</h2><button type="button" className="v9-button" onClick={()=>{if(!dirty||window.confirm(t('editor.leaveUnsaved')))onClose();}}>{t('templates.close')}</button></div>
  <div className="v9-fields">
   <label className="v9-field"><span>{t('templates.name')}</span><input value={draft.name} maxLength={200} disabled={readOnly} onChange={e=>change({name:e.target.value})}/></label>
   <label className="automation-check"><input type="checkbox" checked={draft.active} disabled={readOnly} onChange={e=>change({active:e.target.checked})}/><span>{t('templates.active')}</span></label>
  </div>
  {!draft.active&&<p className="v9-notice">{t('templates.offNote')}</p>}
  <div className="v9-field"><div className="automation-row automation-between"><label htmlFor="automation-email-subject">{t('editor.subject')}</label>{picker('subject')}</div>
   <input id="automation-email-subject" ref={element=>{fields.current.subject=element;}} value={draft.subject} maxLength={500} disabled={readOnly} aria-invalid={!draft.subject.trim()} onChange={e=>change({subject:e.target.value})}/></div>
  <div className="v9-field"><div className="automation-row automation-between"><label htmlFor="automation-email-body">{t('editor.message')}</label>{picker('body')}</div>
   <textarea id="automation-email-body" ref={element=>{fields.current.body=element;}} value={draft.body} rows={10} maxLength={20000} disabled={readOnly} onChange={e=>change({body:e.target.value})}/></div>
  <div className="v9-field"><span>{t('templates.cc')}</span><MultiSelect label={t('templates.cc')} value={draft.cc.map(recipientKey)} options={recipients} disabled={readOnly} onChange={keys=>change({cc:recipientsFromKeys(keys)})}/></div>
  <p className="v9-muted">{t('editor.mergeHelp',{example:'{{employee.name}}'})}</p>
  {problems.length>0&&<section className="automation-issues" aria-label={t('editor.problems')}><b>{t('editor.problems')}</b><ul>{problems.map((p,i)=><li key={i}>{p}</li>)}</ul></section>}
  {warnings.length>0&&<section className="automation-notes" aria-label={t('editor.warnings')}><b>{t('editor.warnings')}</b><ul>{warnings.map((w,i)=><li key={i}>{w}</li>)}</ul></section>}
  {message&&<div className={message.kind==='error'?'v9-notice v9-error':'v9-notice'} role={message.kind==='error'?'alert':'status'}>{message.text}{message.problems?.length?<ul>{message.problems.map((p,i)=><li key={i}>{p}</li>)}</ul>:null}</div>}
  {!initial.retired&&<div className="automation-row">
   <button type="button" className="v9-button v9-button-primary" disabled={busy||!dirty||problems.length>0} onClick={()=>save(false)}>{t('templates.save')}</button>
   {revision>0&&<button type="button" className="v9-button" disabled={busy} onClick={()=>{if(window.confirm(t('templates.retireConfirm')))save(true);}}>{t('templates.retire')}</button>}
  </div>}
 </section>;
}
