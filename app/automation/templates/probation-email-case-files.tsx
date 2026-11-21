'use client';
import {useProbationEmailCopy} from './use-probation-email-copy';
import {useState,useTransition} from 'react';
import {useRouter} from 'next/navigation';
import type {ProbationEmailFileChoice} from '@/packs/automation/service';
export function ProbationEmailCaseFiles({caseId,revision,choices}:{caseId:string;revision:number;choices:ProbationEmailFileChoice[]}){
 const{copy:t}=useProbationEmailCopy();
 const router=useRouter(),[busy,start]=useTransition(),[message,setMessage]=useState('');
 if(!choices.length)return null;
 return <section className="pcc-card v9-stack" aria-label={t('caseFilesTitle')}><h2>{t('caseFilesTitle')}</h2><p className="v9-muted">{t('caseFilesHelp')}</p>
  {choices.map(choice=><section key={choice.templateId} className="v9-stack"><h3>{choice.name}</h3>{choice.slots.map(slot=>{const file=choice.files.find(file=>file.slotId===slot.id);return <div className="v9-panel v9-stack" key={slot.id}><label className="v9-field"><span>{slot.label}{slot.required?' · '+t('requiredShort'):''}</span><input type="file" accept=".pdf,.png,.jpg,.jpeg,.gif,.webp,.doc,.docx,.xls,.xlsx,.txt,.csv" disabled={busy} onChange={event=>{const file=event.target.files?.[0];event.target.value='';if(!file)return;const data=new FormData();data.set('file',file);data.set('caseId',caseId);data.set('templateId',choice.templateId);data.set('slotId',slot.id);data.set('revision',String(revision));start(async()=>{setMessage('');try{const response=await fetch('/automation/templates/case-files',{method:'POST',body:data}),result=await response.json();if(!response.ok)throw new Error(t('uploadFailed'));setMessage(t('uploadSaved'));router.refresh();}catch(error){setMessage(t('uploadFailed'));}});}}/></label>{file?<a className="v9-link" href={`/automation/templates/case-files/${caseId}/${file.id}`}>{file.name}</a>:<p className="v9-muted">{slot.required?t('waitingFile'):t('noFile')}</p>}</div>;})}</section>)}
  {message&&<p role="status" className="v9-notice">{message}</p>}
 </section>;
}
