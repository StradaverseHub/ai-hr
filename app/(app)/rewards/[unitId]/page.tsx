import { BonusBudgetCards } from './bonus-budget';
import { RewardSubmit } from '../submit-button';
import Link from 'next/link';
import { getLocale, getTranslations } from 'next-intl/server';
import { scopedSession } from '@/lib/scope';
import { requireModule } from '@/lib/authz';
import { getRewardUnit, getRewardUnitGovernance, listRewardUnits, defaultPolicy, rewardPayrollChoices, rewardSetupChoices } from '@/packs/rewards/service';
// 179539d1: rows follow the talent order (SSTAR…PIP), not the policy's jsonb key order.
import { meritMatrixRows, performances } from '@/packs/rewards/model';
import { Card, ErrorBanner, Field, PageHeader, SectionHeader, inputCls, tableWrapCls, theadCls, thCls, tbodyCls } from '@/components/ui';
import { importOnehrAction, decideAction, importFactsAction, offcycleAction, postAction } from '../actions';
import { SourceRefresh } from './source-refresh';
import { todayInKualaLumpur } from '@/lib/hr-date';
import { redirect } from 'next/navigation';
import { ReturnedBanner, rewardDecisionTime } from '../returned-status';
import { RewardPostPanel } from '../post-panel';
import { rewardReviewTitle } from './unit-scope';
import { UnitLumpSum } from './lump-sum';
import { PayWindowExcluded, PayWindowTag } from './pay-window';
import { UnitMultiplier } from './unit-multiplier';
import { UnitGovernance } from './unit-governance';
import { isSeniorPlanMember } from '@/packs/rewards/model';

import {SummaryStrip} from './desk/summary-strip';
import {SalaryIncreaseTable} from './desk/salary-increase-table';
import {FlagsPanel} from './desk/flags-panel';
import {BonusPoolWorking} from './desk/bonus-pool-working';
import {changedRewardMatrixCells} from './desk/reference-matrix';
import {DecisionPanel} from './desk/decision-panel';
import {PersonDrawer} from './desk/person-drawer';
import {transition} from '@/packs/rewards/model';

const rm = (cents: number) => new Intl.NumberFormat('en-MY', { style: 'currency', currency: 'MYR' }).format(cents / 100);
export default async function RewardUnitPage({ params, searchParams }: { params: Promise<{ unitId: string }>; searchParams: Promise<{ view?: string; q?: string; error?: string; check?: string; person?: string }> }) {
  await requireModule('rewards'); const { s, scopeIds } = await scopedSession();
  const { unitId } = await params; const sp = await searchParams; const t = await getTranslations('rewards');
  if (sp.view === 'configuration') redirect(`/admin/rewards/${encodeURIComponent(unitId)}`);
  const v = await getRewardUnit(s, unitId); const { unit } = v;
  if(unit.kind==='annual'&&sp.view&&['review','budget','approvals','data','excluded','rules'].includes(sp.view)){
    const anchor=sp.check?'checks':({review:'people',budget:'salary-increase',approvals:'approvals',data:'data',excluded:'excluded',rules:'rules'} as Record<string,string>)[sp.view];
    const query=new URLSearchParams({... (sp.q?{q:sp.q}:{}),... (sp.check?{check:sp.check}:{}),... (sp.person?{person:sp.person}:{})}).toString();
    redirect(`/rewards/${encodeURIComponent(unitId)}${query?'?'+query:''}#${anchor}`);
  }
  const [choices,batches,list,governance]=await Promise.all([rewardSetupChoices(s,scopeIds),rewardPayrollChoices(s,unitId),unit.kind==='annual'?listRewardUnits(s,[unit.companyId]):Promise.resolve([]),getRewardUnitGovernance(s,unitId)]);
  const listMeta=list.find(row=>row.id===unitId);
  const tab = ['review', 'budget', 'approvals', 'data', 'excluded', 'rules'].includes(sp.view ?? '') ? sp.view! : 'review';
  const fields = <><input type="hidden" name="unitId" value={unitId} /><input type="hidden" name="revision" value={unit.revision} /></>;
  const rows = v.rows.filter(r => !sp.q || `${r.source.name} ${r.source.employeeCode}`.toLowerCase().includes(sp.q.toLowerCase()));
  const onehrText = await getTranslations('onehr');
  const editable = unit.status === 'draft' && v.canEdit;
  const annual = unit.kind === 'annual';
  const locale=await getLocale();
  const canSubmit = editable && v.roles.includes(v.route[0]);
  // c28db2f0: the lump-sum card links here with check=BUD-05 to list only the individual lump-sum amendments.
  const checks = sp.check ? v.flags.filter(f => f.code === sp.check && f.severity === 'exception') : v.flags;
  const scope = t('unitBonus.appliesOnlyTo', { company: v.companyName, unit: v.name });
  const canApprove = ['bg', 'gr', 'ctro', 'ec'].some(role => role === unit.status && v.roles.includes(role as 'bg' | 'gr' | 'ctro' | 'ec'));
  // 5d34d00d Step 2: per-person flags, the open person (side panel) and the stage each decision moves to.
  const rowFlags = (id: string) => v.flags.filter(f => f.entryId === id);
  const hidden = (r: typeof v.rows[number]) => isSeniorPlanMember(unit.policy, r.facts, r.source.grade) && !v.seniorAmountsVisible;
  const pct = (bp: number) => `${(bp / 100).toFixed(1)}%`;
  const personHref = (id: string) => { const q = new URLSearchParams({ ...(sp.q ? { q: sp.q } : {}), ...(sp.check ? { check: sp.check } : {}), person: id }); return `/rewards/${encodeURIComponent(unitId)}?${q}`; };
  const openIndex = sp.person ? rows.findIndex(r => r.id === sp.person) : -1; const open = openIndex >= 0 ? rows[openIndex] : null;
  const decisionTargets = annual ? (['submit', 'approve', 'return'] as const).filter(a => a === 'submit' ? canSubmit : a === 'approve' ? canApprove : canApprove || (unit.status === 'approved' && v.roles.some(r => ['gr', 'ctro', 'ec'].includes(r)))).flatMap(a => { try { return [{ action: a, to: t(`stages.${transition(unit.status, v.roles, a)}`) }]; } catch { return []; } }) : [];
  return <div className="w-full space-y-5">
    <Link href="/rewards" className="text-sm text-primary hover:underline">← {t('title')}</Link>
    <PageHeader title={rewardReviewTitle(v.cycle?.name ?? t('title'), v.companyName, v.name)} description={`${t(`kinds.${unit.kind}`)} · ${v.returned ? t(`returnedTo.${v.returned.toSeat}`) : t(`stages.${unit.status}`)}${v.due ? ` · ${t('dueOn', { date: v.due })}` : ''} · ${t('snapshotDate')}: ${unit.snapshotDate}`} />
    <ErrorBanner message={sp.error} />
    {v.returned && <ReturnedBanner returned={v.returned} />}
    {(v.roles.includes('gr') || choices.companies.some(c => c.id === unit.companyId)) && <Link href={`/admin/rewards/${unitId}`} className="inline-block text-sm font-medium text-primary hover:underline">{t('adminTitle')}</Link>}
    {!annual&&<nav aria-label={t('sections')} className="flex flex-wrap gap-1 border-b border-border pb-2">{['review', 'budget', 'approvals', ...(v.roles.includes('gr') ? ['data'] : []), ...(v.roles.includes('gr') && annual ? ['excluded'] : []), 'rules'].map(key => <Link key={key} href={`/rewards/${unitId}?view=${key}`} aria-current={tab === key ? 'page' : undefined} className={`rounded-md px-3 py-2 text-sm ${tab === key ? 'bg-primary/10 font-semibold text-primary' : 'text-muted-foreground hover:bg-accent'}`}>{t(key)}</Link>)}</nav>}
    {v.hiddenCount > 0 && <p className="max-w-3xl text-sm text-muted-foreground">{t('privacyNote')}</p>}
    {annual && v.hiddenCount > 0 && <p role="note" className="max-w-3xl rounded-md border border-border bg-muted/40 px-3 py-2 text-sm">{t('desk.hiddenRows', { count: v.hiddenCount })}</p>}
    {!annual && <Card className="space-y-3 p-5"><h2 className="font-semibold">{t('offcycleFunding')}</h2><p className="text-sm text-muted-foreground">{t('offcycleFundingHelp')}</p>{(['standard', 'h'] as const).map(plan => <p key={plan} className="text-sm tabular-nums">{t(plan)}: {rm(v.budgets[plan].used[0])} / {rm(v.budgets[plan].pools[0])}</p>)}{unit.offcycle?.exceptionReason && <p className="text-sm">{t('budgetException')}: {unit.offcycle.exceptionReason}</p>}<Link className="text-sm text-primary hover:underline" href={`/rewards/${unit.parentUnitId}`}>{t('annualSource')}</Link></Card>}
    {annual&&<UnitGovernance value={governance} branch={unit.policy.bonusStructure==='branch'}/>}
    {annual&&<SummaryStrip value={v} holders={listMeta?.holders??[]}/>}
    <div className={annual?'grid items-start gap-5 xl:grid-cols-[minmax(0,1fr)_20rem]':''}><div className="min-w-0 space-y-6">
    {annual && <>
      <section id="salary-increase" className="scroll-mt-6 space-y-4"><h2 className="text-lg font-semibold">{t('desk.salary')}</h2><SalaryIncreaseTable budgets={v.budgets}/><Card>
        {(['standard', 'h'] as const).some(plan => v.payWindow[plan]?.count) && <p className="border-t border-border px-4 py-3 text-sm">{(['standard', 'h'] as const).filter(plan => v.payWindow[plan]?.count).map(plan => <span key={plan} className="mr-4 inline-block">{t(plan)} · {t('payWindow.excludedFromBase', { count: v.payWindow[plan]!.count, amount: rm(v.payWindow[plan]!.payrollCents) })}</span>)}{v.roles.includes('gr') && <Link className="text-primary hover:underline" href={`/rewards/${unitId}?view=excluded`}>{t('payWindow.viewList')}</Link>}</p>}
        <details className="border-t border-border p-4"><summary className="cursor-pointer text-sm font-medium">{t('meritMatrix')} <span className="ml-2 rounded-full bg-muted px-2 py-1 text-xs">{t('desk.cellsAdjusted',{count:changedRewardMatrixCells(unit.policy.meritMatrix,defaultPolicy(unit.policy.year).meritMatrix)})}</span></summary><p className="my-3 text-sm text-muted-foreground">{t('matrixHelp')}</p><div className="overflow-x-auto"><table className="w-full text-sm"><thead><tr><th className={thCls}>{t('talent')}</th>{['below', 'within', 'above'].map(k => <th key={k} className={thCls}>{t(k)}</th>)}</tr></thead><tbody>{meritMatrixRows(unit.policy.meritMatrix).map(([talent, values]) => <tr key={talent}><th className={thCls}>{talent}</th>{values.map((n, i) => <td key={i} className="px-3 py-2 text-center">{n / 100}%</td>)}</tr>)}</tbody></table></div></details>
      </Card></section>
      <section id="bonus" className="scroll-mt-6 space-y-4"><h2 className="text-lg font-semibold">{t('desk.bonus')}</h2><BonusBudgetCards value={v} t={key=>t(key)} locale={locale} hideWorking/><BonusPoolWorking value={v}/>
      {/* 8296a4d9: the unit multiplier has its own titled card, styled like the Lump sum card. */}
      <Card><div className="space-y-3 p-4"><h3 className="font-medium">{t('bonusPresentation.unitMultiplier')}</h3><UnitMultiplier value={{ unitId, revision: unit.revision, unitName: v.name, scope, multiplierBp: unit.policy.multiplierBp, suggestedMultiplierBp: v.suggestedMultiplierBp, suggestion: v.suggestion && { patActualMissing: v.suggestion.patActualMissing, achievementBp: v.suggestion.achievementBp, targetMonthsBp: v.suggestion.targetMonthsBp, poolMultiplierBp: v.suggestion.poolMultiplierBp }, branch: unit.policy.bonusStructure === 'branch', canConfigure: v.canConfigure&&!governance.managed }} /></div></Card>
      <Card>
        <div className="space-y-3 border-t border-border p-4"><h3 className="font-medium">{t('lumpSum')}</h3><p className="max-w-3xl text-sm text-muted-foreground">{t('lumpHelp')}</p><p className="text-sm">{t('suggested')}: <strong className="tabular-nums">{rm(v.suggestedLumpCents)}</strong></p>
          <UnitLumpSum value={{ unitId, revision: unit.revision, unitName: v.name, scope, editable, suggestedLumpCents: v.suggestedLumpCents, lumpUnitCents: unit.policy.lumpUnitCents, reason: unit.policy.lumpReason ?? null, decision: v.lumpDecision }} />
          <details><summary className="cursor-pointer text-sm">{t('showWorking')}</summary><ul className="mt-2 space-y-1 text-sm">{v.lumpWorking.map(p => <li key={p.plan}>{t(p.plan)}: {rm(p.balanceCents)} / {p.count} → {rm(p.perPersonCents)}</li>)}</ul></details>
        </div><details className="border-t border-border p-4"><summary className="cursor-pointer text-sm font-medium">{t('bonusMatrix')} <span className="ml-2 rounded-full bg-muted px-2 py-1 text-xs">{t('desk.cellsAdjusted',{count:changedRewardMatrixCells(unit.policy.bonusMatrix,defaultPolicy(unit.policy.year).bonusMatrix)})}</span></summary><div className="mt-3 overflow-x-auto"><table className="w-full text-sm"><thead><tr><th className={thCls}>{t('grade')}</th>{performances.map(k => <th key={k} className={thCls}>{k}</th>)}</tr></thead><tbody>{Object.entries(unit.policy.bonusMatrix).map(([g, values]) => <tr key={g}><th className={thCls}>{g}</th>{values.map((n, i) => <td key={i} className="px-3 py-2 text-center">{n / 10000}</td>)}</tr>)}</tbody></table></div>
</details>
      </Card>
                {/* 8296a4d9: under branch factors (PPCH) each person's multiplier comes from these two tables. */}
          {unit.policy.bonusStructure === 'branch' && <div className="mt-4 space-y-4 overflow-x-auto"><table className="w-full text-sm"><caption className="pb-2 text-left font-medium">{t('branchGrid.factors')}</caption><thead><tr><th className={thCls}>{t('branchGrid.segment')}</th>{performances.map(k => <th key={k} className={thCls}>{k}</th>)}</tr></thead><tbody>{Object.entries(unit.policy.branchFactors).map(([segment, values]) => <tr key={segment}><th className={thCls}>{segment}</th>{values.map((n, i) => <td key={i} className="px-3 py-2 text-center tabular-nums">{(n / 10000).toFixed(2)}</td>)}</tr>)}</tbody></table>
            <table className="w-full text-sm"><caption className="pb-2 text-left font-medium">{t('branchGrid.ratings')}</caption><thead><tr><th className={thCls}>{t('branchGrid.branch')}</th><th className={thCls}>{t('branchGrid.rating')}</th></tr></thead><tbody>{Object.entries(unit.policy.branchRatings).map(([branch, rating]) => <tr key={branch}><th className={thCls}>{branch}</th><td className="px-3 py-2">{rating}</td></tr>)}</tbody></table>
            {!Object.keys(unit.policy.branchFactors).length && <p className="text-sm text-muted-foreground">{t('branchGrid.empty')}</p>}</div>}
      </section>
      {v.ec && v.roles.some(role=>['gr','ctro','ec'].includes(role)) && <Card id="ec-reports" className="scroll-mt-6"><SectionHeader title={t('desk.ec')} /><div className="flex flex-wrap gap-6 p-4 text-sm"><span>{t('referenceOnly')}: <b>{rm(v.ec.referenceCents)}</b></span><span>{t('increment')}: <b>{rm(v.ec.incrementCents)}</b></span><span>{t('bonus')}: <b>{rm(v.ec.bonusCents)}</b></span></div></Card>}
    </>}
    {(annual||tab === 'review') && <>
      <section id="people" className="scroll-mt-6 space-y-3"><h2 className="text-base font-semibold">{t('people')}</h2><form className="flex max-w-lg gap-2"><input name="q" defaultValue={sp.q} aria-label={t('search')} placeholder={t('search')} className={inputCls} /><RewardSubmit type="submit" variant="secondary">{t('search')}</RewardSubmit></form>
        <div className={tableWrapCls}><table className="w-full whitespace-nowrap text-sm"><thead className={theadCls}><tr>{['employee', 'grade', 'talent', 'performance', 'currentPay', ...(annual ? ['desk.increase'] : []), 'newPay', 'bonus', 'lumpSum', ...(annual ? ['desk.flags'] : []), 'action'].map(k => <th key={k} className={thCls}>{t(k)}</th>)}</tr></thead><tbody className={tbodyCls}>{rows.map(r => <tr key={r.id}><td className="px-3 py-3"><span className="mr-2 font-mono text-xs text-muted-foreground">{r.source.employeeCode}</span>{annual ? <Link scroll={false} href={personHref(r.id)} aria-current={open?.id === r.id ? 'true' : undefined} className="font-medium text-primary hover:underline">{r.source.name}</Link> : r.source.name}{!r.facts.reviewed && <span className="ml-2 text-xs text-destructive">{t('unverified')}</span>}{r.source.leftOn && <span className="ml-2 text-xs text-muted-foreground">{t('sourceRefresh.leftMarker', { date: r.source.leftOn })}</span>}{isSeniorPlanMember(unit.policy,r.facts,r.source.grade)&&<span className="ml-2 text-xs font-medium">{t('governance.seniorTag')}</span>}<PayWindowTag row={r} window={{ from: unit.policy.blockedFrom, to: unit.policy.blockedTo }} /></td><td className="px-3 py-3">{r.source.grade}{r.recommendation.promotionGrade && ` → ${r.recommendation.promotionGrade}`}</td><td className="px-3 py-3">{r.facts.talent ?? '—'}</td><td className="px-3 py-3">{r.facts.performance ?? '—'}</td><td className="px-3 py-3 text-right tabular-nums">{rm(r.source.basicCents)}</td>{annual && <td className="px-3 py-3 text-right tabular-nums">{hidden(r) ? '—' : pct(r.meritBp + r.promotionBp + r.specialBp)}</td>}<td className="px-3 py-3 text-right tabular-nums">{isSeniorPlanMember(unit.policy,r.facts,r.source.grade)&&!v.seniorAmountsVisible?t('governance.handledSeparately'):rm(r.newBasicCents)}</td><td className="px-3 py-3 text-right tabular-nums">{isSeniorPlanMember(unit.policy,r.facts,r.source.grade)&&!v.seniorAmountsVisible?t('governance.handledSeparately'):rm(r.bonusCents)}</td><td className="px-3 py-3 text-right tabular-nums">{rm(r.lumpCents)}</td>{annual && <td className="px-3 py-3"><FlagChips flags={rowFlags(r.id)} label={s => t(`severity.${s}`)} /></td>}<td className="px-3 py-3"><Link className="text-primary hover:underline" href={`/rewards/${unitId}/people/${r.id}`}>{t('reviewPerson')}</Link></td></tr>)}</tbody></table>{!rows.length && <p className="p-6 text-sm text-muted-foreground">{t('noPeople')}</p>}</div>
      </section>
      {!annual&&<section id="checks" className="space-y-3"><h2 className="font-semibold">{t('checks')} ({checks.length}){sp.check && <Link className="ml-3 text-sm font-normal text-primary hover:underline" href={`/rewards/${unitId}?view=review#checks`}>{t('showAllChecks')}</Link>}</h2>{!checks.length && <p className="text-sm text-muted-foreground">{t('noChecks')}</p>}<ul className="divide-y divide-border rounded-md border border-border">{checks.map((f, i) => <li key={i} className="flex flex-wrap items-start gap-3 px-4 py-3 text-sm"><span className={`min-w-20 font-semibold ${f.severity === 'block' ? 'text-destructive' : 'text-muted-foreground'}`}>{t(`severity.${f.severity}`)}</span><span className="min-w-0 flex-1">{f.message}{f.entryId && <Link className="ml-2 text-primary hover:underline" href={`/rewards/${unitId}/people/${f.entryId}`}>{t('reviewPerson')}</Link>}</span><span className="font-mono text-xs text-muted-foreground">{f.code}</span></li>)}</ul></section>}
    </>}
    {(annual||tab === 'approvals') && <div id="approvals" className="scroll-mt-6 space-y-6"><h2 className="text-lg font-semibold">{t('approvals')}</h2>
      <p className="text-sm">{v.route.map(role => t(`roles.${role}`)).join(' → ')}</p>
      {annual && decisionTargets.length > 0 && <DecisionPanel action={decideAction} unitId={unitId} revision={unit.revision} decisions={decisionTargets} from={t(`stages.${unit.status}`)} blocks={v.flags.filter(f => f.severity === 'block').length} warnings={v.flags.filter(f => f.severity === 'exception' || f.severity === 'warning').length} />}
      {!annual && (canSubmit || canApprove) && <form action={decideAction} className="max-w-3xl space-y-3">{fields}<Field label={t('decisionReason')}><textarea name="reason" rows={3} maxLength={4000} className={`${inputCls} h-auto py-2`} /></Field>{!annual && v.rows.some(e => e.recommendation.promotionGrade) && <label className="flex items-start gap-2 text-sm"><input type="checkbox" name="acknowledged" />{t('roleAcknowledgement')}</label>}<div className="flex flex-wrap gap-3">{editable ? <RewardSubmit name="action" value="submit" type="submit">{t('submit')}</RewardSubmit> : <><RewardSubmit name="action" value="approve" type="submit">{t('approve')}</RewardSubmit><RewardSubmit name="action" value="return" type="submit" variant="secondary">{t('return')}</RewardSubmit>{!annual && <RewardSubmit name="action" value="reject" type="submit" variant="secondary">{t('reject')}</RewardSubmit>}</>}</div></form>}
      {!annual && unit.status === 'approved' && v.roles.some(r => ['gr', 'ctro', 'ec'].includes(r)) && <form action={decideAction} className="max-w-3xl space-y-3">{fields}<Field label={t('decisionReason')}><textarea required minLength={10} name="reason" rows={3} className={`${inputCls} h-auto py-2`} /></Field><RewardSubmit name="action" value="return" type="submit" variant="secondary">{t('return')}</RewardSubmit></form>}
      {/* H1: Post appears only when postRewardUnit's own predicate (v.posting) says it would succeed. */}
      {unit.status === 'approved' && <RewardPostPanel posting={v.posting} batches={batches} fields={fields} action={postAction} />}
      {!annual && unit.status === 'draft' && (canSubmit || v.roles.includes('gr')) && <form action={decideAction} className="max-w-3xl space-y-3">{fields}<Field label={t('decisionReason')}><input required minLength={10} name="reason" className={inputCls} /></Field><RewardSubmit name="action" value="withdraw" type="submit" variant="secondary">{t('withdraw')}</RewardSubmit></form>}
      <section><h2 className="mb-3 font-semibold">{t('history')}</h2><ol className="divide-y divide-border">{v.decisions.map(d => <li key={d.id} className="space-y-1 py-3 text-sm"><p className="font-medium">{t(`stages.${d.fromStage}`)} → {t(`stages.${d.toStage}`)}</p><p className="text-muted-foreground">{t('decidedBy', { actor: d.actorName ?? (d.actorRole ? t(`roles.${d.actorRole}`) : t('aReviewer')) })} · {rewardDecisionTime(d.createdAt)}</p>{d.reason && <p className="max-w-3xl whitespace-pre-wrap">{d.reason}</p>}</li>)}</ol></section>
    </div>}
    {annual && unit.status === 'posted' && v.roles.some(r => ['bu', 'bg', 'gr'].includes(r)) && <section className="max-w-3xl space-y-4"><h2 className="font-semibold">{t('startOffcycle')}</h2><form action={offcycleAction} className="space-y-4">{fields}<div className="grid gap-4 sm:grid-cols-2"><Field label={t('type')}><select name="kind" className={inputCls}><option value="adhoc">{t('kinds.adhoc')}</option><option value="midyear">{t('kinds.midyear')}</option></select></Field><Field label={t('effectiveFrom')}><input type="date" name="effectiveFrom" required className={inputCls} /></Field></div><fieldset className="max-h-72 space-y-2 overflow-y-auto rounded-md border border-border p-3"><legend>{t('people')}</legend>{v.rows.map(e => <label key={e.id} className="flex gap-2 text-sm"><input type="checkbox" name="entryIds" value={e.id} />{e.source.employeeCode} · {e.source.name}</label>)}</fieldset><Field label={t('budgetException')}><textarea name="exceptionReason" rows={3} maxLength={4000} className={`${inputCls} h-auto py-2`} /></Field><p className="text-sm text-muted-foreground">{t('exceptionHelp')}</p><RewardSubmit type="submit">{t('startOffcycle')}</RewardSubmit></form></section>}
    {(annual||tab === 'data') && v.roles.includes('gr') && <section id="data" className="max-w-3xl space-y-5"><h2 className="font-semibold">{t('data')}</h2><p className="text-sm text-muted-foreground">{t('dataHelp')}</p><Link href={`/rewards/${unitId}/export?template=1`} className="inline-block text-sm font-medium text-primary hover:underline">{t('downloadTemplate')}</Link>{unit.status === 'draft' && annual && <><form action={importOnehrAction} className="space-y-3">{fields}<p className="text-sm text-muted-foreground">{onehrText('rewardImportHelp')}</p><RewardSubmit type="submit" variant="secondary">{onehrText('rewardImport')}</RewardSubmit></form><form action={importFactsAction} className="space-y-3">{fields}<Field label={t('completedTemplate')}><input type="file" name="file" accept=".csv" required className="text-sm" /></Field><RewardSubmit type="submit">{t('import')}</RewardSubmit></form><SourceRefresh unitId={unitId} revision={unit.revision} snapshotDate={unit.snapshotDate} today={todayInKualaLumpur()} /></>}<Link className="inline-block text-sm text-primary hover:underline" href={`/rewards/${unitId}/export`}>{t('export')}</Link></section>}
    {annual && v.roles.includes('gr') && <section id="excluded" className="scroll-mt-6"><PayWindowExcluded unitId={unitId} revision={unit.revision} canEdit={v.canConfigure} window={{ from: unit.policy.blockedFrom, to: unit.policy.blockedTo }} rows={v.rows} kept={unit.policy.payWindowKeep ?? {}} /></section>}
    {(annual||tab === 'rules') && <section id="rules" className="max-w-3xl space-y-4"><h2 className="font-semibold">{t('rules')}</h2>{['rulePools', 'ruleBonus', 'ruleEC', 'ruleExemption', 'ruleLump', 'rulePrivacy', 'ruleApproval', 'rulePosting'].map(k => <p key={k} className="text-sm leading-6">{t(k)}</p>)}</section>}
    </div>{annual&&<FlagsPanel unitId={unitId} flags={checks} filtered={!!sp.check}/>}</div>
    {open && <PersonDrawer title={open.source.name} description={`${open.source.employeeCode} · ${t('grade')} ${open.source.grade} · ${t(open.plan === 'ec' ? 'ecPlan' : open.plan)}`} prevId={rows[openIndex - 1]?.id ?? null} nextId={rows[openIndex + 1]?.id ?? null} position={{ index: openIndex + 1, total: rows.length }} editHref={`/rewards/${unitId}/people/${open.id}`}>
      <PersonCalculation row={open} hidden={hidden(open)} flags={rowFlags(open.id)} t={t} rm={rm} pct={pct} />
    </PersonDrawer>}
  </div>;
}

type Row = Awaited<ReturnType<typeof getRewardUnit>>['rows'][number];
type Flag = Awaited<ReturnType<typeof getRewardUnit>>['flags'][number];
const chipCls: Record<Flag['severity'], string> = { block: 'bg-destructive/10 text-destructive', exception: 'bg-amber-100 text-amber-900 dark:bg-amber-500/15 dark:text-amber-200', warning: 'bg-amber-100 text-amber-900 dark:bg-amber-500/15 dark:text-amber-200', review: 'bg-muted text-muted-foreground' };
/** 5d34d00d Step 2 — one chip per severity on the person's row: "Block 1", "Warning 2". */
function FlagChips({ flags, label }: { flags: Flag[]; label: (s: Flag['severity']) => string }) {
  if (!flags.length) return <span className="text-muted-foreground">—</span>;
  return <span className="flex flex-wrap gap-1">{(['block', 'exception', 'warning', 'review'] as const).map(sev => { const n = flags.filter(f => f.severity === sev).length; return n ? <span key={sev} className={`rounded-full px-2 py-0.5 text-xs font-medium ${chipCls[sev]}`}>{label(sev)} {n}</span> : null; })}</span>;
}
/** 5d34d00d Step 2 — the full calculation for one person, read only. Every figure comes from the server's
 *  calculated row (getRewardUnit); nothing is worked out here. Editing stays on the person record. */
function PersonCalculation({ row: r, hidden, flags, t, rm, pct }: { row: Row; hidden: boolean; flags: Flag[]; t: (key: string) => string; rm: (cents: number) => string; pct: (bp: number) => string }) {
  const money = (cents: number) => hidden ? t('governance.handledSeparately') : rm(cents);
  const line = (label: string, value: string, strong = false) => <div key={label} className="flex items-baseline justify-between gap-4 py-1.5"><dt className="text-muted-foreground">{label}</dt><dd className={`text-right tabular-nums ${strong ? 'font-semibold' : 'font-medium'}`}>{value}</dd></div>;
  return <div className="space-y-5 text-sm">
    <dl className="divide-y divide-border">{line(t('talent'), r.facts.talent ?? '—')}{line(t('performance'), r.facts.performance ?? '—')}</dl>
    <section><h3 className="mb-1 font-semibold">{t('desk.salary')}</h3><dl className="divide-y divide-border">
      {line(t('currentPay'), rm(r.source.basicCents))}
      {line(`${t('merit')} ${hidden ? '' : pct(r.meritBp)}`, money(r.meritCents))}
      {line(`${t('promotion')} ${hidden ? '' : pct(r.promotionBp)}${r.recommendation.promotionGrade ? ` → ${r.recommendation.promotionGrade}` : ''}`, money(r.promotionCents))}
      {line(`${t('special')} ${hidden ? '' : pct(r.specialBp)}`, money(r.specialCents))}
      {line(t('newPay'), money(r.newBasicCents), true)}
      {line(t('incrementEligibility'), r.incrementReason || t('eligible'))}
    </dl></section>
    <section><h3 className="mb-1 font-semibold">{t('desk.bonus')}</h3><dl className="divide-y divide-border">
      {r.bonusBasicCents !== r.source.basicCents && line(t('payWindow.bonusBasic'), rm(r.bonusBasicCents))}
      {line(t('bonusMultiplier'), hidden ? t('governance.handledSeparately') : (r.bonusMultiplierBp / 10000).toFixed(2))}
      {line(t('bonus'), money(r.bonusCents), true)}
      {line(t('lumpSum'), rm(r.lumpCents))}
      {line(t('bonusEligibility'), r.bonusReason || t('eligible'))}
    </dl></section>
    <section><h3 className="mb-1 font-semibold">{t('desk.flags')}</h3>{flags.length ? <ul className="space-y-2">{flags.map((f, i) => <li key={i} className="flex gap-2"><span className={`h-fit shrink-0 rounded-full px-2 py-0.5 text-xs font-medium ${chipCls[f.severity]}`}>{t(`severity.${f.severity}`)}</span><span>{f.message}</span></li>)}</ul> : <p className="text-muted-foreground">{t('desk.person.noFlags')}</p>}</section>
  </div>;
}
