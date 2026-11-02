'use client';
import {useState,useTransition} from 'react';
import {useRouter} from 'next/navigation';
import {useTranslations} from 'next-intl';
import type {ProbationCaseView} from '@/packs/probation/service';
import {requestDateShift,applyDateShift,reconcileDates} from './actions';
import {DraftGuard} from './draft-guard';
export function CaseDateControls({view}:{view:ProbationCaseView}){
 const t=useTranslations('probation'),router=useRouter(),[endOn,setEndOn]=useState(''),[reason,setReason]=useState(''),[busy,start]=useTransition(),[error,setError]=useState('');
 const pbp=view.roles.includes('pbp'),gbs=view.roles.includes('gbs'),pending=view.dateAdjustments.some(a=>a.status!=='applied');if(!view.runtimeEnabled||!pbp&&!gbs)return null;
 const run=(work:()=>Promise<{ok:boolean;detail?:string}>)=>{setError('');start(async()=>{const result=await work();if(!result.ok){setError(result.detail??t('errors.unavailable'));return;}setEndOn('');setReason('');router.refresh();});};
 return <section className="v9-panel v9-stack"><DraftGuard dirty={!!reason.trim()||!!endOn}/><h2>{t('dates.title')}</h2>{error&&<p className="v9-notice v9-error" role="alert">{error}</p>}
  {view.sourceChanged&&<div className="v9-notice v9-warning"><p>{t('dates.sourceChanged')}</p><dl className="probation-facts"><div><dt>{t('dates.savedPeriod')}</dt><dd>{view.record.startOn} – {view.record.endOn}</dd></div><div><dt>{t('dates.currentPeriod')}</dt><dd>{view.record.facts.startOn} – {view.record.facts.endOn??'—'}</dd></div></dl></div>}
  <p className="v9-muted">{t('dates.help')}</p><label className="v9-field"><span>{t('reason')}</span><textarea value={reason} maxLength={5000} disabled={busy} onChange={e=>setReason(e.target.value)}/></label>
  {view.sourceChanged&&<button type="button" className="v9-button" disabled={busy||reason.trim().length<3} onClick={()=>run(()=>reconcileDates({caseId:view.record.id,revision:view.record.revision,reason}))}>{t('dates.reconcile')}</button>}
  {pbp&&!pending&&!['confirmed','not_confirmed','withdrawn','outcome_pending'].includes(view.record.state)&&<><label className="v9-field"><span>{t('dates.newEnd')}</span><input type="date" value={endOn} disabled={busy} onChange={e=>setEndOn(e.target.value)}/></label><button type="button" className="v9-button" disabled={busy||!endOn||endOn<=view.record.endOn||reason.trim().length<3} onClick={()=>run(()=>requestDateShift({caseId:view.record.id,revision:view.record.revision,newEndOn:endOn,reason}))}>{t('dates.request')}</button></>}
  <ul className="v9-list">{view.dateAdjustments.map(adjustment=><li key={adjustment.id}><strong>{adjustment.oldEndOn} → {adjustment.newEndOn}</strong><p className="probation-note">{adjustment.reason}</p><p>{t('dates.states.'+adjustment.status)}</p>{adjustment.status==='failed'&&<p className="v9-notice v9-warning">{t('dates.failedHelp')}</p>}{gbs&&['awaiting_gbs','failed'].includes(adjustment.status)&&<button className="v9-button" type="button" disabled={busy} onClick={()=>run(()=>applyDateShift({caseId:view.record.id,requestId:adjustment.id,revision:view.record.revision}))}>{t('dates.approve')}</button>}</li>)}</ul>
 </section>;
}
