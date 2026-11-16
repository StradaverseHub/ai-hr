'use client';
import { ActionButton } from '@/components/ui/action-button';
import Link from 'next/link';
import {useState,useTransition} from 'react';
import {useRouter} from 'next/navigation';
import {useTranslations} from 'next-intl';
import type {ProbationCaseView,ProbationOutcomeView} from '@/packs/probation/service';
import {probationLowResultPending} from '@/lib/probation-tracker';
import {recordLowResultAction,decideOtherOutcome} from './actions';

/** Parts with a low result whose action with the Line Manager is not yet recorded for their current content (I3). */
export function lowResultParts(view:ProbationCaseView){
 const row={lowBand:view.record.config.lowBand};
 return view.parts.filter(part=>part.type!==1&&!!part.managerSubmittedAt&&typeof part.scoreBand==='number'&&probationLowResultPending(row,{state:part.state,dueOn:part.dueOn,scoreBand:part.scoreBand??null,
  lowResultActioned:view.followups.some(f=>f.kind==='low_result_action'&&f.partId===part.id&&f.contentRevision===part.contentRevision)}));
}

/** The PBP (or GBS People Ops) records the action taken with the Line Manager for a low result (handoff B3, §6). */
export function LowResultActions({view}:{view:ProbationCaseView}){
 const t=useTranslations('probation'),router=useRouter(),[busy,start]=useTransition(),[notes,setNotes]=useState<Record<string,string>>({}),[error,setError]=useState('');
 const parts=lowResultParts(view),canRecord=view.runtimeEnabled&&(view.roles.includes('pbp')||view.roles.includes('gbs'));
 if(!parts.length)return null;
 const save=(partId:string)=>{setError('');start(async()=>{const result=await recordLowResultAction({partId,note:notes[partId]??''});if(!result.ok){setError(result.detail??t('errors.unavailable'));return;}setNotes(v=>({...v,[partId]:''}));router.refresh();});};
 return <section className="v9-panel v9-stack" aria-label={t('lowResult.title')}><h2>{t('lowResult.title')}</h2>
  {error&&<p className="v9-notice v9-error" role="alert">{error}</p>}
  {parts.map(part=><div key={part.id} className="v9-stack"><p className="v9-notice v9-warning">{t('lowResult.notice',{part:part.type,band:part.scoreBand??0})}</p>
   {canRecord?<><label className="v9-field"><span>{t('lowResult.note')}</span><textarea value={notes[part.id]??''} maxLength={10000} disabled={busy} onChange={e=>setNotes(v=>({...v,[part.id]:e.target.value}))}/></label>
    <div><ActionButton guardNavigation aria-busy={busy} type="button" className="v9-button" disabled={busy||(notes[part.id]??'').trim().length<3} onClick={()=>save(part.id)}>{t('lowResult.save')}</ActionButton></div></>
   :<p className="v9-muted">{t('lowResult.waiting')}</p>}</div>)}
 </section>;
}

/** Outcome "Other" (handoff B4): no letter; the PBP chooses the real outcome and the case continues as that outcome. */
export function OtherOutcomeDecision({caseId,outcome,extensionsLeft,canDecide}:{caseId:string;outcome:ProbationOutcomeView;extensionsLeft:boolean;canDecide:boolean}){
 const t=useTranslations('probation'),router=useRouter(),[busy,start]=useTransition(),[choice,setChoice]=useState<'confirm'|'extend'|'not_confirm'|''>(''),[months,setMonths]=useState<3|6|null>(null),[reason,setReason]=useState(''),[error,setError]=useState('');
 const ready=!!choice&&reason.trim().length>=3&&(choice!=='extend'||months!==null);
 const save=()=>{if(!choice)return;setError('');start(async()=>{const result=await decideOtherOutcome({caseId,outcomeId:outcome.id,revision:outcome.revision,outcome:choice,months:choice==='extend'?months:null,reason});if(!result.ok){setError(result.detail??t('errors.unavailable'));return;}router.push('/lifecycle/probation/'+caseId);router.refresh();});};
 return <main><header className="v9-heading"><div><h1>{t('otherOutcome.title')}</h1><p>{t('outcomes.other')} · {t('version',{version:outcome.revision})}</p></div><Link className="v9-button" href={'/lifecycle/probation/'+caseId}>{t('backCase')}</Link></header>
  {error&&<p className="v9-notice v9-error" role="alert">{error}</p>}
  <section className="v9-panel v9-stack"><p className="v9-notice">{t('otherOutcome.help')}</p>
   {!canDecide?<p className="v9-muted">{t('otherOutcome.waiting')}</p>:<>
    <label className="v9-field"><span>{t('otherOutcome.choice')}</span><select value={choice} disabled={busy} onChange={e=>{setChoice(e.target.value as typeof choice);setMonths(null);}}><option value="">{t('choose')}</option>{(['confirm','extend','not_confirm'] as const).filter(value=>value!=='extend'||extensionsLeft).map(value=><option key={value} value={value}>{t('outcomes.'+value)}</option>)}</select></label>
    {choice==='extend'&&<label className="v9-field"><span>{t('otherOutcome.months')}</span><select value={months??''} disabled={busy} onChange={e=>setMonths(e.target.value?Number(e.target.value) as 3|6:null)}><option value="">{t('choose')}</option>{([3,6] as const).map(value=><option key={value} value={value}>{t('otherOutcome.monthsOption',{months:value})}</option>)}</select></label>}
    <label className="v9-field"><span>{t('otherOutcome.reason')}</span><textarea value={reason} maxLength={10000} disabled={busy} onChange={e=>setReason(e.target.value)}/></label>
    <div><ActionButton guardNavigation aria-busy={busy} type="button" className="v9-button" disabled={busy||!ready} onClick={save}>{t('otherOutcome.save')}</ActionButton></div></>}
  </section>
 </main>;
}
