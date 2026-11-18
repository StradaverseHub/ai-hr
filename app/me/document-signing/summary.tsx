'use client';
import {useTranslations} from 'next-intl';
import {DocumentBody} from '@/components/lifecycle-v9/document-body';
import {useOnboardingCopy} from '@/lib/onboarding-copy';
import {documentPresentationStatus,type Document} from '@/lib/lifecycle-v9-model';
export function RoutedDocumentStatus({document}:{document:Document}){const copy=useOnboardingCopy();return <>{documentPresentationStatus(document)==='completed'?copy('Completed'):document.status}</>;}
export function RoutedDocumentCompletionBadge({document}:{document:Document}){const copy=useOnboardingCopy();return documentPresentationStatus(document)==='completed'?<span className="v9-badge">{copy('Completed')}</span>:null;}
export function RoutedDocumentLink({caseId,documentId}:{caseId:string;documentId:string}){const t=useTranslations('lifecycleDocumentRouting');return <a className="v9-button" href={'/me/document-signing?'+new URLSearchParams({case:caseId,document:documentId})}>{t('open')}</a>;}
export function RoutedDocumentSummary({document,caseId}:{document:Document;caseId?:string}){const t=useTranslations('lifecycleDocumentRouting');return <div className="v9-stack"><RoutedDocumentCompletionBadge document={document}/><DocumentBody document={document} values={document.values} editableBy="hr" disabled change={()=>{}}/><p className="v9-notice">{t('savedRoute')}</p>{caseId&&<RoutedDocumentLink caseId={caseId} documentId={document.id}/>}<ol className="v9-list">{document.signing!.route.steps.map(step=><li key={step.id}>{step.stage}. {t('actions.'+step.kind)} · {step.label??t('unassigned')} · {step.required?t('required'):t('optional')}</li>)}</ol></div>;}
