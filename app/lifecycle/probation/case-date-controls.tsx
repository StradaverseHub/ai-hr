'use client';
import {useState,useTransition} from 'react';
import {useRouter} from 'next/navigation';
import {useTranslations} from 'next-intl';
import type {ProbationCaseView} from '@/packs/probation/service';
import {requestDateShift,applyDateShift,reconcileDates,supersedeDateShift} from './actions';
import {DraftGuard} from './draft-guard';
export function CaseDateControls({view}:{view:ProbationCaseView}){
 const t=useTranslations('probation'),router=useRouter(),[endOn,setEndOn]=useState(''),[reason,setReason]=useState(''),[busy,start]=useTransition(),[error,setError]=useState(''),[notice,setNotice]=useState('');
 const operations=view.roles.some(role=>role==='pbp'||role==='gbs'),editable=view.runtimeEnabled&&!view.sourceMoved,reviewSchedule=view.canReconcileDates===true&&!view.sourceMoved;
 if(!operations||!editable&&!reviewSchedule&&!view.dateAdjustments.length)return null;
 const run=(work:()=>Promise<{ok:boolean;detail?:string;result?:unknown}>,schedule=false)=>{setError('');setNotice('');start(async()=>{const result=await work();if(!result.ok){setError(result.detail??t('errors.unavailable'));return;}if(schedule&&result.result&&typeof result.result==='object'&&'queued' in result.result&&result.result.queued===true)setNotice(t(view.runtimeEnabled?'dates.reconciliationQueuedActive':'dates.reconciliationQueued'));setEndOn('');setReason('');router.refresh();});};
 return <section className="v9-panel v9-stack"><DraftGuard dirty={(editable||reviewSchedule)&&(!!reason.trim()||!!endOn)}/><h2>{t('dates.title')}</h2>{error&&<p className="v9-notice v9-error" role="alert">{error}</p>}{notice&&<p role="status" className="v9-notice">{notice}</p>}
  {view.sourceChanged&&<div className="v9-notice v9-warning"><p>{t('dates.sourceChanged')}</p><dl className="probation-facts"><div><dt>{t('dates.savedPeriod')}</dt><dd>{view.record.startOn} – {view.record.endOn}</dd></div><div><dt>{t('dates.currentPeriod')}</dt><dd>{view.record.facts.startOn} – {view.record.facts.endOn??'—'}</dd></div></dl></div>}
  {(editable||reviewSchedule)&&<><p className="v9-muted">{t('dates.help')}</p><label className="v9-field"><span>{t('reason')}</span><textarea value={reason} maxLength={5000} disabled={busy} onChange={e=>setReason(e.target.value)}/></label>
  {reviewSchedule&&<button type="button" className="v9-button" disabled={busy||reason.trim().length<3} onClick={()=>run(()=>reconcileDates({caseId:view.record.id,revision:view.record.revision,reason}),true)}>{t(view.runtimeEnabled?'dates.reconcile':'dates.reconcilePaused')}</button>}
  {editable&&view.canRequestDateShift&&<><label className="v9-field"><span>{t('dates.newEnd')}</span><input type="date" value={endOn} disabled={busy} onChange={e=>setEndOn(e.target.value)}/></label><button type="button" className="v9-button" disabled={busy||!endOn||endOn<=view.record.endOn||reason.trim().length<3} onClick={()=>run(()=>requestDateShift({caseId:view.record.id,revision:view.record.revision,newEndOn:endOn,reason}))}>{t('dates.request')}</button></>}</>}
  <ul className="v9-list">{view.dateAdjustments.map(adjustment=><li key={adjustment.id}><strong>{adjustment.oldEndOn} → {adjustment.newEndOn}</strong><p className="probation-note">{adjustment.reason}</p><p>{t('dates.states.'+adjustment.status)}</p>
   {adjustment.supersededReason&&<p className="probation-note">{adjustment.supersededReason}</p>}{adjustment.status==='failed'&&<p className="v9-notice v9-warning">{t('dates.failedHelp')}</p>}
   {editable&&adjustment.canApprove&&<button className="v9-button" type="button" disabled={busy} onClick={()=>run(()=>applyDateShift({caseId:view.record.id,requestId:adjustment.id,revision:view.record.revision}))}>{t('dates.approve')}</button>}
   {editable&&adjustment.canSupersede&&<button className="v9-button" type="button" disabled={busy||reason.trim().length<3} onClick={()=>run(()=>supersedeDateShift({caseId:view.record.id,requestId:adjustment.id,revision:view.record.revision,reason}))}>{t('dates.supersede')}</button>}
  </li>)}</ul>
 </section>;
}
