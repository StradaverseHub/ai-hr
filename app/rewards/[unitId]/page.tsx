import type { ReactNode } from 'react';
import { ExportDownloadLink } from '@/components/export-download-link';
import { RewardSubmit } from '../submit-button';
import { ScopedCommandIndex } from '@/components/scoped-command-index';
import Link from 'next/link';
import { getTranslations } from 'next-intl/server';
import { scopedSession } from '@/lib/scope';
import { requireModule } from '@/lib/authz';
import { getRewardUnit, getRewardPreparationStatus, rewardPayrollChoices, rewardSetupChoices } from '@/packs/rewards/service';
import { Card, ErrorBanner, Field, PageHeader, inputCls, tableWrapCls, theadCls, thCls, tbodyCls } from '@/components/ui';
import { importOnehrAction, decideAction, importFactsAction, offcycleAction, postAction } from '../actions';
import { SourceRefresh } from './source-refresh';
import { todayInKualaLumpur } from '@/lib/hr-date';
import { redirect } from 'next/navigation';
import { ReturnedBanner, rewardDecisionTime } from '../returned-status';
import { RewardPostPanel } from '../post-panel';
import { rewardReviewHeaderTitle, rewardReviewTitle } from './unit-scope';
import { UnitLumpSum } from './lump-sum';
import { PayWindowTag } from './pay-window';
import { isSeniorPlanMember, performances, REWARD_NOTE_MAX, talents, transition } from '@/packs/rewards/model';
import { formatMoney } from '@/lib/money';
import { rewardDaysUntil } from '@/packs/rewards/calendar';
import { PersonDrawer } from './desk/person-drawer';
import { ReviewDeskProvider } from './desk/review-desk';
import { DecisionActions, FlagsButton, SaveStatus, StaleBanner } from './desk/header-actions';
import { SummaryTiles } from './desk/summary-tiles';
import { PeopleGrid } from './desk/people-grid';
import { FlagsDrawer } from './desk/flags-drawer';
import { OpenDetailsOnHash, PersonNote } from './desk/person-note';
import { BudgetDetails, ReferenceDetails } from './desk/review-details';
import { deskCellsEditable, deskRow, deskSummary, deskTotals, filterDeskRows, parseDeskFilters, DESK_FILTER_KEYS, type RewardView } from './desk/desk-model';
import { flagText } from './desk/flag-text';

const rm = (cents: number) => formatMoney(cents === 0 ? 0 : cents / 100, 'MYR');
/** 37f82412 — large reviews show 50 people per page; search and filters still look across the whole review. */
const PAGE_SIZE = 50;
type Search = { view?: string; q?: string; error?: string; check?: string; flag?: string; person?: string; page?: string; f?: string; talent?: string; perf?: string; jg?: string; plan?: string };

export default async function RewardUnitPage({ params, searchParams }: { params: Promise<{ unitId: string }>; searchParams: Promise<Search> }) {
  await requireModule('rewards'); const { s, scopeIds } = await scopedSession();
  const { unitId } = await params; const sp = await searchParams; const t = await getTranslations('rewards');
  if (sp.view === 'configuration') redirect(`/admin/rewards/${encodeURIComponent(unitId)}`);
  const preparation = await getRewardPreparationStatus(s, unitId);
  const prepText = await getTranslations('rewardsPreparation');
  if (!preparation.released && !preparation.setupVisible && !(preparation.uploaded && preparation.canInspect)) return <div className="space-y-4"><PageHeader title={prepText('review')} /><p role="status">{prepText('preparing')}</p><p className="text-sm text-muted-foreground">{preparation.expectedRelease ? prepText('expectedOn', { date: preparation.expectedRelease }) : prepText('datePending')}</p><Link href="/rewards" className="text-primary hover:underline">{prepText('back')}</Link></div>;
  const v = await getRewardUnit(s, unitId); const { unit } = v;
  if (unit.kind === 'annual' && sp.view === 'rules') redirect(`/rewards/rules?unit=${encodeURIComponent(unitId)}`);
  // 70d5e7c5: set-up now lives in Configuration › Review Set-up; old links open the matching step there.
  if (unit.kind === 'annual' && sp.view && ['data', 'excluded'].includes(sp.view)) redirect(`/admin/rewards/review-setup/${encodeURIComponent(unitId)}?step=${sp.view}`);
  if (unit.kind === 'annual' && sp.view && ['review', 'budget', 'approvals'].includes(sp.view)) {
    const anchor = sp.check ? 'checks' : ({ review: 'people', budget: 'salary-increase', approvals: 'approvals' } as Record<string, string>)[sp.view];
    const query = new URLSearchParams({ ...(sp.q ? { q: sp.q } : {}), ...(sp.check ? { check: sp.check } : {}), ...(sp.person ? { person: sp.person } : {}) }).toString();
    redirect(`/rewards/${encodeURIComponent(unitId)}${query ? '?' + query : ''}#${anchor}`);
  }
  if (unit.kind !== 'annual') return <OffcycleReview v={v} sp={sp} scopeIds={scopeIds} s={s} />;
  const batches = await rewardPayrollChoices(s, unitId);
  const u = await getTranslations('rewardUploaded'), a = await getTranslations('rewardAdvisor'), d = await getTranslations('rewards.desk');
  const fields = <><input type="hidden" name="unitId" value={unitId} /><input type="hidden" name="revision" value={unit.revision} /></>;
  const fullView = !!v.fullView;
  const canSubmit = unit.status === 'draft' && v.capabilities?.reviewDecide !== false && v.roles.includes(v.route[0]);
  const canApprove = v.capabilities?.reviewDecide !== false && ['bg', 'gr', 'ctro', 'ec'].some(role => role === unit.status && v.roles.includes(role as 'bg' | 'gr' | 'ctro' | 'ec'));
  const decisionTargets = (['submit', 'approve', 'return'] as const).filter(x => x === 'submit' ? canSubmit : x === 'approve' ? canApprove : canApprove || (unit.status === 'approved' && v.roles.some(r => ['gr', 'ctro', 'ec'].includes(r)))).flatMap(x => { try { return [{ action: x, to: t(`stages.${transition(unit.status, v.roles, x)}`) }]; } catch { return []; } });

  // People: filters and search run here over every visible person; the table shows one page of the result.
  const filters = parseDeskFilters(sp);
  const flagCode = sp.check ?? sp.flag;
  const flagged = flagCode ? new Set(v.flags.filter(f => f.code === flagCode && (!sp.check || f.severity === 'exception')).map(f => f.entryId)) : null;
  const filtered = filterDeskRows(v.rows, v.flags, filters).filter(r => !flagged || flagged.has(r.id));
  const rows = filtered.map(r => deskRow(v, r, v.flags));
  const pageCount = Math.max(1, Math.ceil(rows.length / PAGE_SIZE));
  const page = Math.min(Math.max(0, Math.trunc(Number(sp.page) || 0)), pageCount - 1);
  const pageRows = rows.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE);
  const keep = Object.fromEntries([...DESK_FILTER_KEYS.filter(k => filters[k]).map(k => [k, String(filters[k])]), ...(sp.check ? [['check', sp.check]] : []), ...(sp.flag ? [['flag', sp.flag]] : [])]) as Record<string, string>;
  const href = (over: Record<string, string | null>) => { const q = new URLSearchParams(keep); if (page) q.set('page', String(page)); for (const [k, value] of Object.entries(over)) { if (value == null) q.delete(k); else q.set(k, value); } const text = q.toString(); return `/rewards/${encodeURIComponent(unitId)}${text ? `?${text}` : ''}`; };
  const personHref = (id: string) => href({ person: id });
  const openIndex = sp.person ? filtered.findIndex(r => r.id === sp.person) : -1; const open = openIndex >= 0 ? filtered[openIndex] : null;
  const flagPersonLinks = Object.fromEntries(v.flags.filter(f => f.entryId).map(f => [f.entryId!, filtered.some(r => r.id === f.entryId) ? personHref(f.entryId!) : `/rewards/${encodeURIComponent(unitId)}?person=${encodeURIComponent(f.entryId!)}`]));
  const nominations = v.rows.filter(row => row.recommendation.promotionGrade && !(isSeniorPlanMember(unit.policy, row.facts, row.source.grade) && !v.seniorAmountsVisible));
  const editable = unit.status === 'draft' && v.canEdit;
  const cellsEditable = deskCellsEditable(v);
  const scope = t('unitBonus.appliesOnlyTo', { company: v.companyName, unit: v.name });
  const setupHref = preparation.setupVisible ? `/admin/rewards/review-setup/${encodeURIComponent(unitId)}` : null;
  const grades = [...new Set(v.rows.map(r => r.source.grade))].sort((x, y) => Number(x) - Number(y) || x.localeCompare(y));
  const pill = (label: string, over: Record<string, string | null>, active: boolean) => <Link key={label} scroll={false} href={href({ ...over, page: null, person: null })} aria-current={active ? 'true' : undefined} className={`rounded-full border px-3 py-1 text-[13px] ${active ? 'border-primary bg-primary/10 font-medium text-primary' : 'border-border hover:bg-accent'}`}>{label}</Link>;
  const anyFilter = !!(filters.f || filters.talent || filters.perf || filters.jg || filters.plan);
  const dueDays = v.due ? rewardDaysUntil(v.due, todayInKualaLumpur()) : null;
  const badge = v.returned ? 'returned' : unit.status === 'draft' ? 'draft' : 'submitted';

  return <ReviewDeskProvider key={`${unit.revision}:${page}:${JSON.stringify(keep)}`} unitId={unitId} revision={unit.revision} summary={deskSummary(v)} totals={deskTotals(rows)} flags={v.flags} rows={pageRows} filters={keep}>
  <div className="w-full space-y-5">
    <ScopedCommandIndex entries={v.rows.map(row => ({ href: `/rewards/${unitId}?person=${row.id}`, label: row.source.name, context: row.source.employeeCode ?? '' }))} />
    <OpenDetailsOnHash />
    {/* 37f82412 — compact header: title, status, due date, Flags, Approval history; the main action on the right. */}
    <header className="flex flex-wrap items-start justify-between gap-3 border-b border-border pb-3">
      <div className="min-w-0 space-y-2">
        <h1 className="text-xl font-semibold leading-tight">{rewardReviewHeaderTitle(v.companyName, v.name, v.cycle?.name ?? t('title'))}</h1>
        <div className="flex flex-wrap items-center gap-x-3 gap-y-2 text-sm">
          <span className={`rounded-full px-2 py-0.5 text-xs font-semibold ${badge === 'returned' ? 'bg-amber-100 text-amber-950 dark:bg-amber-950 dark:text-amber-100' : badge === 'draft' ? 'bg-muted text-foreground' : 'bg-primary/10 text-primary'}`}>{fullView && badge === 'submitted' ? t(`stages.${unit.status}`) : d(`status.${badge}`)}</span>
          {v.due && <span className={dueDays !== null && dueDays < 0 ? 'font-medium text-destructive' : 'text-muted-foreground'}>{t('dueOn', { date: v.due })}{dueDays !== null && dueDays < 0 ? ` · ${d('overdue')}` : ''}</span>}
          <FlagsButton />
          <a href="#approvals" className="text-primary hover:underline">{d('approvalHistory')}</a>
          {setupHref && preparation.isGr && <Link href={setupHref} className="text-primary hover:underline">{d('openSetup')}</Link>}
          <SaveStatus />
        </div>
      </div>
      {!v.uploaded && <DecisionActions action={decideAction} decisions={decisionTargets} from={t(`stages.${unit.status}`)} />}
    </header>
    <ErrorBanner message={sp.error} />
    <StaleBanner />
    {v.uploadedSummary && <Card className="p-5"><h2 className="font-semibold">{u('summary', { people: v.uploadedSummary.people, increment: (v.uploadedSummary.incrementCents / 100).toFixed(2), bonus: (v.uploadedSummary.bonusCents / 100).toFixed(2) })}</h2><p className="mt-1 text-sm tabular-nums">{u('lump')}: {(v.uploadedSummary.lumpCents / 100).toFixed(2)}</p></Card>}
    {v.returned && <ReturnedBanner returned={v.returned} />}
    {fullView && preparation.preparation?.releasedAt && <p className="text-sm text-muted-foreground">{prepText('setupChanged', { date: preparation.preparation.releasedAt.slice(0, 10) })} {setupHref && <Link href={`${setupHref}?step=history`} className="text-primary hover:underline">{prepText('changeLog')}</Link>}</p>}
    {!v.uploaded && <SummaryTiles lumpEditor={editable ? <UnitLumpSum value={{ unitId, revision: unit.revision, unitName: v.name, scope, editable, suggestedLumpCents: v.suggestedLumpCents, lumpUnitCents: unit.policy.lumpUnitCents, reason: unit.policy.lumpReason ?? null, decision: v.lumpDecision }} /> : null} />}

    <section id="people" className="scroll-mt-6 space-y-3">
      <h2 className="text-base font-semibold">{t('people')}</h2>
      {v.hiddenCount > 0 && <p role="note" className="rounded-md border border-border bg-muted/40 px-3 py-2 text-sm">{t('desk.hiddenRows', { count: v.hiddenCount })}</p>}
      <form className="flex max-w-lg gap-2">{Object.entries(keep).filter(([k]) => k !== 'q').map(([k, value]) => <input key={k} type="hidden" name={k} value={value} />)}<input name="q" defaultValue={filters.q} aria-label={t('search')} placeholder={t('search')} className={inputCls} /><RewardSubmit type="submit" variant="secondary">{t('search')}</RewardSubmit></form>
      <nav aria-label={d('filters.label')} className="flex flex-wrap items-center gap-2">
        {pill(d('filters.all'), { f: null, talent: null, perf: null, jg: null, plan: null, check: null, flag: null }, !anyFilter && !flagCode)}
        {pill(d('filters.flags'), { f: filters.f === 'flags' ? null : 'flags' }, filters.f === 'flags')}
        {pill(t('promotion'), { f: filters.f === 'promotion' ? null : 'promotion' }, filters.f === 'promotion')}
        {talents.map(x => pill(`${d('filters.talent')}: ${x}`, { talent: filters.talent === x ? null : x }, filters.talent === x))}
        {performances.map(x => pill(`${d('filters.performance')}: ${x}`, { perf: filters.perf === x ? null : x }, filters.perf === x))}
        {grades.map(x => pill(`${d('grid.jg')} ${x}`, { jg: filters.jg === x ? null : x }, filters.jg === x))}
        {(['standard', 'h'] as const).map(x => pill(t(x), { plan: filters.plan === x ? null : x }, filters.plan === x))}
      </nav>
      {flagCode && <p className="text-sm">{d('filters.flagCode', { code: flagCode })} <Link href={href({ check: null, flag: null, page: null })} className="text-primary hover:underline">{t('showAllChecks')}</Link></p>}
      <PeopleGrid order={pageRows.map(r => r.id)} personHrefs={Object.fromEntries(pageRows.map(r => [r.id, personHref(r.id)]))} openId={open?.id ?? null} emptyText={t('noPeople')} fullView={fullView} />
      {pageCount > 1 && <nav aria-label={d('grid.pages')} className="flex flex-wrap items-center gap-3 text-sm">
        {page > 0 ? <Link href={href({ page: page - 1 ? String(page - 1) : null, person: null })} className="text-primary hover:underline">← {d('person.previous')}</Link> : <span className="text-muted-foreground">← {d('person.previous')}</span>}
        <span className="tabular-nums">{d('grid.pageOf', { page: page + 1, pages: pageCount, total: rows.length })}</span>
        {page < pageCount - 1 ? <Link href={href({ page: String(page + 1), person: null })} className="text-primary hover:underline">{d('person.next')} →</Link> : <span className="text-muted-foreground">{d('person.next')} →</span>}
      </nav>}
    </section>
    {nominations.length > 0 && <section id="promotions" className="scroll-mt-6 space-y-3">
      <h2 className="text-base font-semibold">{t('promotion')}</h2>
      <Card className="divide-y divide-border">
        {nominations.map(row => <article className="space-y-1 p-4 text-sm" key={row.id}>
          <Link scroll={false} href={personHref(row.id)} className="font-medium text-primary hover:underline">{row.source.name}</Link>
          <p className="text-muted-foreground">{t('grade')}: {row.source.grade} → {row.recommendation.promotionGrade}</p>
          {row.recommendation.reason && <p className="whitespace-pre-wrap">{row.recommendation.reason}</p>}
        </article>)}
      </Card>
    </section>}
    {!v.uploaded && <><BudgetDetails value={v} setupHref={setupHref && preparation.isGr ? `${setupHref}?step=excluded` : null} /><ReferenceDetails value={v} /></>}

    <div id="approvals" className="scroll-mt-6 space-y-6"><h2 className="text-lg font-semibold">{t('approvals')}</h2>
      {fullView && <p className="text-sm">{v.route.map(role => t(`roles.${role}`)).join(' → ')}</p>}
      {/* H1: Post appears only when postRewardUnit's own predicate (v.posting) says it would succeed. */}
      {unit.status === 'approved' && <RewardPostPanel posting={v.posting} batches={batches} fields={fields} action={postAction} />}
      <section><h2 className="mb-3 font-semibold">{t('history')}</h2><ol className="divide-y divide-border">{v.decisions.map(dec => <li key={dec.id} className="space-y-1 py-3 text-sm"><p className="font-medium">{t(`stages.${dec.fromStage}`)} → {t(`stages.${dec.toStage}`)}</p><p className="text-muted-foreground">{t('decidedBy', { actor: dec.actorName ?? (dec.actorRole ? t(`roles.${dec.actorRole}`) : t('aReviewer')) })} · {rewardDecisionTime(dec.createdAt)}</p>{dec.reason && <p className="max-w-3xl whitespace-pre-wrap">{dec.reason}</p>}</li>)}</ol></section>
    </div>
    {unit.status === 'posted' && v.roles.some(r => ['bu', 'bg', 'gr'].includes(r)) && <section className="max-w-3xl space-y-4"><h2 className="font-semibold">{t('startOffcycle')}</h2><form action={offcycleAction} className="space-y-4">{fields}<div className="grid gap-4 sm:grid-cols-2"><Field label={t('type')}><select name="kind" className={inputCls}><option value="adhoc">{t('kinds.adhoc')}</option><option value="midyear">{t('kinds.midyear')}</option></select></Field><Field label={t('effectiveFrom')}><input type="date" name="effectiveFrom" required className={inputCls} /></Field></div><fieldset className="max-h-72 space-y-2 overflow-y-auto rounded-md border border-border p-3"><legend>{t('people')}</legend>{v.rows.map(e => <label key={e.id} className="flex gap-2 text-sm"><input type="checkbox" name="entryIds" value={e.id} />{e.source.employeeCode} · {e.source.name}</label>)}</fieldset><Field label={t('budgetException')}><textarea name="exceptionReason" rows={3} maxLength={4000} className={`${inputCls} h-auto py-2`} /></Field><p className="text-sm text-muted-foreground">{t('exceptionHelp')}</p><RewardSubmit type="submit">{t('startOffcycle')}</RewardSubmit></form></section>}
    <FlagsDrawer personLinks={flagPersonLinks} sectionHrefs={{ 'salary-increase': '#salary-increase', bonus: '#bonus', people: '#people' }} />
    {open && <PersonDrawer title={open.source.name} description={`${open.source.employeeCode} · ${t('grade')} ${open.source.grade} · ${t(open.plan === 'ec' ? 'ecPlan' : open.plan)}`} prevId={filtered[openIndex - 1]?.id ?? null} nextId={filtered[openIndex + 1]?.id ?? null} position={{ index: openIndex + 1, total: filtered.length }} editHref={`/rewards/${unitId}/people/${open.id}`}>
      <PersonCalculation row={open} hidden={isSeniorPlanMember(unit.policy, open.facts, open.source.grade) && !v.seniorAmountsVisible} flags={v.flags.filter(f => f.entryId === open.id)} t={t} rm={rm} pct={pct} fullView={fullView}
        note={<PersonNote entryId={open.id} note={open.recommendation.note ?? ''} editable={cellsEditable && !(isSeniorPlanMember(unit.policy, open.facts, open.source.grade) && !v.seniorAmountsVisible)} max={REWARD_NOTE_MAX} />} />
    </PersonDrawer>}
    {(fullView || v.uploaded) && <section className="rounded-lg border border-border p-3">
      <h2 className="text-sm font-medium">{t('sections')}</h2>
      <div className="mt-2 flex flex-wrap gap-x-4 gap-y-2 text-sm">
        {fullView && <Link href={`/rewards/rules?unit=${unitId}`} className="text-primary underline">{t('rules')}</Link>}
        {v.uploaded ? <Link href={`/rewards/${unitId}/uploaded`} className="text-primary underline">{u('open')}</Link>
          : v.libraryBound && <Link href={`/rewards/${unitId}/advisor`} className="text-primary underline">{a('title')}</Link>}
      </div>
    </section>}
  </div>
  </ReviewDeskProvider>;
}

const pct = (bp: number) => `${(bp / 100).toFixed(1)}%`;
type Row = RewardView['rows'][number];
type Flag = RewardView['flags'][number];
const chipCls: Record<Flag['severity'], string> = { block: 'bg-destructive/10 text-destructive', exception: 'bg-amber-100 text-amber-900 dark:bg-amber-500/15 dark:text-amber-200', warning: 'bg-amber-100 text-amber-900 dark:bg-amber-500/15 dark:text-amber-200', review: 'bg-muted text-muted-foreground' };
const flagWords = (flag: Flag, t: (key: string, values?: Record<string, string>) => string) => {
  if (flag.code === 'ARCH-01') return t('architectureMismatch');
  const text = flagText(flag);
  return text ? t(`flagText.${text.key}`, { plan: text.plan ? t(text.plan) : '', part: text.part ? t(`flagText.parts.${text.part}`) : '' }) : flag.message;
};
/** 5d34d00d Step 2 / 37f82412 — the full calculation for one person, with eligibility, pay position before
 *  and after, the promotion business case and notes. Every figure comes from the server's calculated row. */
function PersonCalculation({ row: r, hidden, flags, t, rm, pct, fullView, note }: { row: Row; hidden: boolean; flags: Flag[]; t: (key: string, values?: Record<string, string>) => string; rm: (cents: number) => string; pct: (bp: number) => string; fullView: boolean; note: ReactNode }) {
  const money = (cents: number) => hidden ? (fullView ? t('governance.handledSeparately') : '—') : rm(cents);
  const line = (label: string, value: string, strong = false) => <div key={label} className="flex items-baseline justify-between gap-4 py-1.5"><dt className="text-muted-foreground">{label}</dt><dd className={`text-right tabular-nums ${strong ? 'font-semibold' : 'font-medium'}`}>{value}</dd></div>;
  return <div className="space-y-5 text-sm">
    <dl className="divide-y divide-border">{line(t('talent'), r.facts.talent ?? '—')}{line(t('performance'), r.facts.performance ?? '—')}</dl>
    <section><h3 className="mb-1 font-semibold">{t('desk.tiles.salary')}</h3><dl className="divide-y divide-border">
      {line(t('currentPay'), rm(r.source.basicCents))}
      {r.crBeforeBp != null && line(t('compaRatioBefore'), pct(r.crBeforeBp))}
      {line(`${t('merit')} ${hidden ? '' : pct(r.meritBp)}`, money(r.meritCents))}
      {line(`${t('promotion')} ${hidden ? '' : pct(r.promotionBp)}${r.recommendation.promotionGrade ? ` → ${r.recommendation.promotionGrade}` : ''}`, money(r.promotionCents))}
      {line(`${t('special')} ${hidden ? '' : pct(r.specialBp)}`, money(r.specialCents))}
      {line(t('newPay'), money(r.newBasicCents), true)}
      {r.crAfterBp != null && line(t('compaRatioAfter'), pct(r.crAfterBp))}
      {line(t('incrementEligibility'), r.incrementReason || t('eligible'))}
    </dl></section>
    <section><h3 className="mb-1 font-semibold">{t('desk.tiles.bonus')}</h3><dl className="divide-y divide-border">
      {r.bonusBasicCents !== r.source.basicCents && line(t('payWindow.bonusBasic'), rm(r.bonusBasicCents))}
      {line(t('bonusMultiplier'), hidden ? '—' : (r.bonusMultiplierBp / 10000).toFixed(2))}
      {!hidden && line(t('desk.grid.column.months'), (r.bonusMonthsBp / 10000).toFixed(2))}
      {line(t('bonus'), money(r.bonusCents), true)}
      {line(t('lumpSum'), rm(r.lumpCents))}
      {line(t('bonusEligibility'), r.bonusReason || t('eligible'))}
    </dl></section>
    {!hidden && (r.recommendation.promotionGrade || r.recommendation.reason || r.facts.erCase || r.facts.pipCase) && <section><h3 className="mb-1 font-semibold">{t('desk.person.businessCase')}</h3>
      {r.recommendation.reason ? <p className="mb-2 whitespace-pre-wrap">{r.recommendation.reason}</p> : <p className="mb-2 text-muted-foreground">{t('desk.person.noBusinessCase')}</p>}
      <dl className="divide-y divide-border">
        {r.facts.erCase && line(t('erDecision'), t(`case.${r.facts.erDecision}`))}
        {r.facts.pipCase && line(t('pipDecision'), t(`case.${r.facts.pipDecision}`))}
        {r.facts.caseReason && line(t('caseReason'), r.facts.caseReason)}
      </dl>
    </section>}
    {!hidden && <section><h3 className="mb-1 font-semibold">{t('desk.person.notes')}</h3>{note}</section>}
    <section><h3 className="mb-1 font-semibold">{t('desk.flags')}</h3>{flags.length ? <ul className="space-y-2">{flags.map((f, i) => <li key={i} className="flex gap-2"><span className={`h-fit shrink-0 rounded-full px-2 py-0.5 text-xs font-medium ${chipCls[f.severity]}`}>{t(`severity.${f.severity}`)}</span><span>{flagWords(f, t)}</span></li>)}</ul> : <p className="text-muted-foreground">{t('desk.person.noFlags')}</p>}</section>
  </div>;
}

/** Off-cycle requests keep their existing single-page layout; only annual reviews use the simplified desk. */
async function OffcycleReview({ v, sp, scopeIds, s }: { v: RewardView; sp: Search; scopeIds: string[]; s: Awaited<ReturnType<typeof scopedSession>>['s'] }) {
  const { unit } = v; const unitId = unit.id;
  const t = await getTranslations('rewards'), onehrText = await getTranslations('onehr'), u = await getTranslations('rewardUploaded');
  const [choices, batches] = await Promise.all([rewardSetupChoices(s, [unit.companyId].filter(id => scopeIds.includes(id)), { fields: [] }), rewardPayrollChoices(s, unitId)]);
  const tab = ['review', 'budget', 'approvals', 'data', 'excluded', 'rules'].includes(sp.view ?? '') ? sp.view! : 'review';
  const fields = <><input type="hidden" name="unitId" value={unitId} /><input type="hidden" name="revision" value={unit.revision} /></>;
  const rows = v.rows.filter(r => !sp.q || `${r.source.name} ${r.source.employeeCode}`.toLowerCase().includes(sp.q.toLowerCase()));
  const editable = unit.status === 'draft' && v.canEdit;
  const canSubmit = unit.status === 'draft' && v.capabilities?.reviewDecide !== false && v.roles.includes(v.route[0]);
  const canApprove = v.capabilities?.reviewDecide !== false && ['bg', 'gr', 'ctro', 'ec'].some(role => role === unit.status && v.roles.includes(role as 'bg' | 'gr' | 'ctro' | 'ec'));
  const checks = sp.check ? v.flags.filter(f => f.code === sp.check && f.severity === 'exception') : sp.flag ? v.flags.filter(f => f.code === sp.flag) : v.flags;
  return <div className="w-full space-y-5">
    <ScopedCommandIndex entries={v.rows.map(row => ({ href: `/rewards/${unitId}?person=${row.id}`, label: row.source.name, context: row.source.employeeCode ?? '' }))} />
    <PageHeader title={rewardReviewTitle(v.cycle?.name ?? t('title'), v.companyName, v.name)} description={`${t(`kinds.${unit.kind}`)} · ${v.returned ? t(`returnedTo.${v.returned.toSeat}`) : t(`stages.${unit.status}`)}${v.due ? ` · ${t('dueOn', { date: v.due })}` : ''} · ${t('snapshotDate')}: ${unit.snapshotDate}`} />
    <ErrorBanner message={sp.error} />
    {v.returned && <ReturnedBanner returned={v.returned} />}
    <nav aria-label={t('sections')} className="flex flex-wrap gap-1 border-b border-border pb-2">{['review', 'budget', 'approvals', ...(v.roles.includes('gr') ? ['data'] : []), 'rules'].map(key => <Link key={key} href={`/rewards/${unitId}?view=${key}`} aria-current={tab === key ? 'page' : undefined} className={`rounded-md px-3 py-2 text-sm ${tab === key ? 'bg-primary/10 font-semibold text-primary' : 'text-muted-foreground hover:bg-accent'}`}>{t(key)}</Link>)}</nav>
    {v.hiddenCount > 0 && <p className="max-w-3xl text-sm text-muted-foreground">{t('privacyNote')}</p>}
    <Card className="space-y-3 p-5"><h2 className="font-semibold">{t('offcycleFunding')}</h2><p className="text-sm text-muted-foreground">{t('offcycleFundingHelp')}</p>{(['standard', 'h'] as const).map(plan => <p key={plan} className="text-sm tabular-nums">{t(plan)}: {rm(v.budgets[plan].used[0])} / {rm(v.budgets[plan].pools[0])}</p>)}{unit.offcycle?.exceptionReason && <p className="text-sm">{t('budgetException')}: {unit.offcycle.exceptionReason}</p>}<Link className="text-sm text-primary hover:underline" href={`/rewards/${unit.parentUnitId}`}>{t('annualSource')}</Link></Card>
    {tab === 'review' && <>
      <section id="people" className="scroll-mt-6 space-y-3"><h2 className="text-base font-semibold">{t('people')}</h2><form className="flex max-w-lg gap-2"><input name="q" defaultValue={sp.q} aria-label={t('search')} placeholder={t('search')} className={inputCls} /><RewardSubmit type="submit" variant="secondary">{t('search')}</RewardSubmit></form>
        <div className={tableWrapCls}><table className="w-full whitespace-nowrap text-sm"><thead className={theadCls}><tr>{['employee', 'grade', 'talent', 'performance', 'currentPay', 'newPay', 'bonus', 'lumpSum', 'action'].map(k => <th key={k} className={thCls}>{t(k)}</th>)}</tr></thead><tbody className={tbodyCls}>{rows.map(r => <tr key={r.id}><td className="px-3 py-3"><span className="mr-2 font-mono text-xs text-muted-foreground">{r.source.employeeCode}</span>{r.source.name}{!r.facts.reviewed && <span className="ml-2 text-xs text-destructive">{t('unverified')}</span>}{r.source.leftOn && <span className="ml-2 text-xs text-muted-foreground">{t('sourceRefresh.leftMarker', { date: r.source.leftOn })}</span>}{isSeniorPlanMember(unit.policy, r.facts, r.source.grade) && <span className="ml-2 text-xs font-medium">{t('governance.seniorTag')}</span>}<PayWindowTag row={r} window={{ from: unit.policy.blockedFrom, to: unit.policy.blockedTo }} /></td><td className="px-3 py-3">{r.source.grade}{r.recommendation.promotionGrade && ` → ${r.recommendation.promotionGrade}`}</td><td className="px-3 py-3">{r.facts.talent ?? '—'}</td><td className="px-3 py-3">{r.facts.performance ?? '—'}</td><td className="px-3 py-3 text-right tabular-nums">{rm(r.source.basicCents)}</td><td className="px-3 py-3 text-right tabular-nums">{isSeniorPlanMember(unit.policy, r.facts, r.source.grade) && !v.seniorAmountsVisible ? t('governance.handledSeparately') : rm(r.newBasicCents)}</td><td className="px-3 py-3 text-right tabular-nums">{isSeniorPlanMember(unit.policy, r.facts, r.source.grade) && !v.seniorAmountsVisible ? t('governance.handledSeparately') : rm(r.bonusCents)}</td><td className="px-3 py-3 text-right tabular-nums">{rm(r.lumpCents)}</td><td className="px-3 py-3"><Link className="text-primary hover:underline" href={`/rewards/${unitId}/people/${r.id}`}>{t('reviewPerson')}</Link></td></tr>)}</tbody></table>{!rows.length && <p className="p-6 text-sm text-muted-foreground">{t('noPeople')}</p>}</div>
      </section>
      <section id="checks" className="space-y-3"><h2 className="font-semibold">{t('checks')} ({checks.length}){sp.check && <Link className="ml-3 text-sm font-normal text-primary hover:underline" href={`/rewards/${unitId}?view=review#checks`}>{t('showAllChecks')}</Link>}</h2>{!checks.length && <p className="text-sm text-muted-foreground">{t('noChecks')}</p>}<ul className="divide-y divide-border rounded-md border border-border">{checks.map((f, i) => <li key={i} className="flex flex-wrap items-start gap-3 px-4 py-3 text-sm"><span className={`min-w-20 font-semibold ${f.severity === 'block' ? 'text-destructive' : 'text-muted-foreground'}`}>{t(`severity.${f.severity}`)}</span><span className="min-w-0 flex-1">{f.code === 'ARCH-01' ? t('architectureMismatch') : f.message}{f.entryId && <Link className="ml-2 text-primary hover:underline" href={`/rewards/${unitId}/people/${f.entryId}`}>{t('reviewPerson')}</Link>}</span><span className="font-mono text-xs text-muted-foreground">{f.code}</span></li>)}</ul></section>
    </>}
    {tab === 'approvals' && <div id="approvals" className="scroll-mt-6 space-y-6"><h2 className="text-lg font-semibold">{t('approvals')}</h2>
      <p className="text-sm">{v.route.map(role => t(`roles.${role}`)).join(' → ')}</p>
      {(canSubmit || canApprove) && <form action={decideAction} className="max-w-3xl space-y-3">{fields}<Field label={t('decisionReason')}><textarea name="reason" rows={3} maxLength={4000} className={`${inputCls} h-auto py-2`} /></Field>{v.rows.some(e => e.recommendation.promotionGrade) && <label className="flex items-start gap-2 text-sm"><input type="checkbox" name="acknowledged" />{t('roleAcknowledgement')}</label>}<div className="flex flex-wrap gap-3">{editable ? <RewardSubmit name="action" value="submit" type="submit">{t('submit')}</RewardSubmit> : <><RewardSubmit name="action" value="approve" type="submit">{t('approve')}</RewardSubmit><RewardSubmit name="action" value="return" type="submit" variant="secondary">{t('return')}</RewardSubmit><RewardSubmit name="action" value="reject" type="submit" variant="secondary">{t('reject')}</RewardSubmit></>}</div></form>}
      {unit.status === 'approved' && v.roles.some(r => ['gr', 'ctro', 'ec'].includes(r)) && <form action={decideAction} className="max-w-3xl space-y-3">{fields}<Field label={t('decisionReason')}><textarea required minLength={10} name="reason" rows={3} className={`${inputCls} h-auto py-2`} /></Field><RewardSubmit name="action" value="return" type="submit" variant="secondary">{t('return')}</RewardSubmit></form>}
      {unit.status === 'approved' && <RewardPostPanel posting={v.posting} batches={batches} fields={fields} action={postAction} />}
      {unit.status === 'draft' && (canSubmit || v.roles.includes('gr')) && <form action={decideAction} className="max-w-3xl space-y-3">{fields}<Field label={t('decisionReason')}><input required minLength={10} name="reason" className={inputCls} /></Field><RewardSubmit name="action" value="withdraw" type="submit" variant="secondary">{t('withdraw')}</RewardSubmit></form>}
      <section><h2 className="mb-3 font-semibold">{t('history')}</h2><ol className="divide-y divide-border">{v.decisions.map(d => <li key={d.id} className="space-y-1 py-3 text-sm"><p className="font-medium">{t(`stages.${d.fromStage}`)} → {t(`stages.${d.toStage}`)}</p><p className="text-muted-foreground">{t('decidedBy', { actor: d.actorName ?? (d.actorRole ? t(`roles.${d.actorRole}`) : t('aReviewer')) })} · {rewardDecisionTime(d.createdAt)}</p>{d.reason && <p className="max-w-3xl whitespace-pre-wrap">{d.reason}</p>}</li>)}</ol></section>
    </div>}
    {tab === 'data' && v.roles.includes('gr') && <section id="data" className="max-w-3xl space-y-5"><h2 className="font-semibold">{t('data')}</h2><p className="text-sm text-muted-foreground">{t('dataHelp')}</p><ExportDownloadLink href={`/rewards/${unitId}/export?template=1`} className="inline-block text-sm font-medium text-primary hover:underline">{t('downloadTemplate')}</ExportDownloadLink>{unit.status === 'draft' && <><form action={importOnehrAction} className="space-y-3">{fields}<p className="text-sm text-muted-foreground">{onehrText('rewardImportHelp')}</p><RewardSubmit type="submit" variant="secondary">{onehrText('rewardImport')}</RewardSubmit></form><form action={importFactsAction} className="space-y-3">{fields}<Field label={t('completedTemplate')}><input type="file" name="file" accept=".csv" required className="text-sm" /></Field><RewardSubmit type="submit">{t('import')}</RewardSubmit></form><SourceRefresh unitId={unitId} revision={unit.revision} snapshotDate={unit.snapshotDate} today={todayInKualaLumpur()} /></>}<ExportDownloadLink className="inline-block text-sm text-primary hover:underline" href={`/rewards/${unitId}/export`}>{t('export')}</ExportDownloadLink></section>}
    {tab === 'rules' && <section id="rules" className="max-w-3xl space-y-4"><h2 className="font-semibold">{t('rules')}</h2>{['rulePools', 'ruleBonus', 'ruleEC', 'ruleExemption', 'ruleLump', 'rulePrivacy', 'ruleApproval', 'rulePosting'].map(k => <p key={k} className="text-sm leading-6">{t(k)}</p>)}</section>}
    <section className="rounded-lg border border-border p-3">
      <h2 className="text-sm font-medium">{t('sections')}</h2>
      <div className="mt-2 flex flex-wrap gap-x-4 gap-y-2 text-sm">
        <Link href={`/rewards/rules?unit=${unitId}`} className="text-primary underline">{t('rules')}</Link>
        {((v.roles.includes('gr') && v.capabilities?.dataCheck !== false) || v.roles.includes('pbp')) && <Link href={`/rewards/${unitId}/data-check`} className="text-primary underline">{t('prelaunchDataCheck')}</Link>}
        {(v.roles.includes('gr') || choices.companies.some(c => c.id === unit.companyId)) && <Link href={`/admin/rewards/${unitId}`} className="text-primary underline">{t('adminTitle')}</Link>}
        {v.uploaded && <Link href={`/rewards/${unitId}/uploaded`} className="text-primary underline">{u('open')}</Link>}
      </div>
    </section>
  </div>;
}
