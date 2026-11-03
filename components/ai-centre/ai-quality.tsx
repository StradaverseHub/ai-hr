import Link from 'next/link';
import type { ReactNode } from 'react';
import { getFormatter, getTranslations } from 'next-intl/server';
import type { SessionContext } from '@/db/client';
import { Card, ErrorBanner, btnGhost, btnPrimary, inputCls } from '@/components/ui';
import { StatCells } from '@/components/ui/stat-cells';
import { BarChart } from '@/components/charts/BarChart';
import { aiQuality, type CandidateView, type CorrectionView, type GapBacklogRow, type QualityView } from '@/core/learning/quality';
import type { LoopProposalView } from '@/core/learning/proposals';
import type { Share } from '@/core/learning/quality-math';
import { candidateDefaults, EVAL_FACTORS, EVAL_KINDS, EXPECTATION_MAX_CHARS, GAP_STATUSES, QUALITY_PERIODS, QUESTION_MAX_CHARS, type QualityPeriod } from '@/core/learning/types';
import {
  approveCandidateAction, decideProposalAction, dismissSignalAction, editCandidateAction, exportCandidateAction, promoteSignalAction, reopenCandidateAction,
  reopenSignalAction, revertProposalAction, setGapStatusAction, withdrawCandidateAction,
} from '@/app/assistant/learning-actions';
import { cn } from '@/lib/utils';

/** AI v2 Phase 2, P2-6 — AI Centre › Insights › AI quality, for HR and group administrators (no mock-up; the layout the
 * coordinator gave, built from the Insights and ledger components: StatCells, the shared BarChart, the ledger's tables).
 *
 * Four figures (answers marked helpful; prepared actions confirmed unchanged, with the edited share; discarded; open gaps),
 * each a percentage with its counts for the last 30 days, this quarter or this year, per company; the confirmed-unchanged
 * share by month drawn to scale from 0 to 100%; the biggest gaps with a redacted example and their status; the corrections
 * to review, made eval candidates or dismissed; the candidates, approved and exported by an administrator; the loops'
 * proposals, approved, rejected or reverted by an administrator, with each loop's corrections by month; the method.
 * Rendered only for an administrator (the Insights view checks isAdmin, and core/learning/quality.ts checks it again);
 * every figure is read under their row-level security. No ratio of HR staff to employees appears anywhere (owner rule). */
export type QualityQuery = {
  qperiod?: string; qcompany?: string; qsaved?: string; qerror?: string; qsignal?: string; qpromote?: string; qcandidate?: string;
};
const SAVED = ['dismissed', 'reopened', 'candidate', 'edited', 'approved', 'reopened_candidate', 'withdrawn', 'gap_status', 'proposal_approved', 'proposal_rejected', 'proposal_reverted'] as const;
const ERRORS = ['invalid', 'not_administrator', 'not_found', 'changed', 'not_redacted', 'state', 'failed'] as const;
const target = 'pointer-coarse:min-h-11';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const cell = 'px-4 py-3 align-top';

function href(query: Readonly<Record<string, string | null | undefined>>, anchor?: string) {
  const params = new URLSearchParams({ view: 'insights' });
  for (const [key, value] of Object.entries(query)) if (value) params.set(key, value);
  return `/assistant?${params}${anchor ? `#${anchor}` : ''}`;
}

type T = Awaited<ReturnType<typeof getTranslations<'aiCentre.quality'>>>;
type F = Awaited<ReturnType<typeof getFormatter>>;

export async function AiQualitySection({ session, query }: { session: SessionContext; query: QualityQuery }) {
  const [t, tl, tp, f] = await Promise.all([getTranslations('aiCentre.quality'), getTranslations('aiCentre.loops'), getTranslations('aiCentre.payrollCycle'), getFormatter()]);
  const view = await aiQuality(session, { period: query.qperiod, companyId: query.qcompany });
  const company = view.companyId;
  const keep = { qperiod: view.period, qcompany: company };
  const nameOf = (id: string) => view.companies.find(row => row.id === id)?.name ?? '';
  const pct = (value: number | null) => (value === null ? t('noData') : f.number(value, { style: 'percent', maximumFractionDigits: 1 }));
  const day = (at: Date) => f.dateTime(at, { dateStyle: 'medium', timeZone: 'Asia/Kuala_Lumpur' });
  const monthLabel = (month: string, style: 'short' | 'long') => f.dateTime(new Date(`${month}-01T00:00:00+08:00`), { month: style, timeZone: 'Asia/Kuala_Lumpur' });
  const saved = SAVED.find(code => code === query.qsaved), error = ERRORS.find(code => code === query.qerror);
  const { figures } = view;
  const hidden = <>
    <input type="hidden" name="qperiod" value={view.period} />
    {company && <input type="hidden" name="qcompany" value={company} />}
  </>;

  const sub = (text: string) => <span className="mt-1 block text-xs font-normal text-muted-foreground">{text}</span>;
  const tile = (value: Share, line: string) => <>{pct(value.share)}{sub(line)}</>;
  const trendValues = figures.trend.map(row => (row.share === null ? 0 : Math.round(row.share * 1000) / 10));
  const chartLabel = t('chart.label', { values: figures.trend.map(row => row.share === null
    ? t('chart.valueNone', { month: monthLabel(row.month, 'long') })
    : t('chart.value', { month: monthLabel(row.month, 'long'), share: pct(row.share), unchanged: row.unchanged, decided: row.decided })).join('; ') });
  const promoteSignal = UUID.test(query.qpromote ?? '') ? view.corrections.find(row => row.id === query.qpromote?.toLowerCase()) : undefined;
  const openCandidate = UUID.test(query.qcandidate ?? '') ? view.candidates.find(row => row.id === query.qcandidate?.toLowerCase()) : undefined;

  return (
    <section id="ai-quality" data-ai-quality aria-labelledby="ai-quality-title" className="space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div className="min-w-0">
          <h2 id="ai-quality-title" className="text-xl font-semibold tracking-tight">{t('title')}</h2>
          <p className="mt-0.5 text-sm text-muted-foreground">{company ? t('descriptionCompany', { company: nameOf(company) }) : t('descriptionAll')}</p>
        </div>
        <nav aria-label={t('periodLabel')} data-quality-period className="flex flex-wrap gap-1.5">
          {QUALITY_PERIODS.map((period: QualityPeriod) => (
            <Link key={period} href={href({ qperiod: period, qcompany: company }, 'ai-quality')} aria-current={period === view.period ? 'true' : undefined}
              className={cn(btnGhost, target, period === view.period && 'border-primary bg-primary/10 text-foreground')}>{t(`periods.${period}`)}</Link>
          ))}
        </nav>
      </div>

      {view.companies.length > 1 && (
        <form method="get" action="/assistant" className="flex flex-wrap items-end gap-2" data-quality-company-filter>
          <input type="hidden" name="view" value="insights" />
          <input type="hidden" name="qperiod" value={view.period} />
          <label className="flex flex-col gap-1.5">
            <span className="text-xs font-medium text-muted-foreground">{t('companyLabel')}</span>
            <select name="qcompany" defaultValue={company ?? ''} className={cn(inputCls, 'min-w-56', target)}>
              <option value="">{t('allCompanies', { count: view.companies.length })}</option>
              {view.companies.map(row => <option key={row.id} value={row.id}>{row.name}</option>)}
            </select>
          </label>
          <button type="submit" className={cn(btnGhost, target)}>{t('show')}</button>
        </form>
      )}

      {saved && (
        <div role="status" className="flex flex-wrap items-center gap-2 rounded-lg border border-border bg-muted/50 p-3 text-sm" data-quality-saved={saved}>
          <span>{t(`saved.${saved}`)}</span>
          {saved === 'dismissed' && UUID.test(query.qsignal ?? '') && (
            <form action={reopenSignalAction}>{hidden}<input type="hidden" name="signalId" value={query.qsignal} />
              <button type="submit" className={cn('inline-flex min-h-9 items-center font-medium text-primary hover:underline', target)}>{t('undoDismiss')}</button>
            </form>
          )}
        </div>
      )}
      {error && <ErrorBanner message={t(`errors.${error}`)} />}

      {view.companies.length === 0 ? <p className="text-sm text-muted-foreground">{t('noCompanies')}</p> : <>
        <StatCells cells={[
          { label: t('tiles.helpful'), value: tile(figures.helpful, figures.helpful.whole
            ? t('tiles.helpfulNote', { helpful: figures.helpful.part, marked: figures.helpful.whole }) : t('tiles.helpfulNone')) },
          { label: t('tiles.unchanged'), value: tile(figures.prepared.unchanged, figures.prepared.decided
            ? t('tiles.unchangedNote', { unchanged: figures.prepared.unchanged.part, decided: figures.prepared.decided, edited: pct(figures.prepared.edited.share), editedCount: figures.prepared.edited.part })
            : t('tiles.preparedNone')) },
          { label: t('tiles.discarded'), value: tile(figures.prepared.discarded, figures.prepared.decided
            ? t('tiles.discardedNote', { discarded: figures.prepared.discarded.part, decided: figures.prepared.decided }) : t('tiles.preparedNone')) },
          { label: t('tiles.gaps'), value: <>{f.number(figures.gaps.openIntents)}{sub(figures.gaps.questions
            ? t('tiles.gapsNote', { share: pct(figures.gaps.openQuestions.share), open: figures.gaps.openQuestions.part, questions: figures.gaps.questions }) : t('tiles.gapsNone'))}</> },
        ]} />

        <section aria-labelledby="ai-quality-trend" className="space-y-2" data-quality-chart>
          <h3 id="ai-quality-trend" className="font-semibold">{t('chart.title')}</h3>
          <Card className="p-4">
            <BarChart id="ai-quality-unchanged-by-month" categories={figures.trend.map(row => monthLabel(row.month, 'short'))}
              series={[{ label: t('chart.unit'), values: trendValues }]} ariaLabel={chartLabel} max={100}
              valueLabels={figures.trend.map(row => (row.share === null ? '' : pct(row.share)))} />
          </Card>
          <p className="text-xs text-muted-foreground">{t('chart.note')}</p>
        </section>

        <GapsTable view={view} t={t} f={f} hidden={hidden} />
        <CorrectionsTable view={view} t={t} day={day} hidden={hidden} keep={keep} promote={promoteSignal} />
        <CandidatesTable view={view} t={t} day={day} hidden={hidden} keep={keep} open={openCandidate} />
        <ProposalsTable view={view} t={t} tl={tl} tp={tp} f={f} day={day} hidden={hidden} monthLabel={monthLabel} pct={pct} />

        <details id="ai-quality-method" className="max-w-4xl text-xs text-muted-foreground" data-quality-method>
          <summary className={cn('inline-flex min-h-9 cursor-pointer items-center font-medium text-primary hover:underline', target)}>{t('method.link')}</summary>
          <div className="mt-2 space-y-2">
            {(['helpful', 'prepared', 'discarded', 'gaps', 'trend', 'corrections', 'candidates', 'proposals', 'access', 'privacy'] as const).map(key => <p key={key}>{t(`method.${key}`)}</p>)}
          </div>
        </details>
      </>}
    </section>
  );
}

function TableShell({ id, title, help, children, minWidth = 'min-w-[640px]' }: { id: string; title: string; help?: string; children: ReactNode; minWidth?: string }) {
  return (
    <section id={id} aria-labelledby={`${id}-title`} className="space-y-2" data-quality-table={id}>
      <h3 id={`${id}-title`} className="font-semibold">{title}</h3>
      {help && <p className="max-w-4xl text-xs text-muted-foreground">{help}</p>}
      <Card className="overflow-hidden">
        <div className="overflow-x-auto">
          <table className={cn('w-full text-left text-sm', minWidth)}>
            <caption className="sr-only">{title}</caption>
            {children}
          </table>
        </div>
      </Card>
    </section>
  );
}
const Head = ({ cols }: { cols: readonly string[] }) => (
  <thead className="border-b border-border bg-muted/40"><tr>{cols.map(col => <th key={col} scope="col" className="px-4 py-3 font-medium">{col}</th>)}</tr></thead>
);

function intentLabel(t: T, intentKey: string) {
  const [kind, area] = intentKey.split(':');
  const areaLabel = t.has(`areas.${area}`) ? t(`areas.${area}`) : t('areas.general');
  return t(`intents.${kind as 'not_supported' | 'no_route' | 'cannot_answer'}`, { area: areaLabel });
}

function GapsTable({ view, t, f, hidden }: { view: QualityView; t: T; f: F; hidden: ReactNode }) {
  const scope = view.companyId ? [view.companyId] : view.companies.map(row => row.id);
  return (
    <TableShell id="ai-quality-gaps" title={t('gaps.title')} help={t('gaps.help')}>
      <Head cols={[t('gaps.intent'), t('gaps.count'), t('gaps.example'), t('gaps.status')]} />
      <tbody className="divide-y divide-border">
        {view.gaps.length === 0 ? <tr><td colSpan={4} className={cn(cell, 'text-muted-foreground')}>{t('gaps.none')}</td></tr>
          : view.gaps.slice(0, 20).map((row: GapBacklogRow) => (
            <tr key={row.intentKey} data-gap-row={row.intentKey}>
              <th scope="row" className={cn(cell, 'font-medium')}>{intentLabel(t, row.intentKey)}
                <p className="mt-1 text-xs font-normal text-muted-foreground">{t('gaps.roles', { roles: row.roles.map(role => t(`roles.${role}`)).join(', ') })}</p>
              </th>
              <td className={cn(cell, 'tabular-nums')}>{f.number(row.count)}</td>
              <td className={cn(cell, 'max-w-sm')}>
                {row.examples.length ? <ul className="space-y-1">{row.examples.map(example => <li key={example} data-gap-example className="text-muted-foreground">“{example}”</li>)}</ul>
                  : <span className="text-muted-foreground">{t('gaps.noExample')}</span>}
              </td>
              <td className={cell}>
                <form action={setGapStatusAction} className="flex flex-wrap items-end gap-2" data-gap-status-form>
                  {hidden}
                  {scope.filter(id => row.statuses.some(item => item.companyId === id)).map(id => <input key={id} type="hidden" name="companyId" value={id} />)}
                  <input type="hidden" name="intentKey" value={row.intentKey} />
                  <label className="flex flex-col gap-1">
                    <span className="sr-only">{t('gaps.statusFor', { intent: intentLabel(t, row.intentKey) })}</span>
                    <select name="status" defaultValue={row.status ?? ''} className={cn(inputCls, 'min-w-36', target)}>
                      {row.status === null && <option value="" disabled>{t('gaps.mixed')}</option>}
                      {GAP_STATUSES.map(status => <option key={status} value={status}>{t(`gaps.statuses.${status}`)}</option>)}
                    </select>
                  </label>
                  {view.gaps.length > 1 && (
                    <label className="flex flex-col gap-1">
                      <span className="text-xs text-muted-foreground">{t('gaps.duplicateOf')}</span>
                      <select name="duplicateOf" defaultValue={row.statuses.find(item => item.duplicateOf)?.duplicateOf ?? ''} className={cn(inputCls, 'min-w-36', target)}>
                        <option value="">{t('gaps.duplicateNone')}</option>
                        {view.gaps.filter(other => other.intentKey !== row.intentKey).map(other => <option key={other.intentKey} value={other.intentKey}>{intentLabel(t, other.intentKey)}</option>)}
                      </select>
                    </label>
                  )}
                  <button type="submit" className={cn(btnGhost, target)} aria-label={`${t('gaps.save')} · ${intentLabel(t, row.intentKey)}`}>{t('gaps.save')}</button>
                </form>
              </td>
            </tr>
          ))}
      </tbody>
    </TableShell>
  );
}

function signalLabel(t: T, row: Pick<CorrectionView, 'kind' | 'action'>) {
  return t(`signals.${row.kind as 'card_edited' | 'card_discarded' | 'recommendation_rejected' | 'answer_unhelpful'}`);
}

function CandidateFields({ t, defaults }: { t: T; defaults: Readonly<{ question?: string; expectation?: string; kind: string; factor: string }> }) {
  return <>
    <label className="flex flex-col gap-1.5">
      <span className="text-xs font-medium text-muted-foreground">{t('candidate.question')}</span>
      <textarea name="question" required rows={2} maxLength={QUESTION_MAX_CHARS * 2} defaultValue={defaults.question ?? ''} className={cn(inputCls, 'h-auto py-2', target)} />
    </label>
    <label className="flex flex-col gap-1.5">
      <span className="text-xs font-medium text-muted-foreground">{t('candidate.expectation')}</span>
      <textarea name="expectation" required rows={3} maxLength={EXPECTATION_MAX_CHARS * 2} defaultValue={defaults.expectation ?? ''} className={cn(inputCls, 'h-auto py-2', target)} />
    </label>
    <div className="grid gap-3 sm:grid-cols-2">
      <label className="flex flex-col gap-1.5">
        <span className="text-xs font-medium text-muted-foreground">{t('candidate.kind')}</span>
        <select name="kind" defaultValue={defaults.kind} className={cn(inputCls, target)}>{EVAL_KINDS.map(kind => <option key={kind} value={kind}>{t(`candidate.kinds.${kind}`)}</option>)}</select>
      </label>
      <label className="flex flex-col gap-1.5">
        <span className="text-xs font-medium text-muted-foreground">{t('candidate.factor')}</span>
        <select name="factor" defaultValue={defaults.factor} className={cn(inputCls, target)}>{EVAL_FACTORS.map(factor => <option key={factor} value={factor}>{t(`candidate.factors.${factor}`)}</option>)}</select>
      </label>
    </div>
    <p className="text-xs text-muted-foreground">{t('candidate.redactionHelp')}</p>
  </>;
}

function CorrectionsTable({ view, t, day, hidden, keep, promote }: { view: QualityView; t: T; day: (at: Date) => string; hidden: ReactNode;
  keep: Record<string, string | null>; promote?: CorrectionView }) {
  return (
    <div className="space-y-3">
      <TableShell id="ai-quality-corrections" title={t('corrections.title')} help={t('corrections.help')}>
        <Head cols={[t('corrections.signal'), t('corrections.role'), t('corrections.when'), t('corrections.actions')]} />
        <tbody className="divide-y divide-border">
          {view.corrections.length === 0 ? <tr><td colSpan={4} className={cn(cell, 'text-muted-foreground')}>{t('corrections.none')}</td></tr>
            : view.corrections.map(row => (
              <tr key={row.id} data-correction={row.kind}>
                <th scope="row" className={cn(cell, 'font-medium')}>{signalLabel(t, row)}
                  <p className="mt-1 text-xs font-normal text-muted-foreground">{t('corrections.detail', { area: t.has(`areas.${row.area}`) ? t(`areas.${row.area}`) : t('areas.general'), locale: t(`locales.${row.locale}`) })}</p>
                  {row.example && <p className="mt-1 text-xs font-normal text-muted-foreground" data-correction-example>“{row.example}”</p>}
                </th>
                <td className={cell}>{t(`roles.${row.role}`)}</td>
                <td className={cn(cell, 'tabular-nums')}>{day(row.at)}</td>
                <td className={cell}>
                  <div className="flex flex-wrap gap-2">
                    <Link href={href({ ...keep, qpromote: row.id }, 'ai-quality-promote')} className={cn(btnPrimary, target)}>{t('corrections.promote')}<span className="sr-only"> · {signalLabel(t, row)}</span></Link>
                    <form action={dismissSignalAction}>{hidden}<input type="hidden" name="signalId" value={row.id} />
                      <button type="submit" className={cn(btnGhost, target)}>{t('corrections.dismiss')}<span className="sr-only"> · {signalLabel(t, row)}</span></button>
                    </form>
                  </div>
                </td>
              </tr>
            ))}
        </tbody>
      </TableShell>
      {promote && (
        <Card id="ai-quality-promote" className="space-y-3 p-4" data-promote-form={promote.id}>
          <h4 className="font-semibold">{t('candidate.newTitle', { signal: signalLabel(t, promote) })}</h4>
          <p className="text-sm text-muted-foreground">{t('candidate.newIntro', { role: t(`roles.${promote.role}`), locale: t(`locales.${promote.locale}`) })}</p>
          {promote.example && <p className="text-sm" data-promote-example>{t('candidate.example', { example: promote.example })}</p>}
          <form action={promoteSignalAction} className="space-y-3">
            {hidden}<input type="hidden" name="signalId" value={promote.id} />
            <CandidateFields t={t} defaults={{ question: promote.example ?? '', ...candidateDefaults(promote.kind) }} />
            <div className="flex flex-wrap gap-2">
              <button type="submit" className={cn(btnPrimary, target)}>{t('candidate.saveDraft')}</button>
              <Link href={href(keep, 'ai-quality-corrections')} className={cn(btnGhost, target)}>{t('candidate.cancel')}</Link>
            </div>
          </form>
        </Card>
      )}
    </div>
  );
}

function CandidatesTable({ view, t, day, hidden, keep, open }: { view: QualityView; t: T; day: (at: Date) => string; hidden: ReactNode;
  keep: Record<string, string | null>; open?: CandidateView }) {
  const versioned = (row: CandidateView) => <><input type="hidden" name="candidateId" value={row.id} /><input type="hidden" name="version" value={row.version} /></>;
  return (
    <div className="space-y-3">
      <TableShell id="ai-quality-candidates" title={t('candidates.title')} help={t('candidates.help')}>
        <Head cols={[t('candidates.question'), t('candidates.role'), t('candidates.state'), t('candidates.actions')]} />
        <tbody className="divide-y divide-border">
          {view.candidates.length === 0 ? <tr><td colSpan={4} className={cn(cell, 'text-muted-foreground')}>{t('candidates.none')}</td></tr>
            : view.candidates.map(row => (
              <tr key={row.id} data-candidate={row.state}>
                <th scope="row" className={cn(cell, 'max-w-md font-normal')}>
                  <span className="block font-medium">“{row.question}”</span>
                  <span className="mt-1 block text-xs text-muted-foreground">{t('candidates.expected', { expectation: row.expectation })}</span>
                </th>
                <td className={cell}>{t(`roles.${row.role}`)}<span className="block text-xs text-muted-foreground">{t(`locales.${row.locale}`)}</span></td>
                <td className={cell}>{t(`candidates.states.${row.state}`)}<span className="block text-xs text-muted-foreground tabular-nums">{t('candidates.version', { version: row.version, date: day(row.changedAt) })}</span></td>
                <td className={cell}>
                  <div className="flex flex-wrap gap-2">
                    {row.state === 'draft' && <>
                      <Link href={href({ ...keep, qcandidate: row.id }, 'ai-quality-candidate-edit')} className={cn(btnGhost, target)}>{t('candidates.edit')}</Link>
                      <form action={approveCandidateAction}>{hidden}{versioned(row)}<button type="submit" className={cn(btnPrimary, target)}>{t('candidates.approve')}</button></form>
                    </>}
                    {row.state === 'approved' && <>
                      <form action={exportCandidateAction}>{hidden}<input type="hidden" name="candidateId" value={row.id} /><button type="submit" className={cn(btnPrimary, target)}>{t('candidates.export')}</button></form>
                      <form action={reopenCandidateAction}>{hidden}{versioned(row)}<button type="submit" className={cn(btnGhost, target)}>{t('candidates.reopen')}</button></form>
                    </>}
                    {row.state === 'exported' && (
                      <a href={`/assistant/learning/export?candidate=${row.id}`} className={cn(btnGhost, target)} download>{t('candidates.download')}</a>
                    )}
                    {(row.state === 'draft' || row.state === 'approved') && (
                      <form action={withdrawCandidateAction}>{hidden}{versioned(row)}<button type="submit" className={cn(btnGhost, 'text-muted-foreground', target)}>{t('candidates.withdraw')}</button></form>
                    )}
                  </div>
                </td>
              </tr>
            ))}
        </tbody>
      </TableShell>
      {open && open.state === 'draft' && (
        <Card id="ai-quality-candidate-edit" className="space-y-3 p-4" data-candidate-edit={open.id}>
          <h4 className="font-semibold">{t('candidate.editTitle')}</h4>
          <form action={editCandidateAction} className="space-y-3">
            {hidden}{versioned(open)}
            <CandidateFields t={t} defaults={open} />
            <div className="flex flex-wrap gap-2">
              <button type="submit" className={cn(btnPrimary, target)}>{t('candidate.saveDraft')}</button>
              <Link href={href(keep, 'ai-quality-candidates')} className={cn(btnGhost, target)}>{t('candidate.cancel')}</Link>
            </div>
          </form>
        </Card>
      )}
    </div>
  );
}

function ProposalsTable({ view, t, tl, tp, f, day, hidden, monthLabel, pct }: { view: QualityView; t: T;
  tl: Awaited<ReturnType<typeof getTranslations<'aiCentre.loops'>>>; tp: Awaited<ReturnType<typeof getTranslations<'aiCentre.payrollCycle'>>>; f: F;
  day: (at: Date) => string; hidden: ReactNode; monthLabel: (month: string, style: 'short' | 'long') => string; pct: (value: number | null) => string }) {
  const percent = (bp: number) => f.number(bp / 10_000, { style: 'percent', maximumFractionDigits: 2 });
  const pattern = (value: string) => value.startsWith('cause:') ? (tp.has(`causes.${value.slice(6)}`) ? tp(`causes.${value.slice(6)}`) : tp('patternUnknown'))
    : view.patternNames[value] ? tp('patternItem', { item: view.patternNames[value] }) : tp('patternUnknown');
  const what = (row: LoopProposalView) => row.kind === 'threshold'
    ? tp('proposals.threshold', { from: percent(row.fromThresholdBp), to: percent(row.toThresholdBp ?? row.fromThresholdBp) })
    : tp('proposals.exclusion', { pattern: pattern(row.pattern ?? '') });
  const nameOf = (id: string) => view.companies.find(row => row.id === id)?.name ?? '';
  const months = view.loopCorrections[0]?.months.slice(-3).map(row => row.month) ?? [];
  return (
    <div className="space-y-3">
      <TableShell id="ai-quality-proposals" title={t('proposals.title')} help={t('proposals.help')}>
        <Head cols={[t('proposals.change'), t('proposals.evidence'), t('proposals.state'), t('proposals.actions')]} />
        <tbody className="divide-y divide-border">
          {view.proposals.length === 0 ? <tr><td colSpan={4} className={cn(cell, 'text-muted-foreground')}>{t('proposals.none')}</td></tr>
            : view.proposals.map(row => (
              <tr key={row.proposalKey ?? row.decisionId} data-proposal={row.state}>
                <th scope="row" className={cn(cell, 'font-medium')}>{what(row)}
                  <p className="mt-1 text-xs font-normal text-muted-foreground">{t('proposals.where', { loop: tl(`names.${row.loop}`), company: nameOf(row.companyId) })}</p>
                </th>
                <td className={cn(cell, 'text-xs text-muted-foreground')}>{tp('proposals.evidence', { flags: row.evidence.flags, expected: row.evidence.expected, problems: row.evidence.problems,
                  share: percent(row.evidence.expectedShareBp), days: row.evidence.windowDays })}</td>
                <td className={cell}>{row.state === 'open' ? t('proposals.open') : t('proposals.applied', { date: row.decidedAt ? day(row.decidedAt) : '' })}</td>
                <td className={cell}>
                  <div className="flex flex-wrap gap-2">
                    {row.state === 'open' && row.proposalKey && (['approved', 'rejected'] as const).map(decision => (
                      <form key={decision} action={decideProposalAction}>{hidden}
                        <input type="hidden" name="companyId" value={row.companyId} /><input type="hidden" name="proposalKey" value={row.proposalKey!} /><input type="hidden" name="decision" value={decision} />
                        <button type="submit" className={cn(decision === 'approved' ? btnPrimary : btnGhost, target)} aria-label={`${t(`proposals.${decision}`)} · ${what(row)}`}>{t(`proposals.${decision}`)}</button>
                      </form>
                    ))}
                    {row.state === 'applied' && row.decisionId && (
                      <form action={revertProposalAction}>{hidden}
                        <input type="hidden" name="companyId" value={row.companyId} /><input type="hidden" name="decisionId" value={row.decisionId} />
                        <button type="submit" className={cn(btnGhost, target)} aria-label={`${t('proposals.revert')} · ${what(row)}`}>{t('proposals.revert')}</button>
                      </form>
                    )}
                  </div>
                </td>
              </tr>
            ))}
        </tbody>
      </TableShell>
      <TableShell id="ai-quality-loop-corrections" title={t('loopCorrections.title')} help={t('loopCorrections.help')} minWidth="min-w-[520px]">
        <Head cols={[t('loopCorrections.loop'), ...months.map(month => monthLabel(month, 'short'))]} />
        <tbody className="divide-y divide-border">
          {view.loopCorrections.length === 0 ? <tr><td colSpan={1 + months.length} className={cn(cell, 'text-muted-foreground')}>{t('loopCorrections.none')}</td></tr>
            : view.loopCorrections.map(row => (
              <tr key={row.loop} data-loop-correction={row.loop}>
                <th scope="row" className={cn(cell, 'font-medium')}>{tl.has(`names.${row.loop}`) ? tl(`names.${row.loop}`) : row.loop}</th>
                {row.months.slice(-3).map(item => (
                  <td key={item.month} className={cn(cell, 'tabular-nums')}>{item.decided ? <>{pct(item.share)}<span className="block text-xs text-muted-foreground">{t('loopCorrections.counts', { corrected: item.corrected, decided: item.decided })}</span></> : <span className="text-muted-foreground">{t('noData')}</span>}</td>
                ))}
              </tr>
            ))}
        </tbody>
      </TableShell>
    </div>
  );
}
