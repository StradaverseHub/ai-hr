'use client';
import {useActionState,useState,type ChangeEvent} from 'react';
import Link from 'next/link';
import {useTranslations} from 'next-intl';
import {ActionButton} from '@/components/ui/action-button';
import type {ContractSharedPosting} from '@/packs/contracts/service';
import {SharedContractNavigation,ContractFeedback,ContractPanel,contractDate} from '../shared-case-ui';
import {saveContractPostingAction} from './actions';
export function ContractPostingEditor({posting}:{posting:ContractSharedPosting}){
 const t=useTranslations('contractPostings'),[error,action,pending]=useActionState(saveContractPostingAction,null);
 const [draft,setDraft]=useState({effectiveDate:posting.current.effectiveDate,previousEndDate:posting.current.previousEndDate??'',endDate:posting.current.endDate??'',contractNumber:posting.current.contractNumber??'',remarks:posting.current.remarks??''});
 const editable=posting.canEdit&&posting.sourceCurrent!==false;
 const field=(key:keyof typeof draft)=>({value:draft[key],onChange:(event:ChangeEvent<HTMLInputElement|HTMLTextAreaElement>)=>setDraft(previous=>({...previous,[key]:event.target.value}))});
 return <div className="v9-content"><SharedContractNavigation/><header className="v9-heading"><div><h1>{t('editTitle',{posting:posting.label})}</h1><p>{posting.employeeName} · {posting.employeeCode} · {posting.companyName}</p></div><Link className="v9-button" href="/lifecycle/contracts/postings">{t('back')}</Link></header><ContractFeedback error={error??undefined}/>
 <ContractPanel title={t(posting.eventType==='contractRenewal'?'renewal':'conversion')}><p>{t('editorIntro',{case:posting.caseNumber})}</p>{posting.sourceCurrent===false&&<p className="v9-notice v9-error" role="alert">{t('sourceChanged')}</p>}
 <form action={action} className="v9-stack"><input type="hidden" name="postingId" value={posting.id}/><input type="hidden" name="revision" value={posting.revision}/><input type="hidden" name="employmentId" value={posting.employmentId}/>
 <fieldset disabled={!editable||pending} className="contract-posting-fields"><legend className="sr-only">{t('valuesLegend')}</legend><div className="v9-fields">
 <label className="v9-field">{t('previousEnd')}<input type="date" name="previousEndDate" className="v9-input" required {...field('previousEndDate')}/></label>
 <label className="v9-field">{t('effectiveDate')}<input type="date" name="effectiveDate" className="v9-input" required min={draft.previousEndDate||undefined} {...field('effectiveDate')}/></label>
 {posting.eventType==='contractRenewal'&&<><label className="v9-field">{t('endDate')}<input type="date" name="endDate" className="v9-input" required min={draft.effectiveDate||undefined} {...field('endDate')}/></label><label className="v9-field">{t('numberLabel')}<input type="number" name="contractNumber" className="v9-input" required min={1} max={100000} step={1} {...field('contractNumber')}/></label></>}
 <label className="v9-field">{t('remarks')}<textarea name="remarks" rows={3} maxLength={200} {...field('remarks')}/></label></div></fieldset>
 {posting.eventType==='contractConversion'&&<p className="v9-muted">{t('conversionRule')}</p>}<p className="v9-muted">{t('agreementRule')}</p>
 {editable?<div className="v9-actions"><ActionButton className="v9-button" name="intent" value="edit" actionKind="saving">{t('saveChanges')}</ActionButton>{posting.canApprove&&<ActionButton className="v9-button v9-button-primary" name="intent" value="approve" actionKind="saving">{t('saveApprove')}</ActionButton>}</div>:<p className="v9-notice">{posting.status==='approved'?t('approvedOn',{date:contractDate(posting.approvedAt)}):t('readOnly')}</p>}
 </form></ContractPanel></div>;
}
