/** Management forms select source-owned candidates. No model response or evidence token enters props. */
import {getLocale,getTranslations} from 'next-intl/server';
import {Card,inputCls,btnPrimary} from '../ui';
import type {agentReviewWorkspaceTx} from '../../core/module-agent-releases';
import {PROMPT_HOLDOUTS,PROMPT_HOLDOUT_REQUEST_LIMIT,PROMPT_HOLDOUT_LOCALES} from '../../lib/ai/module-agent-prompt-candidate';
import {AGENT_MODULE_CODES} from '../../lib/ai/module-agents';
import {createAgentCandidateAction,evaluateAgentCandidateAction,promoteAgentCandidateAction,rollbackAgentCandidateAction,tryAgentCandidateAction} from '../../app/assistant/agent-review-actions';
type View=NonNullable<Awaited<ReturnType<typeof agentReviewWorkspaceTx>>>;
export async function ModuleAgentReview({view}:{view:View}){
 const t=await getTranslations('assistant.workspace.agentReview');
 const locale=await getLocale();const trials=PROMPT_HOLDOUTS.filter(row=>row.locale===locale);
 const reviewable=view.candidates.filter(row=>!row.own&&row.kind==='read_plan_prompt_v1');
 const label=(row:View['candidates'][number])=>t('record',{version:row.version,kind:t(row.kind==='read_plan_prompt_v1'?'kindPrompt':'kindRoute'),attempts:row.attempts});
 return <Card className="p-5"><details><summary className="min-h-11 cursor-pointer text-sm font-medium">{t('title')}</summary>
  <div className="mt-3 space-y-5"><p className="text-xs text-muted-foreground">{t('scope',{modules:AGENT_MODULE_CODES.length,locales:PROMPT_HOLDOUT_LOCALES.length,requests:PROMPT_HOLDOUT_REQUEST_LIMIT})}</p>
   {view.lastTrial&&<p role="status" className="text-sm">{t('lastTrial',{state:t(`state_${view.lastTrial.state}`)})}</p>}
   <form action={createAgentCandidateAction} className="space-y-2">
    <input type="hidden" name="version" value={view.nextVersion}/>
    <label className="block text-sm">{t('variant')}<select name="variant" className={`${inputCls} mt-1 w-full`}>
     <option value="concise_v1">{t('concise')}</option><option value="explicit_scope_v1">{t('explicit')}</option>
    </select></label><button type="submit" className={`${btnPrimary} min-h-11`}>{t('create')}</button>
   </form>
   <div className="space-y-1"><h3 className="text-sm font-medium">{t('candidates')}</h3>
    {view.candidates.length?view.candidates.map(row=><p key={row.id} className="text-xs text-muted-foreground">{label(row)}</p>):<p className="text-xs text-muted-foreground">{t('empty')}</p>}
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
