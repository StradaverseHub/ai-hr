/** Management forms select source-owned candidates. No model response or evidence token enters props. */
import {getLocale,getTranslations} from 'next-intl/server';
import {Card,inputCls,btnPrimary} from '../ui';
import type {agentReviewWorkspaceTx} from '../../core/module-agent-releases';
import {PROMPT_HOLDOUTS,PROMPT_HOLDOUT_REQUEST_LIMIT,PROMPT_HOLDOUT_LOCALES} from '../../lib/ai/module-agent-prompt-candidate';
import {AGENT_MODULE_CODES} from '../../lib/ai/module-agents';
import {OwnClearForm} from './own-clear';
import {createAgentCandidateAction,evaluateAgentCandidateAction,promoteAgentCandidateAction,rollbackAgentCandidateAction,tryAgentCandidateAction,createConversationCandidateAction,evaluateConversationCandidateAction,promoteConversationCandidateAction,eraseConversationMetadataAction} from '../../app/(app)/assistant/agent-review-actions';
type View=NonNullable<Awaited<ReturnType<typeof agentReviewWorkspaceTx>>>;
export async function ModuleAgentReview({view}:{view:View}){
 const [t,native,jobs,locale]=await Promise.all([getTranslations('assistant.workspace.agentReview'),getTranslations('assistant.workspace.nativeOutcomes'),getTranslations('assistant.workspace.jobs'),getLocale()]);
 const number=new Intl.NumberFormat(locale,{maximumFractionDigits:4}),metric=(value:number|null)=>value===null?t('metricUnknown'):number.format(value);const trials=PROMPT_HOLDOUTS.filter(row=>row.locale===locale);
 const reviewable=view.candidates.filter(row=>!row.own&&row.kind==='read_plan_prompt_v1');
 const label=(row:View['candidates'][number])=>t('record',{version:row.version,kind:t(row.kind==='read_plan_prompt_v1'?'kindPrompt':'kindRoute'),attempts:row.attempts});
 return <Card className="p-5"><details><summary className="min-h-11 cursor-pointer text-sm font-medium">{t('title')}</summary>
  <div className="mt-3 space-y-5">{await ConversationCandidateReview({view})}<p className="text-xs text-muted-foreground">{t('scope',{modules:AGENT_MODULE_CODES.length,locales:PROMPT_HOLDOUT_LOCALES.length,requests:PROMPT_HOLDOUT_REQUEST_LIMIT})}</p><p className="text-xs text-muted-foreground">{t('pairedBudget',{requests:PROMPT_HOLDOUT_REQUEST_LIMIT,pairs:Math.floor(PROMPT_HOLDOUT_REQUEST_LIMIT/2)})}</p>
   {view.lastTrial&&<p role="status" className="text-sm">{t('lastTrial',{state:t(`state_${view.lastTrial.state}`)})}</p>}
   <form action={createAgentCandidateAction} className="space-y-2">
    <input type="hidden" name="version" value={view.nextVersion}/>
    <label className="block text-sm">{t('variant')}<select name="variant" className={`${inputCls} mt-1 w-full`}>
     <option value="concise_v1">{t('concise')}</option><option value="explicit_scope_v1">{t('explicit')}</option>
    </select></label>
    {view.ownSignalChoices.length>0&&<fieldset className="space-y-2"><legend className="text-sm">{t('signalsTitle')}</legend><p className="text-xs text-muted-foreground">{t('signalsConsent')}</p>{view.ownSignalChoices.map(signal=><label key={signal.id} className="flex min-h-11 items-center gap-2 text-xs"><input type="checkbox" name="signalId" value={signal.id}/><span>{t(`signal_${signal.outcome}`)}</span></label>)}</fieldset>}
    {view.ownNativeSignalChoices.length>0&&<label className="block text-sm">{native('candidateTitle')}
     <span className="mt-1 block text-xs text-muted-foreground">{native('candidateIntro')}</span>
     <select name="nativeSignalId" defaultValue="" className={`${inputCls} mt-1 min-h-11 w-full`}><option value="">{native('candidateNone')}</option>{view.ownNativeSignalChoices.map(signal=><option key={signal.associationId} value={signal.associationId}>{jobs(`module_${signal.module}`)} · {native(`action_${signal.action.replace(/[.-]/g,'_')}`)}</option>)}</select></label>}
    {view.nativeSignalChoicesTruncated&&<p className="text-xs text-muted-foreground">{native('bounded')}</p>}
    <button type="submit" className={`${btnPrimary} min-h-11`}>{t('create')}</button>
   </form>
   <div className="space-y-1"><h3 className="text-sm font-medium">{t('candidates')}</h3>
    {view.candidates.length?view.candidates.map(row=>{const pairing=row.progress?.comparison;return <div key={row.id} className="text-xs text-muted-foreground"><p>{label(row)}</p><p>{row.verifiedSignalCount===null?t('signalsUnknown'):t('signalsCount',{count:row.verifiedSignalCount})}</p>
     {!row.own&&row.kind==='read_plan_prompt_v1'&&<p>{row.progress?t('progress',{completed:row.progress.completedCases,total:row.progress.totalCases,
      failures:row.progress.knownFailures,state:t(row.progress.state==='complete'?'state_complete':'state_incomplete')}):t('progressUnknown')}</p>}
     {pairing&&<section className="my-2 space-y-2 rounded-md border p-3" aria-label={t('pairedTitle')}>
      <h4 className="font-medium">{t('pairedTitle')}</h4><p>{t(row.progress?.state!=='complete'?'qualityPending':pairing.qualityImproved?'qualityGain':'qualityNoGain')}</p>
      <dl className="grid gap-2 sm:grid-cols-2">{(['baseline','candidate'] as const).map(arm=><div key={arm}><dt className="font-medium">{t(arm==='baseline'?'baselineArm':'candidateArm')}</dt><dd>{t('armQuality',{correct:pairing[arm].correct,total:row.progress!.totalCases,failures:pairing[arm].securityFailures})}</dd><dd>{t('armMetrics',{p50:metric(pairing[arm].p50Ms),p95:metric(pairing[arm].p95Ms),tokens:metric(pairing[arm].tokens),credits:metric(pairing[arm].costCredits)})}</dd></div>)}</dl>
      <p>{t('resourceObservations')}</p>
     </section>}
    </div>}):<p className="text-xs text-muted-foreground">{t('empty')}</p>}
   </div>
   {reviewable.length>0&&<>
    <form action={evaluateAgentCandidateAction} className="space-y-2">
     <label className="block text-sm">{t('choose')}<select name="candidateId" className={`${inputCls} mt-1 w-full`}>{reviewable.map(row=><option key={row.id} value={row.id}>{label(row)}</option>)}</select></label>
     <label className="flex items-start gap-2 text-xs"><input required type="checkbox" name="consented" value="yes" className="mt-0.5"/><span>{t('consent',{requests:PROMPT_HOLDOUT_REQUEST_LIMIT})}</span></label>
     <button type="submit" className={`${btnPrimary} min-h-11`}>{t('evaluate')}</button>
    </form>
    <form action={promoteAgentCandidateAction} className="space-y-2">
     <label className="block text-sm">{t('choose')}<select name="candidateId" className={`${inputCls} mt-1 w-full`}>{reviewable.map(row=><option key={row.id} value={row.id}>{label(row)}</option>)}</select></label>
     <div className="grid grid-cols-2 gap-3"><label className="text-xs">{t('maxJobs')}<input name="maxJobs" type="number" min={1} max={100} defaultValue={5} required className={`${inputCls} mt-1 w-full`}/></label>
      <label className="text-xs">{t('hours')}<input name="hours" type="number" min={1} max={24} defaultValue={1} required className={`${inputCls} mt-1 w-full`}/></label></div>
     <p className="text-xs text-muted-foreground">{t('pending')}</p><button type="submit" className={`${btnPrimary} min-h-11`}>{t('promote')}</button>
    </form>
   </>}
   <form action={tryAgentCandidateAction} className="space-y-2">
    <label className="block text-sm">{t('fixture')}<select name="fixtureId" className={`${inputCls} mt-1 w-full`}>{trials.map(row=><option key={row.id} value={row.id}>{row.question}</option>)}</select></label>
    <label className="flex items-start gap-2 text-xs"><input required type="checkbox" name="consented" value="yes" className="mt-0.5"/><span>{t('consent',{requests:1})}</span></label>
    <button type="submit" className={`${btnPrimary} min-h-11`}>{t('tryout')}</button>
   </form>
   {view.promotions.filter(row=>!row.retired).length>0&&<form action={rollbackAgentCandidateAction} className="space-y-2">
    <label className="block text-sm">{t('rollback')}<select name="promotionId" className={`${inputCls} mt-1 w-full`}>{view.promotions.filter(row=>!row.retired).map(row=><option key={row.id} value={row.id}>{t(row.kind==='read_plan_prompt_v1'?'kindPrompt':'kindRoute')} · {row.version} · {row.used}/{row.maximum}</option>)}</select></label>
    <button type="submit" className="min-h-11 rounded-md border px-3 text-sm">{t('rollback')}</button>
   </form>}
  </div></details></Card>;
}

/** Main-answer improvements are labelled separately from the routing-only forms above. */
async function ConversationCandidateReview({view}:{view:View}){
 const [t,shared,native,jobs]=await Promise.all([getTranslations('assistant.workspace.conversationGovernance'),getTranslations('assistant.workspace.agentReview'),getTranslations('assistant.workspace.nativeOutcomes'),getTranslations('assistant.workspace.jobs')]),rows=view.conversationCandidates??[],promotions=view.conversationPromotions??[],reviewable=rows.filter(row=>!row.own),metric=(v:number|null)=>v===null?t('unknown'):String(v);
 return <section className="space-y-3 rounded-md border p-4" aria-label={t('title')}><h3 className="font-medium">{t('title')}</h3><p className="text-sm text-muted-foreground">{t('scope')}</p>
  <form action={createConversationCandidateAction} className="space-y-2"><input type="hidden" name="version" value={view.nextVersion}/><label className="block text-sm">{shared('variant')}<select name="variant" defaultValue="focused_v1" className={`${inputCls} mt-1 min-h-11 w-full`}><option value="baseline_v1">{t('baseline')}</option><option value="focused_v1">{t('focused')}</option></select></label>
   {view.ownSignalChoices.length>0&&<fieldset><legend className="text-sm">{shared('signalsTitle')}</legend><p className="text-xs text-muted-foreground">{shared('signalsConsent')}</p>{view.ownSignalChoices.map(signal=><label key={signal.id} className="flex min-h-11 items-center gap-2 text-sm"><input type="checkbox" name="signalId" value={signal.id}/>{shared(`signal_${signal.outcome}`)}</label>)}</fieldset>}
   {view.ownNativeSignalChoices.length>0&&<label className="block text-sm">{native('candidateTitle')}<span className="block text-xs text-muted-foreground">{native('candidateIntro')}</span><select name="nativeSignalId" defaultValue="" className={`${inputCls} min-h-11 w-full`}><option value="">{native('candidateNone')}</option>{view.ownNativeSignalChoices.map(signal=><option key={signal.associationId} value={signal.associationId}>{jobs(`module_${signal.module}`)} · {native(`action_${signal.action.replace(/[.-]/g,'_')}`)}</option>)}</select></label>}
   <button type="submit" className={`${btnPrimary} min-h-11`}>{t('create')}</button></form>
  <ul className="space-y-3">{rows.map(row=><li key={row.id} className="space-y-1 text-sm"><p className="font-medium">{t('record',{version:row.version})}</p><p>{row.progress?t('progress',{completed:row.progress.completedCases,total:row.progress.totalCases,failures:row.progress.knownFailures}):t('unknown')}</p>
   {row.progress&&<><p>{shared(row.progress.state!=='complete'?'qualityPending':row.progress.comparison.qualityImproved?'qualityGain':'qualityNoGain')}</p><dl className="grid gap-3 sm:grid-cols-2">{(['baseline','candidate'] as const).map(arm=>{const stats=row.progress!.comparison[arm];return <div key={arm}><dt className="font-medium">{shared(arm==='baseline'?'baselineArm':'candidateArm')}</dt><dd>{t('metrics',{correct:stats.correct,security:stats.securityFailures,p50:metric(stats.p50Ms),p95:metric(stats.p95Ms),input:metric(stats.inputTokens),output:metric(stats.outputTokens),credits:metric(stats.costCredits)})}</dd></div>;})}</dl></>}
  </li>)}</ul>{!rows.length&&<p className="text-sm text-muted-foreground">{t('noCandidates')}</p>}
  {reviewable.length>0&&<><form action={evaluateConversationCandidateAction} className="space-y-2"><label className="block text-sm">{t('choose')}<select name="candidateId" className={`${inputCls} mt-1 min-h-11 w-full`}>{reviewable.map(row=><option key={row.id} value={row.id}>{t('record',{version:row.version})}</option>)}</select></label><label className="flex items-start gap-2 text-sm"><input type="checkbox" name="consented" value="yes" required className="mt-1"/>{t('consent')}</label><button type="submit" className={`${btnPrimary} min-h-11`}>{t('evaluate')}</button></form>
   <form action={promoteConversationCandidateAction} className="space-y-2"><label className="block text-sm">{t('choose')}<select name="candidateId" className={`${inputCls} mt-1 min-h-11 w-full`}>{reviewable.map(row=><option key={row.id} value={row.id}>{t('record',{version:row.version})}</option>)}</select></label><div className="grid grid-cols-2 gap-3"><label>{shared('maxJobs')}<input className={inputCls} name="maxJobs" type="number" min={1} max={100} defaultValue={5} required/></label><label>{shared('hours')}<input className={inputCls} name="hours" type="number" min={1} max={24} defaultValue={1} required/></label></div><p className="text-xs text-muted-foreground">{t('condition')}</p><button type="submit" className={`${btnPrimary} min-h-11`}>{t('promote')}</button></form></>}
  {promotions.map(row=><form key={row.id} action={rollbackAgentCandidateAction} className="flex flex-wrap items-center gap-2 text-sm"><input type="hidden" name="promotionId" value={row.id}/><span>{t('record',{version:row.version})} · {row.used}/{row.maximum}</span>{!row.retired&&<button type="submit" className="min-h-11 px-3 underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary">{shared('rollback')}</button>}</form>)}
  <OwnClearForm kind="conversation" action={eraseConversationMetadataAction} label={t('erase')} className="min-h-11 text-sm underline"/>
 </section>;
}
