'use client';
import {useProbationEmailCopy} from './use-probation-email-copy';
import {useState,useEffect,useRef,type ReactNode} from 'react';
import {convertProbationEmail} from '@/lib/automation/probation-email-definition';
import {ProbationEmailEditor} from './probation-email-editor';
import type {ListedEmailTemplate} from './templates-workspace';
import type {NamedOption} from '../recipients';
export function ProbationTemplateSection({emails,refs,documents=[],letters,newRequest=0,onNewRequestHandled,sender}:{sender?:{name:string|null;configured:boolean};emails:ListedEmailTemplate[];refs:{routings:(NamedOption&{retired?:boolean})[];groups:NamedOption[];people:NamedOption[]};documents?:{id:string;name:string;type:'Letter'}[];letters?:ReactNode;newRequest?:number;onNewRequestHandled?:()=>void}){
 const{copy:t}=useProbationEmailCopy();
 const[editing,setEditing]=useState<ListedEmailTemplate|null>(null),[dirty,setDirty]=useState(false);
 const close=()=>{if(!dirty||window.confirm(t('leave'))){setEditing(null);setDirty(false);}};
 const newEmail=()=>setEditing({template:{id:crypto.randomUUID(),name:t('newName'),module:'probation',active:false,subject:'',body:'',cc:[]},revision:0,retired:false});
 useEffect(()=>{if(newRequest>0){newEmail();onNewRequestHandled?.();}},[newRequest]);
 const counts=emails.reduce((total,item)=>{const state=item.template.definition?'converted':convertProbationEmail(item.template).state==='ready'?'ready':'legacy';total[state]++;return total;},{converted:0,ready:0,legacy:0});
 return <div className="automation probation v9-stack" data-probation-template-section>
  {letters}
  <p className="v9-notice" role="status">{t('conversionTotals',counts)}</p>
  <section className="v9-panel v9-stack v9-template-list" aria-label={t('emailTemplates')+' · '+t('probation')}><header className="v9-heading"><div><h2>{t('emailTemplates')} · {t('probation')}</h2><p className="v9-muted">{t('intro')}</p></div><button type="button" className="v9-button" onClick={newEmail}>{t('newEmail')}</button></header>
   <ul className="v9-list v9-template-rows">{emails.map(item=><li key={item.template.id}><button type="button" className="v9-template-name" onClick={()=>setEditing(item)}><strong>{item.template.name}</strong><span className="v9-muted">{item.template.subject}</span>{(()=>{const conversion=convertProbationEmail(item.template);return conversion.state==='legacy'?<span className="v9-notice v9-warning">{t('conversion',{name:item.template.name,fields:conversion.fields.join(', ')})}</span>:null;})()}</button><span className="v9-badge">{t('probation')}</span><span className="v9-badge">{t(item.template.definition?'conversionRich':convertProbationEmail(item.template).state==='ready'?'conversionReady':'conversionLegacy')}</span><span className="v9-badge">{item.retired?t('retired'):item.template.active?t('active'):t('inactive')}</span><button type="button" className="v9-button" aria-label={t('editNamed',{name:item.template.name})} onClick={()=>setEditing(item)}>{t('edit')}</button></li>)}</ul>{!emails.length&&<p className="v9-muted">{t('noEmails')}</p>}
  </section>
  {editing&&<ProbationEmailSurface close={close}><ProbationEmailEditor key={editing.template.id} initial={editing} sender={sender} refs={refs} documents={documents} onDirtyChange={setDirty} onClose={close}/></ProbationEmailSurface>}
 </div>;
}

function ProbationEmailSurface({children,close}:{children:ReactNode;close:()=>void}){
 const{copy:t}=useProbationEmailCopy();
 const ref=useRef<HTMLDialogElement>(null);useEffect(()=>{ref.current?.showModal();return()=>ref.current?.close();},[]);
 return <dialog ref={ref} className="v9-dialog v9-template-surface v9-email-drawer" aria-label={t('editEmail')} onCancel={event=>{event.preventDefault();close();}}><div className="v9-template-surface-content">{children}</div></dialog>;
}
export function ProbationOnlyTemplateHub({children}:{children:ReactNode}){
 const{copy:t}=useProbationEmailCopy();
 const[tab,setTab]=useState<'all'|'probation'>('probation');
 return <main className="v9-workspace"><div className="v9-stack"><header><p className="v9-muted">{t('crumb')}</p><h1>{t('hubTitle')}</h1></header><div className="v9-actions" role="tablist" aria-label={t('module')}>{(['all','probation'] as const).map(value=><button key={value} type="button" role="tab" aria-selected={tab===value} className={'v9-button'+(tab===value?' v9-button-primary':'')} onClick={()=>setTab(value)}>{value==='all'?t('all'):t('probation')}</button>)}</div>{children}</div></main>;
}
