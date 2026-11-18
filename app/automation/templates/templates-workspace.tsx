'use client';
import type {ContractTemplateEditorTarget} from '../editor-target';
import type {ReactNode} from 'react';
import Link from 'next/link';
import {useState} from 'react';
import {useTranslations} from 'next-intl';
import {type AutomationEmailTemplate} from '@/lib/automation/email';
import {FilterChips,LegacyBuilderCard} from '../filter-chips';
import {type NamedOption} from '../recipients';
import {LEGACY_BUILDERS,type AutomationFilter,type AutomationPageAccess} from '../types';
import {ConfigBanner,ConfigHead} from '@/app/lifecycle/probation/settings/config-head';
import {sortedDocumentRouting,type DocumentRouting} from '@/lib/document-signing-routing';
import {ContractTemplates,type ContractTemplatesData} from './contract-templates';
import {EmailEditor} from './email-editor';

export type ListedEmailTemplate = { template: AutomationEmailTemplate; revision: number; retired: boolean };
export type LetterSection = { companies: NamedOption[]; company: NamedOption; templates: { id: string; name: string; state: string; version: number; outcome: string; routing?: DocumentRouting }[] } | null;
export type Refs = { routings: (NamedOption & { retired?: boolean })[]; groups: NamedOption[]; people: NamedOption[] };

/** HR Automation › Templates (prototype TemplatesPage and EmailDrawer; mockup 14). Document signing routing stays in the letter editor. */
export function TemplatesWorkspace({filter,access,emails,letters,refs,contract,lifecycleSection,contractSection,initialContractTarget}:{filter:AutomationFilter;access:AutomationPageAccess;emails:ListedEmailTemplate[];letters:LetterSection;refs:Refs;contract?:ContractTemplatesData;lifecycleSection?:ReactNode;contractSection?:ReactNode;initialContractTarget?:ContractTemplateEditorTarget}){
 const t=useTranslations('automation'),[editing,setEditing]=useState<ListedEmailTemplate|null>(null);
 const showProbation=filter==='all'||filter==='probation',legacy=(['onb','off','contract_staff'] as const).filter(m=>(filter==='all'||filter===m)&&(!lifecycleSection||m==='contract_staff')&&(!(contract||contractSection)||m!=='contract_staff'));
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
   <section className="pcg-card" aria-label={t('templates.emails')}>
    <div className="pcg-row pcg-between" style={{alignItems:'flex-start'}}><div><h2>{t('templates.emails')}</h2><p className="pcg-sub">{t('templates.emailsIntro')}</p></div>
     <button type="button" className="v9-button v9-button-primary" onClick={()=>setEditing({template:{id:crypto.randomUUID(),module:'probation',name:t('templates.newName'),active:true,subject:'',body:'',cc:[]},revision:0,retired:false})}>{t('templates.newEmail')}</button></div>
    {emails.length===0&&<p className="v9-muted">{t('templates.noEmails')}</p>}
    <ul className="pcg-tl">{emails.map(item=><li key={item.template.id} className="pcg-tl-row">
     <div><h3>{item.template.name}</h3><p>{t('modules.probation')} · {item.template.subject}</p></div>
     <div className="pcg-tl-pills">
      <span className="pcg-kp">{t('modules.probation')}</span>
      {item.retired?<span className="pcg-kp">{t('status.retired')}</span>:!item.template.active&&<span className="pcg-kp pcg-kp-warn">{t('templates.turnedOff')}</span>}
      <button type="button" className="v9-button" aria-label={t('templates.editNamed',{name:item.template.name})} onClick={()=>setEditing(item)}>{item.retired?t('workflows.view'):t('workflows.edit')}</button>
     </div></li>)}</ul>
   </section>
   {editing&&<EmailEditor key={editing.template.id} initial={editing} refs={refs} onClose={()=>setEditing(null)}/>}
  </>}
  {contract&&(filter==='all'||filter==='contract_staff')&&<ContractTemplates key={initialContractTarget?initialContractTarget.kind+':'+initialContractTarget.id:'list'} data={contract} initialTarget={initialContractTarget}/>}
  {lifecycleSection}
  {!contract&&contractSection}
  {legacy.map(module=><LegacyBuilderCard key={module} module={module} kind="templates" href={LEGACY_BUILDERS.templates[module]} allowed={module==='contract_staff'?access.contractStaff:access.legacy}/>)}
 </main>;
}
