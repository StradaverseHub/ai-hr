'use client';
import {useState} from 'react';
import {useTranslations} from 'next-intl';
import {WorkflowField,WorkflowButton} from '../../workflow-editor-shell';

type PendingEvidence={id:string;approvalDocumentId:string;healthDocumentId:string|null;canAttachHealth:boolean;canWithdraw:boolean};
type Choice={id:string;title:string;fileName:string};
export function PendingRetirementEvidence({evidence,documents,busy,onAttach,onWithdraw}:{evidence:PendingEvidence;documents:Choice[];busy:boolean;onAttach:(input:{custodyId:string;healthDocumentId:string;reason:string})=>void;onWithdraw:(input:{custodyId:string;reason:string})=>void}){
 const t=useTranslations('contractManagement'),[healthDocumentId,setHealthDocumentId]=useState(''),[reason,setReason]=useState(''),[withdrawReason,setWithdrawReason]=useState('');
 const approvalTitle=documents.find(doc=>doc.id===evidence.approvalDocumentId)?.title??t('approvalDocument');
 return <section className="rounded-lg border p-3 v9-stack"><h3>{t(evidence.healthDocumentId?'awaitingEvidenceVerification':'awaitingHealth')}</h3><p className="v9-muted">{approvalTitle}</p>{!evidence.healthDocumentId&&evidence.canAttachHealth&&<><p>{t('attachHealthHelp')}</p><WorkflowField label={t('healthDocument')}><select className="v9-input" value={healthDocumentId} disabled={busy} onChange={e=>setHealthDocumentId(e.target.value)}><option value="">{t('choose')}</option>{documents.filter(doc=>doc.id!==evidence.approvalDocumentId).map(doc=><option value={doc.id} key={doc.id}>{doc.title} · {doc.fileName}</option>)}</select></WorkflowField><WorkflowField label={t('evidenceReason')}><textarea className="v9-input" value={reason} disabled={busy} maxLength={5000} onChange={e=>setReason(e.target.value)}/></WorkflowField><WorkflowButton disabled={busy||!healthDocumentId||reason.trim().length<20} onClick={()=>onAttach({custodyId:evidence.id,healthDocumentId,reason})}>{t('attachHealth')}</WorkflowButton></>}{evidence.canWithdraw&&<><WorkflowField label={t('withdrawEvidenceReason')}><textarea className="v9-input" value={withdrawReason} disabled={busy} maxLength={5000} onChange={e=>setWithdrawReason(e.target.value)}/></WorkflowField><WorkflowButton disabled={busy||withdrawReason.trim().length<20} onClick={()=>onWithdraw({custodyId:evidence.id,reason:withdrawReason})}>{t('withdrawEvidence')}</WorkflowButton></>}</section>;
}
