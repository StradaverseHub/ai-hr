'use client';
import Link from 'next/link';
import {useState,useTransition} from 'react';
import {useRouter} from 'next/navigation';
import {useTranslations} from 'next-intl';
import {ArrowLeft,ArrowUpRight,FileText} from 'lucide-react';
import type {ProbationCaseView} from '@/packs/probation/service';
import {onboardingTimestamp} from '@/lib/onboarding-format';
import {CaseDateControls} from './case-date-controls';
import {ProbationFacts} from './facts';
import {addFollowup} from './actions';
export function CaseOverview({view}:{view:ProbationCaseView}){
 const t=useTranslations('probation'),router=useRouter(),[busy,start]=useTransition(),[kind,setKind]=useState<'followup'|'development'|'extension_recommendation'|'nonconfirmation_recommendation'>('followup'),[note,setNote]=useState(''),[error,setError]=useState('');
 const operations=view.roles.includes('pbp')||view.roles.includes('gbs'),development=view.runtimeEnabled&&(operations||view.roles.includes('lm'));
 const save=()=>{setError('');start(async()=>{const result=await addFollowup({caseId:view.record.id,kind,note});if(!result.ok){setError(result.detail??t('errors.unavailable'));return;}setNote('');router.refresh();});};
 return <main><header className="v9-heading"><div><h1>{view.record.facts.employeeName}</h1><p>{t('title')} · {view.record.facts.employeeCode??'—'} · {t('caseStates.'+view.record.state)}</p></div><Link className="v9-button" href="/lifecycle/probation"><ArrowLeft size={16}/>{t('backTracker')}</Link></header>
  {!view.runtimeEnabled&&<p className="v9-notice">{t('runtimePaused')}</p>}
  {error&&<p className="v9-notice v9-error" role="alert">{error}</p>}
  <section className="v9-panel"><ProbationFacts view={view}/></section>
  {view.record.facts.gradeId!==view.record.facts.currentGradeId&&<p className="v9-notice v9-warning">{t('gradeChanged')}</p>}
  {view.record.planFlag&&<p className="v9-notice v9-warning">{t('planFlag')}</p>}
  <section className="v9-panel v9-stack"><h2>{t('reviewPlan')}</h2><div className="probation-list-table"><table><thead><tr>{['review','due','state','revision','action'].map(key=><th key={key}>{t('columns.'+key)}</th>)}</tr></thead><tbody>{view.parts.map(part=><tr key={part.id}><td data-label={t('columns.review')}><strong>{t('partTitle',{part:part.type})}</strong><p className="v9-muted">{t('cycle',{cycle:part.cycle})}</p></td><td data-label={t('columns.due')}>{part.dueOn}<p className="v9-muted">{t('issueOn',{date:part.issueOn})}</p></td><td data-label={t('columns.state')}>{t('partStates.'+part.state)}</td><td data-label={t('columns.revision')}>{part.contentRevision}</td><td><Link className="v9-button" href={'/lifecycle/probation/'+view.record.id+'/'+part.id}>{t('openReview')}<ArrowUpRight size={14}/></Link></td></tr>)}</tbody></table></div></section>
  {view.outcomes.length>0&&<section className="v9-panel v9-stack"><h2>{t('outcomeRecords')}</h2><ul className="v9-list">{view.outcomes.map(outcome=><li key={outcome.id}><strong>{t.has('outcomes.'+outcome.outcome)?t('outcomes.'+outcome.outcome):outcome.outcome}</strong> · {t.has('outcomeStates.'+outcome.state)?t('outcomeStates.'+outcome.state):outcome.state}{(outcome.state==='release_requested'||outcome.filingState==='pending')&&<p className="v9-notice">{t('letters.filingPending')}</p>}{outcome.failure&&<p role="alert">{t('outcomeFailed')}</p>}{operations&&view.runtimeEnabled&&<Link className="v9-button" href={'/lifecycle/probation/'+view.record.id+'/outcomes/'+outcome.id}>{t('manageOutcome')}</Link>}</li>)}</ul></section>}
  {view.letterTasks.length>0&&<section className="v9-panel v9-stack"><h2>{t('letters.tasks')}</h2><ul className="v9-list">{view.letterTasks.map(letter=><li key={letter.partId}><strong>{letter.label}</strong><p>{letter.waitingName??(letter.waitingRole?t('roles.'+letter.waitingRole):t('letters.waiting'))}</p><Link className="v9-button" href={'/lifecycle/probation/'+view.record.id+'/letters/'+letter.partId}>{t('letters.open')}</Link></li>)}</ul></section>}
  {operations&&<CaseDateControls view={view}/>}
  <section className="v9-panel v9-stack"><h2>{t('files.title')}</h2>{!view.files.length?<p className="v9-muted">{t('files.empty')}</p>:<ul className="v9-list">{view.files.map(file=><li key={file.id}><FileText size={16} aria-hidden="true"/> <a href={'/lifecycle/probation/'+view.record.id+'/files/'+file.id} data-unsaved-guard="ignore" target="_blank" rel="noreferrer">{file.name}</a> · {t('version',{version:file.revision})}{file.filingState==='pending'&&<span className="v9-badge">{t('files.filingPending')}</span>}</li>)}</ul>}</section>
  <section className="v9-panel v9-stack"><h2>{t('followup.title')}</h2>{development&&<><label className="v9-field"><span>{t('followup.kind')}</span><select value={kind} disabled={busy} onChange={e=>setKind(e.target.value as typeof kind)}>{(['followup','development','extension_recommendation','nonconfirmation_recommendation'] as const).map(value=><option key={value} value={value}>{t('followup.'+value)}</option>)}</select></label><label className="v9-field"><span>{t('followup.note')}</span><textarea value={note} maxLength={10000} disabled={busy} onChange={e=>setNote(e.target.value)}/></label><div><button type="button" className="v9-button" disabled={busy||!note.trim()} onClick={save}>{t('followup.save')}</button></div></>}{!view.followups.length?<p className="v9-muted">{t('followup.empty')}</p>:<ol className="v9-list">{view.followups.map(followup=><li key={followup.id}><strong>{t.has('followup.'+followup.kind)?t('followup.'+followup.kind):followup.kind}</strong> · {onboardingTimestamp(followup.at)}<p className="probation-note">{followup.note}</p></li>)}</ol>}</section>
 </main>;
}
