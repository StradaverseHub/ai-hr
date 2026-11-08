import Link from 'next/link';
import {getTranslations} from 'next-intl/server';
import {Card,SectionHeader,btnGhost,btnPrimary} from '@/components/ui';
import type {SessionContext} from '@/db/client';
import {withTenant} from '@/db/client';
import {aiCentreControlState} from '@/core/ai-centre-control';
import {aiCentreFunctions,aiCentreReadControls,aiCentreJobTypes} from '@/core/ai-centre-inventory';
import {readMandateKeysTx} from '@/core/mandates/mandates';
import {delegableJobType} from '@/core/mandates/job-types';
import {setAiCentreFunctionAction,setAiCentreJobAction,setAiCentreStopAction} from './centre-control-actions';

export async function AiCentreControls({session}:{session:SessionContext}){
 const t=await getTranslations('aiCentre.controls');
 const features=await getTranslations('aiManagement');
 const workers=await getTranslations('aiCentre.registry');
 const [state,controls,jobs]=await Promise.all([
  aiCentreControlState(session).catch(()=>null),aiCentreReadControls(session).catch(()=>null),
  withTenant(session,async tx=>Promise.all(aiCentreJobTypes().map(async id=>{
   const jobType=delegableJobType(id),keys=await readMandateKeysTx(tx,session.tenantId,jobType);
   return{jobType,enabled:keys.enablement?.enabled===true,maxValidityDays:keys.enablement?.maxValidityDays??90,maxRunsPerDay:keys.enablement?.maxRunsPerDay??1};
  }))).catch(()=>null),
 ]);
 const functions=aiCentreFunctions();
 const label=(name:string)=>name.replaceAll('_',' ').replaceAll('.',' ');
 const functionName=(row:(typeof functions)[number])=>row.key.startsWith('feature:')&&features.has('features.'+row.name)?features('features.'+row.name):row.key.startsWith('worker:')&&workers.has('workers.'+row.key.slice(7))?workers('workers.'+row.key.slice(7)):label(row.name);
 return <>
  <Card id="ai-centre-stop" className="scroll-mt-4 space-y-3 p-5">
   <SectionHeader title={t('stopTitle')}/>
   <p role="status" className="text-sm" data-ai-centre-state={state?state.stopped?'stopped':'running':'unknown'}>{state?t(state.stopped?'stopped':'running'):t('unknown')}</p>
   <p className="max-w-4xl text-sm text-muted-foreground">{t('stopHelp')}</p>
   {state&&<>
    <p className="text-sm text-muted-foreground">{t('pending',{count:state.pending})}</p>
    <form action={setAiCentreStopAction}>
     <input type="hidden" name="generation" value={state.generation}/><input type="hidden" name="stopped" value={String(!state.stopped)}/>
     <button type="submit" className={state.stopped?btnGhost:btnPrimary}>{t(state.stopped?'resume':'stop')}</button>
    </form>
   </>}
   <p className="text-xs text-muted-foreground">{t('resumeHelp')}</p>
  </Card>
  <Card id="ai-centre-functions" className="scroll-mt-4 space-y-3 p-5">
   <SectionHeader title={t('inventoryTitle')}/><p className="text-sm text-muted-foreground">{t('inventoryHelp',{count:functions.length})}</p>
   <details><summary className="min-h-11 cursor-pointer py-3 text-sm font-medium">{t('allFunctions')}</summary>
    <ul className="divide-y divide-border">{functions.map(row=><li key={row.key} className="flex flex-wrap items-center justify-between gap-3 py-3">
     <span className="min-w-0 text-sm">{functionName(row)}</span>
     {row.control==='read'?controls===null||controls.get(row.key)===undefined?<span role="status" className="text-sm text-muted-foreground">{t('unknown')}</span>:<form action={setAiCentreFunctionAction} className="flex items-center gap-3">
      <span className="text-sm text-muted-foreground">{t(controls.get(row.key)===false?'off':'on')}</span>
      <input type="hidden" name="function" value={row.key}/><input type="hidden" name="enabled" value={String(controls.get(row.key)===false)}/>
      <button type="submit" className={btnGhost} aria-label={`${t(controls.get(row.key)===false?'enable':'disable')} · ${functionName(row)}`}>{t(controls.get(row.key)===false?'enable':'disable')}</button>
     </form>:row.control==='existing'?<Link href={row.href} className="inline-flex min-h-11 items-center text-sm font-medium text-primary hover:underline">{t('configure')}</Link>:<span className="text-sm text-muted-foreground">{t(row.control==='platform'?'platform':'required')}</span>}
    </li>)}</ul>
   </details>
   <p className="text-xs text-muted-foreground">{t('parentHelp')}</p>
  </Card>
  <Card id="ai-centre-jobs" className="scroll-mt-4 space-y-3 p-5">
   <SectionHeader title={t('jobsTitle')}/><p className="text-sm text-muted-foreground">{t('jobsHelp')}</p>
   {jobs===null?<p role="status">{t('unknown')}</p>:<ul className="divide-y divide-border">{jobs.map(job=><li key={job.jobType} className="flex flex-wrap items-center justify-between gap-3 py-3">
    <span className="text-sm">{label(job.jobType)}</span><form action={setAiCentreJobAction}>
     <input type="hidden" name="jobType" value={job.jobType}/><input type="hidden" name="enabled" value={String(!job.enabled)}/>
     <input type="hidden" name="maxValidityDays" value={job.maxValidityDays}/><input type="hidden" name="maxRunsPerDay" value={job.maxRunsPerDay}/>
     <button className={btnGhost} type="submit" aria-label={`${t(job.enabled?'disable':'enable')} · ${label(job.jobType)}`}>{t(job.enabled?'disable':'enable')}</button>
    </form>
   </li>)}</ul>}
  </Card>
 </>;
}
