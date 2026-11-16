'use client';
import {useState} from 'react';
import {useTranslations} from 'next-intl';
import type {StoredAutomationDocumentTemplate} from '@/packs/automation/service';
import {ContractDocuments,type ContractDocumentReferences} from './contract-documents';
import type {ListedEmailTemplate,Refs} from './templates-workspace';
import {EmailEditor} from './email-editor';
export type ContractTemplatesData={documents:StoredAutomationDocumentTemplate[];emails:ListedEmailTemplate[];refs:Refs&ContractDocumentReferences};
export function ContractTemplates({data}:{data:ContractTemplatesData}){
 const t=useTranslations('automation'),[editing,setEditing]=useState<ListedEmailTemplate|null>(null);
 return <div className="v9-stack"><ContractDocuments templates={data.documents} refs={data.refs}/>
  <section className="pcg-card" aria-label={t('templates.emails')}><div className="pcg-row pcg-between"><div><h2>{t('modules.contract_staff')} · {t('templates.emails')}</h2><p className="pcg-sub">{t('contract.emailHelp')}</p></div>
   <button type="button" className="v9-button v9-button-primary" onClick={()=>setEditing({template:{id:crypto.randomUUID(),module:'contract_staff',name:t('templates.newName'),active:true,subject:'',body:'',cc:[]},revision:0,retired:false})}>{t('templates.newEmail')}</button></div>
   {!data.emails.length&&<p className="v9-muted">{t('templates.noEmails')}</p>}
   <ul className="pcg-tl">{data.emails.map(row=><li className="pcg-tl-row" key={row.template.id}><div><h3>{row.template.name}</h3><p>{row.template.subject}</p></div><div className="pcg-tl-pills"><span className="pcg-kp">{t('modules.contract_staff')}</span><span className="pcg-kp">{t(row.template.active?'templates.active':'templates.turnedOff')}</span><button type="button" className="v9-button" onClick={()=>setEditing(row)}>{t('workflows.edit')}</button></div></li>)}</ul>
  </section>
  {editing&&<EmailEditor key={editing.template.id} initial={editing} refs={data.refs} onClose={()=>setEditing(null)}/>}
 </div>;
}
