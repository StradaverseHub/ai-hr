import Link from 'next/link';
import { getLocale, getTranslations } from 'next-intl/server';
import { requireModule } from '@/lib/authz';
import { scopedSession } from '@/lib/scope';
import { todayInKualaLumpur } from '@/lib/hr-date';
import { formatMoney } from '@/lib/money';
import { Card, ErrorBanner, Field, PageHeader, inputCls } from '@/components/ui';
import { getRewardPreparationChecklist, getRewardSeniorMembership, getRewardUnit, getRewardUnitGovernance, RewardError } from '@/packs/rewards/service';
import { REWARD_PREPARATION_STEPS, type RewardPreparationStep } from '@/packs/rewards/preparation-model';
import { RewardSubmit } from '@/app/rewards/submit-button';
import { preparationAction } from '@/app/rewards/preparation-actions';
import { importFactsAction, importOnehrAction } from '@/app/rewards/actions';
import { SourceRefresh } from '@/app/rewards/[unitId]/source-refresh';
import { PayWindowExcluded } from '@/app/rewards/[unitId]/pay-window';
import { UnitGovernance } from '@/app/rewards/[unitId]/unit-governance';
import { SeniorMembership } from '@/app/rewards/[unitId]/senior-membership';
import { ReleaseChecker } from './release-checker';

type Step = RewardPreparationStep | 'history';
const steps = REWARD_PREPARATION_STEPS;

/**
 * 70d5e7c5 — one review's set-up in Configuration › Review Set-up: a numbered checklist on the left (status
 * and who confirmed each step) and one step open on the right. Group Rewards edits; CTRO and EC read. The
 * expected release date and Release to BU CEO sit at the bottom. Every command keeps its existing owner.
 */
export default async function ReviewSetupDetail({ params, searchParams }: { params: Promise<{ unitId: string }>; searchParams: Promise<{ step?: string; error?: string }> }) {
  await requireModule('rewards');
  const { s } = await scopedSession(), { unitId } = await params, sp = await searchParams;
  const t = await getTranslations('rewardsPreparation'), rt = await getTranslations('rewards'), onehr = await getTranslations('onehr'), nav = await getTranslations('nav');
  let value: Awaited<ReturnType<typeof getRewardPreparationChecklist>>;
  try { value = await getRewardPreparationChecklist(s, unitId); }
  catch (error) { if (!(error instanceof RewardError)) throw error; return <div className="space-y-3"><PageHeader title={nav('rewardsReviewSetup')} /><p role="status">{t('list.noAccess')}</p><Link href="/admin/rewards/review-setup" className="text-primary hover:underline">{t('detail.back')}</Link></div>; }
  const { preparation, basis, checks, canEdit, access } = value;
  const released = !access.required || preparation.state === 'released';
  const editable = canEdit && !released;
  const [review, governance, senior] = await Promise.all([getRewardUnit(s, unitId), getRewardUnitGovernance(s, unitId), access.isGr ? getRewardSeniorMembership(s, unitId).catch(() => null) : Promise.resolve(null)]);
  const locale = await getLocale();
  const step: Step = sp.step === 'history' || (steps as readonly string[]).includes(sp.step ?? '') ? sp.step as Step : steps.find(x => preparation.steps[x]?.basis !== basis) ?? 'snapshot';
  const fields = (returnStep: Step) => <><input type="hidden" name="unitId" value={unitId} /><input type="hidden" name="revision" value={value.revision} /><input type="hidden" name="basis" value={basis} /><input type="hidden" name="returnStep" value={returnStep} /></>;
  const done = (x: RewardPreparationStep) => !access.required || (preparation.steps[x]?.basis === basis && (!checks || checks[x]));
  const state = (x: RewardPreparationStep) => !access.required ? 'beforeTracking' : done(x) ? 'done' : preparation.steps[x] || checks?.[x] ? 'pending' : 'notStarted';
  const reasonFor = (x: RewardPreparationStep) => checks && !checks[x] ? t(x === 'excluded' && value.exclusionWindow.outsideYear ? 'reasons.window' : `reasons.${x}`) : t('reasons.unconfirmed');
  const blocker = access.required ? steps.find(x => !done(x)) : undefined;
  const firstBlocker = blocker ? t('blockedStep', { step: steps.indexOf(blocker) + 1, reason: reasonFor(blocker) }) : null;
  const time = (iso: string) => new Intl.DateTimeFormat(locale, { timeZone: 'Asia/Kuala_Lumpur', dateStyle: 'medium', timeStyle: 'short' }).format(new Date(iso));
  const day = (iso: string) => new Intl.DateTimeFormat(locale, { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' }).format(new Date(`${iso}T00:00:00Z`));
  const money = (cents: number | null) => cents === null ? t('notSet') : formatMoney(cents / 100, 'MYR');
  const stepHref = (x: Step) => `/admin/rewards/review-setup/${encodeURIComponent(unitId)}?step=${x}`;
  const badge: Record<string, string> = { done: 'bg-emerald-100 text-emerald-900 dark:bg-emerald-950 dark:text-emerald-100', beforeTracking: 'bg-emerald-100 text-emerald-900 dark:bg-emerald-950 dark:text-emerald-100', pending: 'bg-amber-100 text-amber-950 dark:bg-amber-950 dark:text-amber-100', notStarted: 'bg-muted text-foreground' };
  const panel = (x: RewardPreparationStep) => {
    const proof = preparation.steps[x];
    return <div className="space-y-4">
      <div className="flex flex-wrap items-start justify-between gap-3"><div><h2 className="text-lg font-semibold">{steps.indexOf(x) + 1}. {t(`steps.${x}`)}</h2><p className="text-sm text-muted-foreground">{t(`help.${x}`)}</p></div>
        <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${badge[state(x)]}`}>{t(state(x))}</span></div>
      {proof && access.required && <p className="text-sm text-muted-foreground">{t('completedBy', { name: access.actorNames[proof.actorPersonId] ?? t('groupRewards') })} · {time(proof.at)}</p>}
      {x === 'snapshot' && (editable ? <SourceRefresh unitId={unitId} revision={value.revision} snapshotDate={value.snapshotDate} today={todayInKualaLumpur()} /> : <p className="text-sm">{t('snapshotDate', { date: value.snapshotDate })}</p>)}
      {x === 'data' && <div className="space-y-4"><div className="flex flex-wrap gap-4 text-sm"><Link href={`/rewards/${unitId}/data-check`} className="text-primary hover:underline">{rt('prelaunchDataCheck')}</Link>{access.isGr && <Link href={`/rewards/${unitId}/export?template=1`} className="text-primary hover:underline">{rt('downloadTemplate')}</Link>}</div>
        {editable && <><form action={importOnehrAction} className="space-y-3"><input type="hidden" name="unitId" value={unitId} /><input type="hidden" name="revision" value={value.revision} /><p className="text-sm text-muted-foreground">{onehr('rewardImportHelp')}</p><RewardSubmit variant="secondary">{onehr('rewardImport')}</RewardSubmit></form>
          <form action={importFactsAction} className="space-y-3"><input type="hidden" name="unitId" value={unitId} /><input type="hidden" name="revision" value={value.revision} /><Field label={rt('completedTemplate')}><input type="file" name="file" accept=".csv" required className="block w-full min-w-0 text-sm" /></Field><RewardSubmit>{rt('import')}</RewardSubmit></form></>}</div>}
      {x === 'excluded' && <div className="space-y-3">
        <p className="text-sm">{t('window.dates', { from: day(value.exclusionWindow.from), to: day(value.exclusionWindow.to) })}</p>
        {value.exclusionWindow.outsideYear && <p role="alert" className="rounded-md border border-destructive/40 bg-destructive/5 px-3 py-2 text-sm text-destructive">{t('window.outside', { year: value.year })} {access.isGr && <Link href={`/admin/rewards/${unitId}`} className="font-medium underline">{t('window.fix')}</Link>}</p>}
        <PayWindowExcluded unitId={unitId} revision={value.revision} canEdit={editable} window={{ from: review.unit.policy.blockedFrom, to: review.unit.policy.blockedTo }} rows={review.rows} kept={review.unit.policy.payWindowKeep ?? {}} /></div>}
      {x === 'senior' && <div className="space-y-4">{senior && editable && <SeniorMembership key={senior.revision} value={senior} />}<UnitGovernance value={{ ...governance, canEdit: editable }} branch={value.branch} part="senior" /></div>}
      {x === 'budget' && <div className="space-y-3 [&_button]:h-auto [&_button]:min-h-9 [&_button]:max-w-full [&_button]:whitespace-normal">
        {!access.isGr && <p className="text-sm text-muted-foreground">{t('detail.patReadOnly')} <Link href="/admin/rewards/pat-inputs" className="text-primary hover:underline">{nav('rewardsPatInputs')}</Link></p>}
        {!access.isGr && value.budgetInputs && <dl className="grid gap-3 text-sm sm:grid-cols-2"><div><dt>{rt('governance.forecast')}</dt><dd>{money(value.budgetInputs.forecastCents)}</dd></div><div><dt>{rt('governance.actual')}</dt><dd>{money(value.budgetInputs.actualCents)}</dd></div><div><dt>{rt('governance.target')}</dt><dd>{money(value.budgetInputs.targetCents)}</dd></div><div><dt>{rt('governance.targetMonths')}</dt><dd>{(value.budgetInputs.targetMonthsBp / 10000).toLocaleString(locale)}</dd></div></dl>}
        <UnitGovernance value={{ ...governance, canEdit: editable }} branch={value.branch} part="budget" /></div>}
      {x === 'applied' && <div className="space-y-3"><dl className="divide-y divide-border text-sm">
        <div className="flex flex-wrap justify-between gap-3 py-3"><dt>{t('sharedConfiguration')}</dt><dd>{access.origin ? `${access.origin.name} · ${t('version', { number: access.origin.revision })}` : t('notSet')}</dd></div>
        {(['salary', 'bonus'] as const).map(kind => <div key={kind} className="flex flex-wrap justify-between gap-3 py-3"><dt>{t(kind === 'salary' ? 'salaryStructure' : 'bonusMatrix')}</dt><dd>{access.applied?.[kind] ? `${access.applied[kind].name} · ${t('version', { number: access.applied[kind].version })}` : t('notSet')}</dd></div>)}
      </dl><Link href={`/admin/rewards/${unitId}?mode=view#applied-setup`} className="text-sm text-primary hover:underline">{t('viewApplied')}</Link></div>}
      {access.required && editable && !done(x) && <div className="flex flex-wrap items-center gap-3 border-t border-border pt-4">
        <form action={preparationAction}>{fields(x)}<input type="hidden" name="kind" value="confirm" /><input type="hidden" name="step" value={x} /><RewardSubmit variant="secondary" disabled={!checks?.[x]}>{t('confirm')}</RewardSubmit></form>
        {!checks?.[x] && <p className="text-sm text-muted-foreground">{reasonFor(x)}</p>}
      </div>}
    </div>;
  };
  return <div className="w-full space-y-5">
    <div className="flex flex-wrap items-start justify-between gap-3">
      <PageHeader title={t('detail.title')} description={`${review.companyName} · ${review.name} · ${review.cycle?.name ?? ''}`} />
      <div className="flex flex-wrap gap-4 text-sm"><Link href={stepHref('history')} className="font-medium text-primary hover:underline">{t('changeLog')}</Link><Link href={`/rewards/${unitId}`} className="text-primary hover:underline">{t('detail.openReview')}</Link><Link href="/admin/rewards/review-setup" className="text-primary hover:underline">{t('detail.back')}</Link></div>
    </div>
    <ErrorBanner message={sp.error} />
    {!access.isGr && <p role="note" className="text-sm text-muted-foreground">{t('readOnly')}</p>}
    {!access.required && <p role="note" className="text-sm text-muted-foreground">{t('detail.beforeTrackingHelp')}</p>}
    <div className="grid items-start gap-5 lg:grid-cols-[18rem_minmax(0,1fr)]">
      <nav aria-label={t('checklist')}><ol className="space-y-1">
        {steps.map((x, index) => <li key={x}><Link href={stepHref(x)} aria-current={step === x ? 'step' : undefined} className={`flex items-start justify-between gap-2 rounded-md px-3 py-2 text-sm ${step === x ? 'bg-primary/10 font-semibold text-primary' : 'hover:bg-accent'}`}>
          <span>{index + 1}. {t(`steps.${x}`)}{preparation.steps[x] && access.required && <span className="block text-xs font-normal text-muted-foreground">{access.actorNames[preparation.steps[x]!.actorPersonId] ?? t('groupRewards')}</span>}</span>
          <span className={`shrink-0 rounded-full px-2 py-0.5 text-xs font-medium ${badge[state(x)]}`}>{t(state(x))}</span></Link></li>)}
      </ol></nav>
      <Card className="min-w-0 p-5">{step === 'history'
        ? <section id="preparation-history" className="space-y-3"><h2 className="text-lg font-semibold">{t('changeLog')}</h2>{!access.history.length && <p className="text-sm text-muted-foreground">{t('detail.noHistory')}</p>}<ol className="divide-y divide-border text-sm">{access.history.map(event => <li key={event.id} className="space-y-1 py-3"><p>{event.kind === 'preparation-invalidated' ? t('sourceChanged') : event.reason}</p><p className="text-muted-foreground">{event.actorName ?? t('system')} · {time(event.at)}</p></li>)}</ol></section>
        : panel(step)}</Card>
    </div>
    {access.required && <Card className="space-y-4 p-5">
      {editable ? <form action={preparationAction} className="flex flex-wrap items-end gap-3">{fields(step)}<input type="hidden" name="kind" value="expected" /><Field label={t('expected')}><input name="expectedRelease" type="date" required defaultValue={preparation.expectedRelease ?? ''} className={inputCls} /></Field><RewardSubmit variant="secondary">{t('saveExpected')}</RewardSubmit></form>
        : <p className="text-sm">{t('expected')}: {preparation.expectedRelease ?? t('notSet')}</p>}
      {!released && <ReleaseChecker fields={fields(step)} canEdit={canEdit} firstBlocker={firstBlocker} expectedRelease={preparation.expectedRelease} independentChecker={access.independentChecker} />}
      {released && <p role="status" className="text-sm">{t('released', { date: preparation.releasedAt?.slice(0, 10) ?? '' })}</p>}
      {value.canReopen && (released || value.needsReopen) && <form action={preparationAction} className="space-y-3">{fields(step)}<input type="hidden" name="kind" value="reopen" /><Field label={t('changeReason')}><textarea name="reason" required minLength={10} maxLength={2000} className={inputCls} /></Field><RewardSubmit variant="secondary">{t('requestChange')}</RewardSubmit></form>}
    </Card>}
  </div>;
}
