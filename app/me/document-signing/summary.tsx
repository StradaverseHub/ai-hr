'use client';
import {useTranslations} from 'next-intl';
import {DocumentBody} from '@/components/lifecycle-v9/document-body';
import type {Document} from '@/lib/lifecycle-v9-model';
export function RoutedDocumentLink({caseId,documentId}:{caseId:string;documentId:string}){const t=useTranslations('lifecycleDocumentRouting');return <a className="v9-button" href={'/me/document-signing?'+new URLSearchParams({case:caseId,document:documentId})}>{t('open')}</a>;}
export function RoutedDocumentSummary({document,caseId}:{document:Document;caseId?:string}){const t=useTranslations('lifecycleDocumentRouting');return <div className="v9-stack"><DocumentBody document={document} values={document.values} editableBy="hr" disabled change={()=>{}}/><p className="v9-notice">{t('savedRoute')}</p>{caseId&&<RoutedDocumentLink caseId={caseId} documentId={document.id}/>}<ol className="v9-list">{document.signing!.route.steps.map(step=><li key={step.id}>{step.stage}. {t('actions.'+step.kind)} · {step.label??t('unassigned')} · {step.required?t('required'):t('optional')}</li>)}</ol></div>;}
