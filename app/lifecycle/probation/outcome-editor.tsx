'use client';
import { ActionButton } from '@/components/ui/action-button';
import Link from 'next/link';
import {useState,useTransition} from 'react';
import {useRouter} from 'next/navigation';
import {useTranslations} from 'next-intl';
import type {ProbationLetterDefinition,ProbationLetterPreview,ProbationOutcomeView,ProbationLetterChoices} from '@/packs/probation/service';
import {probationLetterDocument} from '@/lib/probation-letter-document';
import {DocumentBody,DocumentField} from '@/components/lifecycle-v9/document-body';
import {previewLetter,prepareLetter} from './actions';
import {DraftGuard} from './draft-guard';
export function OutcomeEditor({caseId,outcome,templates,choices,runtimeEnabled=true,sourceMoved=false}:{caseId:string;outcome:ProbationOutcomeView;templates:ProbationLetterDefinition[];choices?:ProbationLetterChoices;runtimeEnabled?:boolean;sourceMoved?:boolean}){
 const t=useTranslations('probation'),router=useRouter(),available=templates.filter(d=>d.state==='published'&&(choices?choices.templates.some(choice=>choice.id===d.id):d.data.outcome===outcome.outcome)),[templateId,setTemplateId]=useState(choices?.suggestedTemplateId??(choices?'':available[0]?.id??'')),[edits,setEdits]=useState<Record<string,string>>({}),[preview,setPreview]=useState<ProbationLetterPreview|null>(null),[busy,start]=useTransition(),[error,setError]=useState(''),[dirty,setDirty]=useState(false);
 const canPrepare=runtimeEnabled&&!outcome.releasedAt&&!['release_requested','released','completed','done'].includes(outcome.state);
 const template=available.find(d=>d.id===templateId),change=(id:string,value:string)=>{setEdits(v=>({...v,[id]:value}));setDirty(true);setPreview(null);};
 const run=(prepare:boolean)=>{setError('');start(async()=>{const input={outcomeId:outcome.id,templateId,edits,revision:outcome.revision};if(prepare){const result=await prepareLetter(input);if(!result.ok){setError(result.detail??t('errors.unavailable'));return;}setDirty(false);router.push('/lifecycle/probation/'+caseId+'/letters/'+result.result.partId);}else{const result=await previewLetter(input);if(!result.ok){setError(result.detail??t('errors.unavailable'));return;}setPreview(result.result);}});};
 return <main className="pcc"><DraftGuard dirty={dirty}/><Link className="pcc-back" href={'/lifecycle/probation/'+caseId+'?tab=outcome'}><span aria-hidden="true">‹ </span>{t('backCase')}</Link>
  <section className="pcc-card pcc-head" aria-labelledby="pcc-outcome-editor"><div><h1 id="pcc-outcome-editor">{t('manageOutcome')}</h1><p className="pcc-sub">{t('outcomes.'+outcome.outcome)} · {t('version',{version:outcome.revision})}</p></div><p className="pcc-banner">{t('letters.prepareHelp')}</p></section>
  {error&&<p className="pcc-banner pcc-banner-bad" role="alert">{error}</p>}
  {!canPrepare?<p className="pcc-banner">{t(runtimeEnabled?'letters.preparationClosed':sourceMoved?'sourceMoved':'runtimePaused')}</p>:!available.length?<p className="pcc-banner pcc-banner-warn">{t('letters.noTemplate')}</p>:<section className="pcc-card">{choices?.tie&&<p className="pcc-banner pcc-banner-warn">{t('letters.templateTie')}</p>}<label className="pcc-field"><span>{t('letters.template')}</span><select value={templateId} disabled={busy} onChange={e=>{if(dirty&&!window.confirm(t('leaveUnsaved')))return;setTemplateId(e.target.value);setEdits({});setPreview(null);setDirty(false);}}><option value="">{t('choose')}</option>{available.map(d=><option value={d.id} key={d.id}>{d.data.name} · {t('version',{version:d.version})}</option>)}</select></label>
   {template?.data.fields.filter(f=>f.owner==='hr'&&(!f.when||edits[f.when.field]===f.when.value)).map(field=><DocumentField key={field.id} field={field} value={edits[field.id]??''} disabled={busy} change={value=>change(field.id,value)}/>)}
   <div className="pcc-row"><ActionButton guardNavigation aria-busy={busy} type="button" className="v9-button" disabled={busy||!templateId} onClick={()=>run(false)}>{t('letters.preview')}</ActionButton><ActionButton guardNavigation aria-busy={busy} type="button" className="v9-button v9-button-primary" disabled={busy||!preview} onClick={()=>run(true)}>{t('letters.prepare')}</ActionButton></div>
  </section>}
  {preview&&<section className="pcc-card"><h2>{t('letters.preview')}</h2><div className="pcc-paper"><DocumentBody document={probationLetterDocument({id:'preview',...preview,name:preview.templateName??template?.data.name??'',createdAt:''})}/></div></section>}
 </main>;
}
