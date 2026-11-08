import { getRewardUnit } from '@/packs/rewards/service';
import { importOnehrAction, importFactsAction } from '../../actions';
import { SourceRefresh } from '../source-refresh';
import { PayWindowExcluded } from '../pay-window';
import { todayInKualaLumpur } from '@/lib/hr-date';
import Link from 'next/link';
import { getLocale, getTranslations } from 'next-intl/server';
import { requireModule } from '@/lib/authz';
import { scopedSession } from '@/lib/scope';
import { getRewardPreparationChecklist, getRewardUnitGovernance } from '@/packs/rewards/service';
import { REWARD_PREPARATION_STEPS } from '@/packs/rewards/preparation-model';
import { Card, ErrorBanner, Field, PageHeader, inputCls } from '@/components/ui';
import { RewardSubmit } from '../../submit-button';
import { preparationAction } from '../../preparation-actions';
import { UnitGovernance } from '../unit-governance';

export default async function RewardUnitSetup({params,searchParams}:{params:Promise<{unitId:string}>;searchParams:Promise<{error?:string}>}){
 await requireModule('rewards');const {s}=await scopedSession(),{unitId}=await params,{error}=await searchParams;
 const t=await getTranslations('rewardsPreparation');
 const value=await getRewardPreparationChecklist(s,unitId);
 const {preparation,basis,checks,canEdit,access}=value;
 const released=preparation.state==='released';
 const fields=<><input type="hidden" name="unitId" value={unitId}/><input type="hidden" name="revision" value={value.revision}/><input type="hidden" name="basis" value={basis}/></>;
 const missing=REWARD_PREPARATION_STEPS.filter(step=>preparation.steps[step]?.basis!==basis||checks&&!checks[step]);
 const independent=access.independentChecker;
 const links:Record<typeof REWARD_PREPARATION_STEPS[number],string>={snapshot:'#source-records',data:`/rewards/${unitId}/data-check`,excluded:'#excluded',senior:`/admin/rewards/${unitId}#senior-membership`,budget:'/admin/rewards/pat-inputs',applied:'#applied-setup'};
 const locale=await getLocale();
 const money=(cents:number|null)=>cents===null?t('notSet'):new Intl.NumberFormat(locale,{style:'currency',currency:'MYR'}).format(cents/100);
 const governance=await getRewardUnitGovernance(s,unitId);
 const review=await getRewardUnit(s,unitId),rt=await getTranslations('rewards'),onehr=await getTranslations('onehr');
 return <div className="w-full space-y-5">
  <PageHeader title={t('title')} description={`${review.companyName} · ${review.name} · ${t('description')}`}/>
  <nav aria-label={t('tabs')} className="flex gap-4 border-b border-border pb-3 text-sm"><Link href={`/rewards/${unitId}`} className="text-muted-foreground hover:underline">{t('review')}</Link><Link href={`/rewards/${unitId}/setup`} aria-current="page" className="font-semibold text-primary">{t('setup')}</Link></nav>
  <ErrorBanner message={error}/>
  {!access.required&&<p role="note" className="text-sm text-muted-foreground">{t('legacy')}</p>}
  {!canEdit&&<p role="note" className="text-sm text-muted-foreground">{t('readOnly')}</p>}
  <Card className="space-y-5 p-5">
   <h2 className="text-lg font-semibold">{t('checklist')}</h2>
   <p className="text-sm text-muted-foreground">{t('snapshotDate',{date:value.snapshotDate})}</p>
   {access.required&&canEdit&&!released?<form action={preparationAction} className="flex flex-wrap items-end gap-3">{fields}<input type="hidden" name="kind" value="expected"/><Field label={t('expected')}><input name="expectedRelease" type="date" required defaultValue={preparation.expectedRelease??''} className={inputCls}/></Field><RewardSubmit variant="secondary">{t('saveExpected')}</RewardSubmit></form>:<p className="text-sm">{t('expected')}: {preparation.expectedRelease??t('notSet')}</p>}
   <ol className="divide-y divide-border">
    {REWARD_PREPARATION_STEPS.map((step,index)=>{
     const proof=preparation.steps[step],done=proof?.basis===basis&&(!checks||checks[step]);
     const complete=checks?.[step]??false;
     return <li key={step} className="flex flex-wrap items-center justify-between gap-3 py-4">
      <div className="min-w-0"><h3 className="font-medium">{index+1}. {t(`steps.${step}`)}</h3><p className="mt-1 text-sm text-muted-foreground">{t(`help.${step}`)}</p><Link href={links[step]} className="mt-1 inline-block text-sm text-primary hover:underline">{t('openStep')}</Link></div>
      <div className="flex flex-wrap items-center gap-3 text-sm"><span>{!access.required?t('notRecorded'):done?t('done'):proof?t('pending'):t('notStarted')}</span>{proof&&<span className="text-muted-foreground">{t('completedBy',{name:access.actorNames[proof.actorPersonId]??t('groupRewards')})}</span>}
       {access.required&&canEdit&&!released&&!done&&<form action={preparationAction}>{fields}<input type="hidden" name="kind" value="confirm"/><input type="hidden" name="step" value={step}/><RewardSubmit variant="secondary" disabled={!complete}>{t('confirm')}</RewardSubmit></form>}
      </div>
     </li>;
    })}
   </ol>
   {access.required&&!released&&<div className="flex flex-wrap items-center gap-3"><form action={preparationAction}>{fields}<input type="hidden" name="kind" value="release"/><RewardSubmit disabled={!canEdit||missing.length>0||!preparation.expectedRelease||!independent}>{t('release')}</RewardSubmit></form><p role="status" className="text-sm text-muted-foreground">{missing.length?t('missing',{step:REWARD_PREPARATION_STEPS.indexOf(missing[0])+1,name:t(`steps.${missing[0]}`)}):!preparation.expectedRelease?t('setExpected'):!independent?t('independent'):t('ready')}</p></div>}
   {released&&<p role="status" className="text-sm">{t('released',{date:preparation.releasedAt?.slice(0,10)??''})}</p>}
   {(value.canReopen&&(released||value.needsReopen))&&<form action={preparationAction} className="space-y-3">{fields}<input type="hidden" name="kind" value="reopen"/><Field label={t('changeReason')}><textarea name="reason" required minLength={10} maxLength={2000} className={inputCls}/></Field><RewardSubmit variant="secondary">{t('requestChange')}</RewardSubmit></form>}
  </Card>
  <section id="source-records" className="space-y-4 scroll-mt-6"><h2 className="text-lg font-semibold">{t('steps.snapshot')}</h2>
   {canEdit&&!released?<SourceRefresh unitId={unitId} revision={value.revision} snapshotDate={value.snapshotDate} today={todayInKualaLumpur()}/>:<p className="text-sm text-muted-foreground">{t('snapshotDate',{date:value.snapshotDate})}</p>}
  </section>
  <section id="data" className="space-y-4 scroll-mt-6"><h2 className="text-lg font-semibold">{t('steps.data')}</h2>
   <div className="flex flex-wrap gap-4 text-sm"><Link href={`/rewards/${unitId}/data-check`} className="text-primary hover:underline">{rt('prelaunchDataCheck')}</Link>{access.isGr&&<Link href={`/rewards/${unitId}/export?template=1`} className="text-primary hover:underline">{rt('downloadTemplate')}</Link>}</div>
   {canEdit&&!released&&<><form action={importOnehrAction} className="space-y-3">{fields}<p className="text-sm text-muted-foreground">{onehr('rewardImportHelp')}</p><RewardSubmit variant="secondary">{onehr('rewardImport')}</RewardSubmit></form><form action={importFactsAction} className="space-y-3">{fields}<Field label={rt('completedTemplate')}><input type="file" name="file" accept=".csv" required className="block w-full min-w-0 text-sm"/></Field><RewardSubmit>{rt('import')}</RewardSubmit></form></>}
  </section>
  <section id="excluded" className="scroll-mt-6"><PayWindowExcluded unitId={unitId} revision={value.revision} canEdit={canEdit&&!released} window={{from:review.unit.policy.blockedFrom,to:review.unit.policy.blockedTo}} rows={review.rows} kept={review.unit.policy.payWindowKeep??{}}/></section>
  <section id="applied-setup" className="space-y-4 scroll-mt-6"><h2 className="text-lg font-semibold">{t('steps.applied')}</h2><dl className="divide-y divide-border text-sm">
   <div className="flex flex-wrap justify-between gap-3 py-3"><dt>{t('sharedConfiguration')}</dt><dd>{access.origin?`${access.origin.name} · ${t('version',{number:access.origin.revision})}`:t('notSet')}</dd></div>
   {(['salary','bonus'] as const).map(kind=><div key={kind} className="flex flex-wrap justify-between gap-3 py-3"><dt>{t(kind==='salary'?'salaryStructure':'bonusMatrix')}</dt><dd>{access.applied?.[kind]?`${access.applied[kind].name} · ${t('version',{number:access.applied[kind].version})}`:t('notSet')}</dd></div>)}
   </dl><Link href={`/admin/rewards/${unitId}?mode=view#applied-setup`} className="text-sm text-primary hover:underline">{t('viewApplied')}</Link>
  </section>
  <section className="space-y-3 [&_button]:h-auto [&_button]:min-h-9 [&_button]:max-w-full [&_button]:whitespace-normal"><h2 className="text-lg font-semibold">{t('budgetControls')}</h2>{!access.isGr&&value.budgetInputs&&<dl className="grid gap-3 text-sm sm:grid-cols-2"><div><dt>{rt('governance.forecast')}</dt><dd>{money(value.budgetInputs.forecastCents)}</dd></div><div><dt>{rt('governance.actual')}</dt><dd>{money(value.budgetInputs.actualCents)}</dd></div><div><dt>{rt('governance.target')}</dt><dd>{money(value.budgetInputs.targetCents)}</dd></div><div><dt>{rt('governance.targetMonths')}</dt><dd>{(value.budgetInputs.targetMonthsBp/10000).toLocaleString(locale)}</dd></div></dl>}<UnitGovernance value={{...governance,canEdit:canEdit&&!released}} branch={value.branch}/></section>
  <section id="preparation-history" className="space-y-3 scroll-mt-6"><h2 className="text-lg font-semibold">{t('changeLog')}</h2><ol className="divide-y divide-border text-sm">{access.history.map(event=><li key={event.id} className="space-y-1 py-3"><p>{event.kind==='preparation-invalidated'?t('sourceChanged'):event.reason}</p><p className="text-muted-foreground">{event.actorName??t('system')} · {new Intl.DateTimeFormat(locale,{timeZone:'Asia/Kuala_Lumpur',dateStyle:'medium',timeStyle:'short'}).format(new Date(event.at))}</p></li>)}</ol></section>
  <p className="text-sm text-muted-foreground">{t('changeLogHelp')} <Link href="#preparation-history" className="text-primary hover:underline">{t('changeLog')}</Link></p>
 </div>;
}
