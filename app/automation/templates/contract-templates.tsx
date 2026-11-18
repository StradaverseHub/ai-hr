'use client';
import type {ContractTemplateEditorTarget} from '../editor-target';
import {useState} from 'react';
import {useTranslations} from 'next-intl';
import type {StoredAutomationDocumentTemplate} from '@/packs/automation/service';
import {ContractDocuments,type ContractDocumentReferences} from './contract-documents';
import type {ListedEmailTemplate,Refs} from './templates-workspace';
import {EmailEditor} from './email-editor';
export type ContractTemplatesData={documents:StoredAutomationDocumentTemplate[];emails:ListedEmailTemplate[];refs:Refs&ContractDocumentReferences};
export function ContractTemplates({data,initialTarget}:{data:ContractTemplatesData;initialTarget?:ContractTemplateEditorTarget}){
 const t=useTranslations('automation'),[editing,setEditing]=useState<ListedEmailTemplate|null>(()=>initialTarget?.kind==='email'?data.emails.find(row=>row.template.id===initialTarget.id&&row.template.module==='contract_staff')??null:null);
 const current=data.emails.filter(row=>!row.retired),retired=data.emails.filter(row=>row.retired);
 return <div className="v9-stack"><ContractDocuments templates={data.documents} refs={data.refs} initialSelectedId={initialTarget?.kind==='document'?initialTarget.id:undefined}/>
  <section className="pcg-card" aria-label={t('templates.emails')}><div className="pcg-row pcg-between"><div><h2>{t('modules.contract_staff')} · {t('templates.emails')}</h2><p className="pcg-sub">{t('contract.emailHelp')}</p></div>
   <button type="button" className="v9-button v9-button-primary" onClick={()=>setEditing({template:{id:crypto.randomUUID(),module:'contract_staff',name:t('templates.newName'),active:true,subject:'',body:'',cc:[]},revision:0,retired:false})}>{t('templates.newEmail')}</button></div>
   {!current.length&&<p className="v9-muted">{t('contract.noEmails')}</p>}
   <ul className="pcg-tl">{current.map(row=><li className="pcg-tl-row" key={row.template.id}><div><h3>{row.template.name}</h3><p>{row.template.subject}</p></div><div className="pcg-tl-pills"><span className="pcg-kp">{t('modules.contract_staff')}</span><span className="pcg-kp">{t(row.template.active?'templates.active':'templates.turnedOff')}</span><button type="button" className="v9-button" onClick={()=>setEditing(row)}>{t('workflows.edit')}</button></div></li>)}</ul>
   {retired.length>0&&<details><summary>{t('status.retired')} ({retired.length})</summary><ul className="automation-plain-list">{retired.map(row=><li key={row.template.id}><span>{row.template.name}</span><button type="button" className="v9-button" onClick={()=>setEditing(row)}>{t('workflows.view')}</button></li>)}</ul></details>}
  </section>
  {editing&&<EmailEditor key={editing.template.id} initial={editing} refs={data.refs} documents={data.documents.filter(row=>!row.retired&&row.liveVersion!==null).map(row=>({id:row.template.id,name:row.template.name}))} onClose={()=>setEditing(null)}/>}
 </div>;
}
