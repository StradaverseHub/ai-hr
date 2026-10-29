import {SpecialistCandidateChoices} from './specialist-candidate-choices';
import {SpecialistPromotionChoices} from './specialist-promotion-choices';
import {randomUUID} from 'node:crypto';
import {getTranslations} from 'next-intl/server';
import {Card,inputCls,btnPrimary} from '../ui';
import type {AgentModuleCode} from '../../lib/ai/module-agents';
import type {specialistReviewWorkspaceTx} from '../../core/module-agent-releases';
import {createSpecialistCandidateAction,evaluateSpecialistCandidateAction,promoteSpecialistCandidateAction,rollbackSpecialistCandidateAction,runSpecialistJobAction} from '../../app/assistant/specialist-review-actions';
type View=NonNullable<Awaited<ReturnType<typeof specialistReviewWorkspaceTx>>>;

/** Human POST only; opening this chooser cannot consume a promoted candidate's job allowance. */
export async function SpecialistJobComposer({modules}:{modules:readonly AgentModuleCode[]}){
 const t=await getTranslations('assistant.workspace.specialists'),jobs=await getTranslations('assistant.workspace.jobs');
 return <Card className="p-5"><h2 className="text-base font-semibold">{t('runTitle')}</h2><p className="mt-1 text-sm text-muted-foreground">{t('runIntro')}</p>
  <form action={runSpecialistJobAction} className="mt-4 space-y-3">
   <input type="hidden" name="commandNonce" value={randomUUID()}/>
   <label className="block text-sm">{t('module')}<select name="module" required defaultValue="" className={`${inputCls} mt-1 min-h-11 w-full`}>
    <option value="" disabled>{t('chooseModule')}</option>{modules.map(module=><option key={module} value={module}>{jobs(`module_${module}`)}</option>)}
   </select></label>
   <button type="submit" disabled={!modules.length} className={`${btnPrimary} min-h-11`}>{t('run')}</button>
  </form>
 </Card>;
}
/** Only source-owned group-admin metadata reaches these management forms. No posted score is used. */
export async function ModuleSpecialistReview({view}:{view:View}){
 const t=await getTranslations('assistant.workspace.specialists'),jobs=await getTranslations('assistant.workspace.jobs'),signals=await getTranslations('assistant.workspace.governed'),native=await getTranslations('assistant.workspace.nativeOutcomes');
 const reviewable=view.candidates.filter(row=>!row.own),promotable=reviewable.filter(row=>(row.passingEvaluators??0)>=2),active=view.promotions.filter(row=>!row.retired);
 // Saved rows show THEIR candidate version; the picker shows the version the next candidate will get.
 const record=(row:{module:AgentModuleCode;version:number})=>t('record',{module:jobs(`module_${row.module}`),version:row.version}),nextRecord=(row:{module:AgentModuleCode;version:number})=>t('nextRecord',{module:jobs(`module_${row.module}`),version:row.version});
 return <Card className="p-5"><details><summary className="min-h-11 cursor-pointer text-sm font-medium">{t('title')}</summary>
  <div className="mt-3 space-y-5"><p className="text-xs text-muted-foreground">{t('intro')}</p>
   <form action={createSpecialistCandidateAction} className="space-y-3">
    <SpecialistCandidateChoices modules={view.modules.map(row=>({value:`${row.module}:${row.nextVersion}`,module:row.module,label:nextRecord({module:row.module,version:row.nextVersion})}))} evidence={view.ownNativeSignalChoices.map(signal=>({value:signal.associationId,module:signal.module,label:jobs(`module_${signal.module}`)+' · '+native(`action_${signal.action.replace(/[.-]/g,'_')}`)}))} messages={{module:t('module'),nativeTitle:native('candidateTitle'),nativeIntro:native('candidateIntro'),nativeNone:native('candidateNone')}}/>
    <label className="block text-sm">{t('strategy')}<select name="playbook" defaultValue="canonical_domain_v1" required className={`${inputCls} mt-1 min-h-11 w-full`}><option value="canonical_domain_v1">{t('strategySummary')}</option><option value="canonical_followup_v1">{t('strategyDiagnostic')}</option></select></label><p className="text-xs text-muted-foreground">{t('strategyScope')}</p>
    {view.ownSignalChoices.length>0&&<fieldset className="space-y-2"><legend className="text-sm">{t('signalsTitle')}</legend><p className="text-xs text-muted-foreground">{t('signalsConsent')}</p>
     {view.ownSignalChoices.map(signal=><label key={signal.id} className="flex min-h-11 items-center gap-2 text-xs"><input type="checkbox" name="signalId" value={signal.id}/><span>{jobs(`module_${signal.module}`)} · {signals(`signal_${signal.outcome}`)}</span></label>)}
    </fieldset>}
    {view.signalChoicesTruncated&&<p className="text-xs text-muted-foreground">{t('signalsTruncated')}</p>}
    {view.nativeSignalChoicesTruncated&&<p className="text-xs text-muted-foreground">{t('signalsTruncated')}</p>}
    <button type="submit" disabled={!view.modules.length} className={`${btnPrimary} min-h-11`}>{t('create')}</button>
   </form>
   {view.candidates.length?<ul className="space-y-3">{view.candidates.map(row=><li key={row.id} className="rounded-lg border p-3 text-sm">
    <p className="font-medium">{record(row)}{row.playbook&&<> · {t(row.playbook==='canonical_followup_v1'?'strategyDiagnostic':'strategySummary')}</>}</p><p className="mt-1 text-xs text-muted-foreground">{row.evaluations===null||row.passingEvaluators===null||row.incompleteEvaluators===null?t('evaluationsUnknown'):<>{t('evaluations',{count:row.evaluations})} · {t('passing',{count:row.passingEvaluators})} · {t('incomplete',{count:row.incompleteEvaluators})}</>}</p>
   </li>)}</ul>:<p className="text-sm text-muted-foreground">{t('empty')}</p>}
   {reviewable.length>0&&<form action={evaluateSpecialistCandidateAction} className="space-y-3">
    <label className="block text-sm">{t('chooseCandidate')}<select name="candidateId" required className={`${inputCls} mt-1 min-h-11 w-full`}>{reviewable.map(row=><option key={row.id} value={row.id}>{record(row)}</option>)}</select></label>
    <label className="flex min-h-11 items-start gap-2 text-xs"><input type="checkbox" name="consented" value="yes" required className="mt-0.5"/><span>{t('evaluateConsent')}</span></label>
    <button type="submit" className={`${btnPrimary} min-h-11`}>{t('evaluate')}</button>
   </form>}
   {promotable.length>0&&<form action={promoteSpecialistCandidateAction} className="space-y-3">
    <SpecialistPromotionChoices candidates={promotable.map(row=>({value:row.id,label:record(row),personalSignals:row.personalSignals}))} companies={view.companies}
     messages={{chooseCandidate:t('chooseCandidate'),scopeLegend:t('scopeLegend'),scopeUser:t('scopeUser'),scopeCompany:t('scopeCompany'),scopeTenant:t('scopeTenant'),company:t('scopeCompanyChoice'),scopeHint:t('scopeHint'),scopeSignalsOnly:t('scopeSignalsOnly')}}/>
    <div className="grid gap-3 sm:grid-cols-2"><label className="text-sm">{t('maxJobs')}<input name="maxJobs" type="number" min={1} max={100} defaultValue={5} required className={`${inputCls} mt-1 min-h-11 w-full`}/></label>
     <label className="text-sm">{t('hours')}<input name="hours" type="number" min={1} max={24} defaultValue={1} required className={`${inputCls} mt-1 min-h-11 w-full`}/></label></div>
    <p className="text-xs text-muted-foreground">{t('promotionScope')}</p><button type="submit" className={`${btnPrimary} min-h-11`}>{t('promote')}</button>
   </form>}
   {active.length>0&&<form action={rollbackSpecialistCandidateAction} className="space-y-3"><label className="block text-sm">{t('rollback')}<select name="promotionId" className={`${inputCls} mt-1 min-h-11 w-full`}>{active.map(row=><option key={row.id} value={row.id}>{record(row)} · {row.used}/{row.maximum}</option>)}</select></label>
    <button type="submit" className="min-h-11 rounded-md border px-3 text-sm">{t('rollback')}</button>
   </form>}
  </div>
 </details></Card>;
}
