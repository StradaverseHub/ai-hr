'use client';
import Link from 'next/link';
import {useState,useTransition} from 'react';
import {useRouter} from 'next/navigation';
import {useTranslations} from 'next-intl';
import type {ProbationLetterDefinition,ProbationLetterPreview,ProbationOutcomeView,ProbationLetterChoices} from '@/packs/probation/service';
import {probationLetterDocument} from '@/lib/probation-letter-document';
import {DocumentBody,DocumentField} from '@/components/lifecycle-v9/document-body';
import {previewLetter,prepareLetter} from './actions';
import {DraftGuard} from './draft-guard';
export function OutcomeEditor({caseId,outcome,templates,choices}:{caseId:string;outcome:ProbationOutcomeView;templates:ProbationLetterDefinition[];choices?:ProbationLetterChoices}){
 const t=useTranslations('probation'),router=useRouter(),available=templates.filter(d=>d.state==='published'&&(choices?choices.templates.some(choice=>choice.id===d.id):d.data.outcome===outcome.outcome)),[templateId,setTemplateId]=useState(choices?.suggestedTemplateId??(choices?'':available[0]?.id??'')),[edits,setEdits]=useState<Record<string,string>>({}),[preview,setPreview]=useState<ProbationLetterPreview|null>(null),[busy,start]=useTransition(),[error,setError]=useState(''),[dirty,setDirty]=useState(false);
 const canPrepare=!outcome.releasedAt&&!['release_requested','released','completed','done'].includes(outcome.state);
 const template=available.find(d=>d.id===templateId),change=(id:string,value:string)=>{setEdits(v=>({...v,[id]:value}));setDirty(true);setPreview(null);};
 const run=(prepare:boolean)=>{setError('');start(async()=>{const input={outcomeId:outcome.id,templateId,edits,revision:outcome.revision};if(prepare){const result=await prepareLetter(input);if(!result.ok){setError(result.detail??t('errors.unavailable'));return;}setDirty(false);router.push('/lifecycle/probation/'+caseId+'/letters/'+result.result.partId);}else{const result=await previewLetter(input);if(!result.ok){setError(result.detail??t('errors.unavailable'));return;}setPreview(result.result);}});};
 return <main><DraftGuard dirty={dirty}/><header className="v9-heading"><div><h1>{t('manageOutcome')}</h1><p>{t('outcomes.'+outcome.outcome)} · {t('version',{version:outcome.revision})}</p></div><Link className="v9-button" href={'/lifecycle/probation/'+caseId}>{t('backCase')}</Link></header>
  {error&&<p className="v9-notice v9-error" role="alert">{error}</p>}<p className="v9-notice">{t('letters.prepareHelp')}</p>
  {!canPrepare?<p className="v9-notice">{t('letters.preparationClosed')}</p>:!available.length?<p className="v9-notice v9-warning">{t('letters.noTemplate')}</p>:<section className="v9-panel v9-stack">{choices?.tie&&<p className="v9-notice v9-warning">{t('letters.templateTie')}</p>}<label className="v9-field"><span>{t('letters.template')}</span><select value={templateId} disabled={busy} onChange={e=>{if(dirty&&!window.confirm(t('leaveUnsaved')))return;setTemplateId(e.target.value);setEdits({});setPreview(null);setDirty(false);}}><option value="">{t('choose')}</option>{available.map(d=><option value={d.id} key={d.id}>{d.data.name} · {t('version',{version:d.version})}</option>)}</select></label>
   {template?.data.fields.filter(f=>f.owner==='hr'&&(!f.when||edits[f.when.field]===f.when.value)).map(field=><DocumentField key={field.id} field={field} value={edits[field.id]??''} disabled={busy} change={value=>change(field.id,value)}/>)}
   <div className="probation-actions"><button type="button" className="v9-button" disabled={busy||!templateId} onClick={()=>run(false)}>{t('letters.preview')}</button><button type="button" className="v9-button v9-button-primary" disabled={busy||!preview} onClick={()=>run(true)}>{t('letters.prepare')}</button></div>
  </section>}
  {preview&&<section className="v9-panel v9-stack"><h2>{t('letters.preview')}</h2><DocumentBody document={probationLetterDocument({id:'preview',...preview,name:preview.templateName??template?.data.name??'',createdAt:''})}/></section>}
 </main>;
}
