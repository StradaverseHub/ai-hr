/** Suggested labels only: no model prose, facts, scopes, identifiers or automatic canonical reads. */
import {randomUUID} from 'node:crypto';
import {getTranslations} from 'next-intl/server';
import {Card} from '../ui';
import {proposeModulePlanAction,eraseModuleProposalsAction,evaluateHumanPlannerAction} from '../../app/(app)/assistant/module-plan-actions';
import {runGovernedPlanAction} from '../../app/(app)/assistant/governed-job-actions';
import {OwnClearForm} from './own-clear';
import type {OwnModulePlanView} from '../../core/module-agent-releases';
/** First render asks nothing, so it reports no failure: only a submitted request's own status may say
 * "snag". No provider means "not set up" (calm), never an error. */
export async function ModuleQuestionPlanner({view,status,permit,availability}:{view:OwnModulePlanView|null;status?:string;permit:string|null;availability?:'ready'|'no_provider'|'resting'}){
 const t=await getTranslations('assistant.workspace.planning'),jobs=await getTranslations('assistant.workspace.jobs');
 return <Card className="space-y-4 p-5"><div><h2 className="text-base font-semibold">{t('title')}</h2><p className="mt-1 text-sm text-muted-foreground">{t('intro')}</p></div>
  {status&&<p role="status" className="text-sm text-muted-foreground">{t(status==='chooser'?'chooser':status==='evaluated'?'evaluated':'unavailable')}</p>}
  {permit?<form action={proposeModulePlanAction} className="space-y-3"><input type="hidden" name="requestPermit" value={permit}/>
   <label className="block text-sm">{t('question')}<textarea name="question" required maxLength={2000} rows={3} className="mt-1 w-full rounded-md border bg-background p-3 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"/></label>
   <label className="flex items-start gap-2 text-xs"><input name="consented" value="yes" type="checkbox" required className="mt-0.5"/><span>{t('consent')}</span></label>
   <button className="min-h-11 rounded-md border px-4 py-2 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary">{t('suggest')}</button>
  </form>:<p role="status" className="text-sm text-muted-foreground">{t(availability==='no_provider'?'noProvider':'resting')}</p>}
  {view&&(view.state==='ready'?<section aria-label={t('review')} className="space-y-3 border-t pt-4"><h3 className="text-sm font-semibold">{t('review')}</h3><ul className="list-disc pl-5 text-sm">{view.modules.map(module=><li key={module}>{jobs(`module_${module}`)}</li>)}</ul><p className="text-xs text-muted-foreground">{t('reviewNote')}</p>
   {view.consumedJobId?<a href={'/assistant?governed='+encodeURIComponent(view.consumedJobId)} className="inline-flex min-h-11 items-center text-sm underline">{t('reopen')}</a>:
    <form action={runGovernedPlanAction}><input type="hidden" name="commandNonce" value={randomUUID()}/><input type="hidden" name="proposalId" value={view.proposalId}/>{view.modules.map(module=><input key={module} type="hidden" name="module" value={module}/>)}<button className="min-h-11 rounded-md border px-4 py-2 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary">{t('confirm')}</button></form>}
  </section>:<p role="status" className="text-sm text-muted-foreground">{t(view.state)}</p>)}
  <OwnClearForm kind="proposals" action={eraseModuleProposalsAction} label={t('erase')}/>
 </Card>;
}
export async function HumanPlannerEvaluation({candidates}:{candidates:readonly {id:string;kind:string;own:boolean;version:number}[]}){
 const t=await getTranslations('assistant.workspace.planning'),eligible=candidates.filter(row=>row.kind==='read_plan_prompt_v1'&&!row.own);if(!eligible.length)return null;
 return <Card className="space-y-3 p-5"><h2 className="text-base font-semibold">{t('evaluation')}</h2><p className="text-xs text-muted-foreground">{t('evaluationNote')}</p>
  <form action={evaluateHumanPlannerAction} className="space-y-3"><label className="block text-sm">{t('candidate')}<select name="candidateId" required className="mt-1 min-h-11 w-full rounded-md border bg-background px-3">{eligible.map(row=><option key={row.id} value={row.id}>v{row.version}</option>)}</select></label>
   <label className="flex items-start gap-2 text-xs"><input name="consented" value="yes" type="checkbox" required className="mt-0.5"/><span>{t('evaluationConsent')}</span></label><button className="min-h-11 rounded-md border px-4 py-2 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary">{t('evaluate')}</button>
  </form></Card>;
}
