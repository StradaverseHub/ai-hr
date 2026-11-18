'use client';
import {useState,useTransition} from 'react';
import {useRouter} from 'next/navigation';
import {useTranslations} from 'next-intl';
import type {ProbationLetterCompletionView} from '@/packs/probation/service';
import type {Case} from '@/lib/lifecycle-v9-model';
import {effectivePersonnelCompletion,personnelCompletionIssues} from '@/lib/lifecycle-v9-personnel-completion';
import {PersonnelCompletionPanel,PersonnelCompletionPreparation} from '@/components/lifecycle-v9/personnel-completion';
import {PersonnelReview} from '@/app/lifecycle/v9/personnel-review';
import {saveLetterCompletion,overrideLetterCompletion,refreshLetterCompletion,reviewLetterPersonnel} from './actions';

/** Server-owned field-only access is independent of the private letter's current signing turn. */
export function ProbationLetterCompletion({view}:{view:ProbationLetterCompletionView}){
 const t=useTranslations('personnelCompletion'),router=useRouter(),[values,setValues]=useState({...view.document.values}),[busy,start]=useTransition(),[error,setError]=useState(''),[notice,setNotice]=useState('');
 const reference={caseId:view.caseId,partId:view.partId,revision:view.storageRevision};
 const employeeFields=view.document.fields.filter(field=>effectivePersonnelCompletion(view.document,field)==='employee');
 const issues=personnelCompletionIssues({...view.document,values},{owner:'employee',final:false}),required=personnelCompletionIssues({...view.document,values},{owner:'employee',final:true});
 async function execute(work:()=>Promise<{ok:boolean;detail?:string}>){setError('');setNotice('');try{const result=await work();if(!result.ok){setError(t('saveFailed'));return{ok:false,error:t('saveFailed')};}router.refresh();return{ok:true};}catch{setError(t('saveFailed'));return{ok:false,error:t('saveFailed')};}}
 const save=(submit:boolean)=>start(async()=>{const result=await execute(()=>saveLetterCompletion({...reference,values:Object.fromEntries(employeeFields.map(field=>[field.id,values[field.id]??''])),submit,reason:t(submit?'submitAnswers':'saveProgress')}));if(result.ok)setNotice(t(submit?'answersSubmitted':'saved'));});
 const c={state:view.canReview?'submitted':'cleared',facts:{employmentId:view.employmentId},documents:[view.document],pmChanges:view.proposals} as unknown as Case;
 return <div className="v9-stack v9-native-documents">
  {view.fieldOwner==='employee'&&employeeFields.length>0&&<section className="v9-panel v9-stack"><PersonnelCompletionPreparation document={view.document} values={values} disabled={busy||!view.canEdit} change={(id,value)=>setValues(previous=>({...previous,[id]:value}))}/><p className="v9-notice">{t('preparationHelp')}</p><div className="v9-actions"><button type="button" className="v9-button" disabled={busy||!view.canEdit||issues.length>0} onClick={()=>save(false)}>{t('saveProgress')}</button>{view.canSubmit&&<button type="button" className="v9-button v9-primary" disabled={busy||required.length>0} onClick={()=>save(true)}>{t('submitAnswers')}</button>}</div>{view.canRefresh&&<button type="button" className="v9-button" disabled={busy||employeeFields.some(field=>values[field.id]!==view.document.values[field.id])} onClick={()=>start(async()=>{await execute(()=>refreshLetterCompletion(reference));})}>{t('refresh')}</button>}</section>}
  {view.fieldOwner==='hr'&&<PersonnelCompletionPanel document={view.document} busy={busy} canOverride={view.canOverride} onOverride={input=>execute(()=>overrideLetterCompletion({...reference,...input}))} onSave={view.canEdit?values=>execute(()=>saveLetterCompletion({...reference,values,reason:t('saveHR')})):undefined} onRefresh={view.canRefresh?()=>execute(()=>refreshLetterCompletion(reference)):undefined}/>}
  {view.fieldOwner==='hr'&&view.proposals.length>0&&<PersonnelReview c={c} busy={busy} writableKeys={view.writableKeys} command={command=>{if(view.canReview&&(command.type==='pmPushSelected'||command.type==='pmKeep')){const ids=command.ids,action=command.type==='pmPushSelected'?'push' as const:'keep' as const;start(async()=>{await execute(()=>reviewLetterPersonnel({...reference,ids,action}));});}}}/>}
  {error&&<p role="alert" className="v9-notice v9-error">{error}</p>}{notice&&<p role="status" className="v9-notice">{notice}</p>}
 </div>;
}
