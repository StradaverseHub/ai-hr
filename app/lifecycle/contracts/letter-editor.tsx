'use client';
import {useState,useTransition} from 'react';
import {useTranslations} from 'next-intl';
import {LetterRichEditor,type LetterEditorLabels} from '@/components/letters/rich-editor';
import {letterDocumentFromEditor} from '@/lib/letter-editor';
import type {LetterDocument} from '@/lib/letter-model';
import {CONTRACT_FIELDS,type ContractDocumentType} from '@/lib/contract-management-template-model';
import {WorkflowButton} from '../workflow-editor-shell';
import {useContractCommand} from './shared';
import {readContractLetterEditor} from './actions';
export function ContractLetterEditor({caseId,revision,type,labels}:{caseId:string;revision:number;type:ContractDocumentType;labels:LetterEditorLabels}){
 const t=useTranslations('contractManagement'),ui=useContractCommand(),[pending,start]=useTransition(),[error,setError]=useState(''),[document,setDocument]=useState<LetterDocument|null>(null),[valid,setValid]=useState(false),[sourceRevision,setRevision]=useState(0);
 function open(){start(async()=>{setError('');const response=await readContractLetterEditor(caseId,type);if(!response.ok){setError(t(response.error));return;}setDocument(response.editor.body);setRevision(response.editor.caseRevision);});}
 return <div className="v9-stack"><WorkflowButton disabled={pending||ui.pending} onClick={open}>{t('editLetter')}</WorkflowButton>{document&&<><p className="v9-muted">{t('caseLetterNote')}</p><LetterRichEditor initial={document} fields={CONTRACT_FIELDS} language={document.language} labels={labels} onChange={(json,ok)=>{setValid(ok);if(ok)setDocument(letterDocumentFromEditor(json,CONTRACT_FIELDS,document.language));}}/><WorkflowButton primary disabled={ui.pending||!valid||sourceRevision!==revision} onClick={()=>ui.run('generate',{caseId,revision:sourceRevision,type,caseEdits:document})}>{t('saveLetter')}</WorkflowButton>{sourceRevision!==revision&&<p role="alert">{t('caseChanged')}</p>}</>}{error&&<p role="alert" className="v9-error">{error}</p>}{ui.feedback}</div>;
}
