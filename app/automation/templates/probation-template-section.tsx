'use client';
import {useProbationEmailCopy} from './use-probation-email-copy';
import {useState,useEffect,useRef,type ReactNode} from 'react';
import {convertProbationEmail} from '@/lib/automation/probation-email-definition';
import {ProbationEmailEditor} from './probation-email-editor';
import type {ListedEmailTemplate} from './templates-workspace';
import type {NamedOption} from '../recipients';
export function ProbationTemplateSection({emails,refs,documents=[],letters}:{emails:ListedEmailTemplate[];refs:{routings:(NamedOption&{retired?:boolean})[];groups:NamedOption[];people:NamedOption[]};documents?:{id:string;name:string;type:'Letter'}[];letters?:ReactNode}){
 const{copy:t}=useProbationEmailCopy();
 const[editing,setEditing]=useState<ListedEmailTemplate|null>(null);
 return <div className="v9-stack" data-probation-template-section>
  {letters}
  <section className="v9-panel v9-stack v9-template-list" aria-label={t('emailTemplates')+' · '+t('probation')}><header className="v9-heading"><div><h2>{t('emailTemplates')} · {t('probation')}</h2><p className="v9-muted">{t('intro')}</p></div><button type="button" className="v9-button" onClick={()=>setEditing({template:{id:crypto.randomUUID(),name:t('newName'),module:'probation',active:false,subject:'',body:'',cc:[]},revision:0,retired:false})}>{t('newEmail')}</button></header>
   <ul className="v9-list v9-template-rows">{emails.map(item=><li key={item.template.id}><button type="button" className="v9-template-name" onClick={()=>setEditing(item)}><strong>{item.template.name}</strong><span className="v9-muted">{item.template.subject}</span>{(()=>{const conversion=convertProbationEmail(item.template);return conversion.state==='legacy'?<span className="v9-notice v9-warning">{t('conversion',{name:item.template.name,fields:conversion.fields.join(', ')})}</span>:null;})()}</button><span className="v9-badge">{t('probation')}</span><span className="v9-badge">{item.retired?t('retired'):item.template.active?t('active'):t('inactive')}</span><button type="button" className="v9-button" aria-label={t('editNamed',{name:item.template.name})} onClick={()=>setEditing(item)}>{t('edit')}</button></li>)}</ul>{!emails.length&&<p className="v9-muted">{t('noEmails')}</p>}
  </section>
  {editing&&<ProbationEmailSurface close={()=>setEditing(null)}><ProbationEmailEditor key={editing.template.id} initial={editing} refs={refs} documents={documents} onClose={()=>setEditing(null)}/></ProbationEmailSurface>}
 </div>;
}

function ProbationEmailSurface({children,close}:{children:ReactNode;close:()=>void}){
 const{copy:t}=useProbationEmailCopy();
 const ref=useRef<HTMLDialogElement>(null);useEffect(()=>{ref.current?.showModal();return()=>ref.current?.close();},[]);
 return <dialog ref={ref} className="v9-dialog v9-template-surface v9-email-drawer" aria-label={t('editEmail')} onCancel={close}><div className="v9-template-surface-content">{children}</div></dialog>;
}
export function ProbationOnlyTemplateHub({children}:{children:ReactNode}){
 const{copy:t}=useProbationEmailCopy();
 const[tab,setTab]=useState<'all'|'probation'>('probation');
 return <main className="v9-workspace"><div className="v9-stack"><header><p className="v9-muted">{t('crumb')}</p><h1>{t('hubTitle')}</h1></header><div className="v9-actions" role="tablist" aria-label={t('module')}>{(['all','probation'] as const).map(value=><button key={value} type="button" role="tab" aria-selected={tab===value} className={'v9-button'+(tab===value?' v9-button-primary':'')} onClick={()=>setTab(value)}>{value==='all'?t('all'):t('probation')}</button>)}</div>{children}</div></main>;
}
