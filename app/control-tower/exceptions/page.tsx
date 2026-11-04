import Link from 'next/link';
import { getTranslations } from 'next-intl/server';
import { requireAdmin } from '@/lib/authz';
import { openExceptionsAcrossRuns } from '@/core/payroll-anomaly';
import { HYPOTHESIS_DETECTOR_ID } from '@/core/payroll-anomaly-detectors';
import { proposeActions } from '@/core/agent-actions';
import { acknowledgedBlocks, type AcknowledgedBlock } from '@/core/loops/grouped-dispositions';
import { allowedCompanies } from '@/core/read';
import { Button, Card, EmployeeCode, ErrorBanner, PageHeader, SectionHeader, btnPrimary, inputCls, pageWideCls } from '@/components/ui';
import { cn } from '@/lib/utils';
import { OperationsTabs } from '../operations-tabs';
import { resolveAnomalyAction } from '@/app/payroll/actions';
import { approveAgentActionAction } from '../actions/actions';
import { resolveAcknowledgedBlockAction } from '../loops/payroll-cycle/actions';

/**
 * ADR-0074 — THE EXCEPTIONS QUEUE ACROSS EVERY RUN, and since the AI Centre restructure (owner decisions 28 and 29,
 * 4 November 2026) THE ONE PLACE A PAYROLL EXCEPTION IS RESOLVED. The Salary payroll page shows counts and links here,
 * the run's own page keeps its list of auto-cleared rows (where a missed issue is raised) and links here, and the former
 * Proposed actions page forwards here.
 *
 * ⚠️ **WHY, MEASURED ON PRODUCTION RATHER THAN ASSUMED.** 81 flagged verdicts were live and unresolved across **23
 * different batches**, and not one had ever been dispositioned: the only place to resolve one was that batch's own queue.
 *
 * ONE QUEUE, IN THREE PARTS, AND NO VERDICT TWICE:
 *  - "cause already fixed": exceptions whose cause is no longer true (core/agent-actions.ts proposeActions, the same
 *    reader, cap and approval the Proposed actions page used; only what is on screen can be approved, and each one is
 *    re-checked when pressed);
 *  - "acknowledged": blocking exceptions a standing acknowledgement covers (core/loops/grouped-dispositions.ts), each
 *    with its resolve pre-filled with the acknowledgement's reason; a person still presses it, and it is re-checked;
 *  - every other open exception, worst first, with its three resolutions.
 * The counts at the top are over every open exception, whichever part it is listed in.
 *
 * NOTHING HERE IS A SECOND IMPLEMENTATION. Every button posts to its owner's existing server action, so the ledger
 * stamps hung off `resolveAnomalyVerdict` cannot be forgotten on one screen and not another. No figure is computed here,
 * no model is called and no pay changes.
 */
const TONE: Record<string, string> = {
  block: 'border-rose-300 bg-rose-50 text-rose-900 dark:border-rose-500/40 dark:bg-rose-500/10 dark:text-rose-200',
  review: 'border-amber-300 bg-amber-50 text-amber-900 dark:border-amber-500/40 dark:bg-amber-500/10 dark:text-amber-200',
};

/** Every number a finding prints comes from `facts`; the model never produced any of them. */
const factLine = (facts: Record<string, string | number>) =>
  Object.entries(facts)
    .filter(([, v]) => v !== '' && v !== null && v !== undefined)
    .map(([k, v]) => `${k}: ${typeof v === 'number' ? Math.round(v * 100) / 100 : v}`)
    .join(' · ');

/** `missing-bank-profile` → `missingBankProfile`, the shape the `anomaly.detector.*` keys are stored in. */
const camel = (id: string) => id.replace(/-([a-z])/g, (_, c: string) => c.toUpperCase());
const FIX_ERRORS = ['unknown_type', 'blast_radius', 'nothing_to_do', 'failed'] as const;
const ACK_ERRORS = ['invalid', 'refused', 'changed', 'already', 'failed', 'own'] as const;
const target = 'pointer-coarse:min-h-11';

type AckRow = AcknowledgedBlock & { payPeriod: string };
type Search = { error?: string; toast?: string; fixError?: string; closed?: string; stale?: string; ackError?: string; acknowledged?: string };

export default async function CrossRunExceptionsPage({ searchParams }: { searchParams: Promise<Search> }) {
  const s = await requireAdmin();
  const sp = await searchParams;
  const [t, tx, ta, tc, te] = await Promise.all([getTranslations('anomaly'), getTranslations('payroll.controlTower.exceptions'),
    getTranslations('controlTower.actions'), getTranslations('aiCentre.payrollCycle'), getTranslations('aiCentre.exceptions')]);
  // The three reads are independent; each keeps its own checks and the viewer's row-level security.
  const [queue, proposals, companies] = await Promise.all([
    openExceptionsAcrossRuns(s),
    proposeActions(s),
    allowedCompanies(s).then(rows => rows.map(row => row.id)).catch(() => [] as string[]),
  ]);
  const { rows, total, cappedOut } = queue;
  // The acknowledged blocks of each month that has an open block on screen, for the companies the viewer may see.
  const periods = [...new Set(rows.filter(row => row.disposition === 'block').map(row => row.payPeriod))].sort();
  const acknowledged: AckRow[] = companies.length
    ? (await Promise.all(periods.map(payPeriod => acknowledgedBlocks(s, { companyIds: companies, payPeriod }).then(list => list.map(block => ({ ...block, payPeriod })))))).flat()
    : [];
  const periodOf = new Map(rows.map(row => [row.verdictId, row.payPeriod]));
  const blocks = rows.filter(r => r.disposition === 'block').length;
  // No verdict is listed twice: one in a group above is left out of the list below.
  const grouped = new Set([...proposals.flatMap(p => p.subjects.map(sub => sub.verdictId)), ...acknowledged.map(block => block.verdictId)]);
  const listed = rows.filter(row => !grouped.has(row.verdictId));
  const fixError = FIX_ERRORS.find(code => code === sp.fixError);
  const ackError = ACK_ERRORS.find(code => code === sp.ackError);
  const closed = Number(sp.closed ?? 0), stale = Number(sp.stale ?? 0);

  return (
    <div className={pageWideCls}>
      <OperationsTabs session={s} active="exceptions" />
      <PageHeader title={tx('title')} description={tx('description')} />

      <ErrorBanner message={sp.error} />
      {sp.toast ? (
        <div className="rounded-md border border-emerald-300 bg-emerald-50 p-3 text-sm text-emerald-900 dark:border-emerald-500/40 dark:bg-emerald-500/10 dark:text-emerald-200">
          {sp.toast}
        </div>
      ) : null}

      <Card className="p-5">
        <div className="flex flex-wrap items-baseline gap-x-6 gap-y-2">
          <div>
            <p className="text-xs text-muted-foreground">{tx('outstanding')}</p>
            <p data-exceptions-total className="mt-1 text-2xl font-semibold tabular-nums">{total}</p>
          </div>
          <div>
            <p className="text-xs text-muted-foreground">{tx('blocking')}</p>
            <p data-exceptions-blocking className="mt-1 text-2xl font-semibold tabular-nums">{blocks}</p>
          </div>
        </div>
        {/* ⚠️ SAYS WHEN IT IS SHOWING A SUBSET. A page that silently rendered the first hundred of nine hundred would read
            as a queue somebody had nearly finished. */}
        {cappedOut && <p className="mt-3 text-xs font-medium text-amber-700 dark:text-amber-400">{tx('capped', { shown: rows.length, total })}</p>}
        <p className="mt-3 text-[11px] text-muted-foreground">{tx('help')}</p>
      </Card>

      {/* ── Cause already fixed: the former Proposed actions, as a group of this queue. ── */}
      <section id="fixed-causes" aria-labelledby="fixed-causes-heading" data-exceptions-group="fixed" className="scroll-mt-4 space-y-3">
        {(proposals.length > 0 || sp.closed !== undefined || fixError) && <h2 id="fixed-causes-heading" className="text-base font-semibold">{te('fixedTitle')}</h2>}
        <ErrorBanner message={fixError ? ta(`error.${fixError}`) : undefined} />
        {sp.closed !== undefined && (
          <Card className="p-4" role="status">
            <p className="text-sm">{ta('done', { closed })}</p>
            {stale > 0 && <p className="mt-1 text-xs text-muted-foreground">{ta('staleNote', { stale })}</p>}
          </Card>
        )}
        {proposals.map(p => (
          <Card key={p.type.id} className="overflow-hidden" data-fix-type={p.type.id}>
            <SectionHeader title={ta(`type.${p.type.id}`)} count={p.count} subtitle={ta(`does.${p.type.id}`)} />
            <div className="p-4">
              <p className="text-xs text-muted-foreground">{ta('reversibleNote')}</p>
              <ul className="mt-3 divide-y divide-border rounded-md border border-border">
                {p.subjects.map(sub => (
                  <li key={sub.verdictId} data-fix-subject={sub.verdictId} className="px-3 py-2 text-sm">
                    <p className="font-medium">{sub.name}{periodOf.get(sub.verdictId) && <span className="ml-2 text-xs font-normal text-muted-foreground">{periodOf.get(sub.verdictId)}</span>}</p>
                    <p className="mt-0.5 text-xs text-muted-foreground">{t(`detector.${camel(sub.detectorId)}`)} · {ta(`cause.${sub.cause}`)}</p>
                  </li>
                ))}
              </ul>
              {p.overCap && <p className="mt-2 text-xs text-amber-700 dark:text-amber-400">{ta('overCap', { cap: p.type.blastRadiusCap, total: p.count })}</p>}
              <form action={approveAgentActionAction} className="mt-4">
                <input type="hidden" name="typeId" value={p.type.id} />
                {/* ONLY WHAT IS ON SCREEN CAN BE APPROVED. Posting a filter instead of ids would let a row that appeared
                    between render and click ride along on an approval nobody gave it. */}
                {p.subjects.slice(0, p.type.blastRadiusCap).map(sub => <input key={sub.verdictId} type="hidden" name="verdictId" value={sub.verdictId} />)}
                <button type="submit" className={cn(btnPrimary, target)}>{ta('approve', { n: Math.min(p.subjects.length, p.type.blastRadiusCap) })}</button>
                <p className="mt-2 text-xs text-muted-foreground">{ta('recheckNote')}</p>
              </form>
            </div>
          </Card>
        ))}
      </section>

      {/* ── Acknowledged: blocking exceptions a standing acknowledgement covers, moved here from Salary payroll. ── */}
      <section id="acknowledged-blocks" aria-labelledby="acknowledged-blocks-heading" data-exceptions-group="acknowledged" className="scroll-mt-4 space-y-3">
        {(acknowledged.length > 0 || ackError || sp.acknowledged === 'resolved') && <h2 id="acknowledged-blocks-heading" className="text-base font-semibold">{tc('acknowledgedBlocks.title')}</h2>}
        <ErrorBanner message={ackError ? tc(`errors.${ackError}`) : undefined} />
        {sp.acknowledged === 'resolved' && <p role="status" className="rounded-lg border border-border bg-muted/50 p-3 text-sm">{tc('saved.resolved')}</p>}
        {acknowledged.length > 0 && <Card className="overflow-hidden" data-acknowledged-blocks>
          <p className="px-4 pt-4 text-xs text-muted-foreground">{tc('acknowledgedBlocks.help')}</p>
          <ul className="m-0 mt-3 flex list-none flex-col divide-y divide-border border-t border-border p-0">
            {acknowledged.map(block => (
              <li key={block.verdictId} data-acknowledged-block={block.verdictId} className="flex flex-col gap-2 px-4 py-3 text-sm">
                <p className="m-0 font-medium">{block.personName ?? tc('flags.unnamed')}
                  <span className="ml-2 text-xs font-normal text-muted-foreground">{block.detectors.map(id => t(`detector.${camel(id)}`)).join(', ')}</span></p>
                <form action={resolveAcknowledgedBlockAction} className="flex flex-wrap items-end gap-2">
                  <input type="hidden" name="back" value="exceptions" /><input type="hidden" name="period" value={block.payPeriod} />
                  <input type="hidden" name="target" value={block.companyId} /><input type="hidden" name="verdict" value={block.verdictId} />
                  <label className="flex min-w-48 flex-1 flex-col gap-1 text-xs"><span className="text-muted-foreground">{tc('acknowledgedBlocks.prefilled')}</span>
                    <input readOnly value={block.reason} className={cn(inputCls, target)} /></label>
                  <button type="submit" className={cn(btnPrimary, target)} aria-label={`${tc('acknowledgedBlocks.resolve')} · ${block.personName ?? tc('flags.unnamed')}`}>{tc('acknowledgedBlocks.resolve')}</button>
                </form>
              </li>
            ))}
          </ul>
        </Card>}
      </section>

      {rows.length === 0 ? (
        <Card className="p-8 text-center">
          <p className="font-medium">{tx('emptyTitle')}</p>
          <p className="mt-1 text-sm text-muted-foreground">{tx('emptyBody')}</p>
        </Card>
      ) : null}
      {grouped.size > 0 && listed.length < rows.length && <p data-exceptions-grouped className="text-xs text-muted-foreground">{te('inGroups', { count: rows.length - listed.length })}</p>}

      {listed.map((row) => (
        <Card key={row.verdictId} className="p-5" data-exception-row={row.verdictId}>
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <p className="flex flex-wrap items-center gap-2 font-medium">
                {row.employeeName}
                {row.employeeCode ? <EmployeeCode code={row.employeeCode} /> : null}
                {/* THE RUN, ON THE ROW. Out of its own batch a verdict has to say which period it is about, and the link
                    back to that run is how an operator checks the rest of it. */}
                <Link href={`/payroll/${row.batchId}/anomalies`} className="text-[11px] font-medium text-primary underline-offset-2 hover:underline">
                  {row.payPeriod}
                </Link>
              </p>
              <p className="mt-0.5 text-[11px] text-muted-foreground">{tx('waitingSince', { date: row.computedAt.toISOString().slice(0, 10) })}</p>
            </div>
            <span className={`rounded-full border px-2.5 py-0.5 text-[11px] font-medium ${TONE[row.disposition] ?? ''}`}>
              {row.disposition === 'block' ? t('dispositionBlock') : t('dispositionReview')}
            </span>
          </div>

          <ul className="mt-3 space-y-2">
            {row.findings.map((f, i) => (
              <li key={`${f.detectorId}-${i}`} className={`rounded-md border p-3 text-xs ${TONE[f.severity] ?? ''}`}>
                <p className="font-medium">{f.detectorId === HYPOTHESIS_DETECTOR_ID ? t('hypothesisLabel') : f.detectorId}</p>
                {/* The prose, when an operator has already asked for it on the run's own screen. It is never generated from
                    here: narration costs a provider call on the tenant's own key and belongs where somebody chose to spend it. */}
                {f.narrative && <p className="mt-1 text-[12px] leading-snug">{f.narrative}</p>}
                <p className="mt-1 font-mono text-[11px] opacity-80">{factLine(f.facts)}</p>
              </li>
            ))}
          </ul>

          {/* THE SAME ACTION THE RUN'S QUEUE POSTED TO. `returnTo` only decides where you land. */}
          <form action={resolveAnomalyAction} className="mt-4 space-y-2">
            <input type="hidden" name="batchId" value={row.batchId} />
            <input type="hidden" name="verdictId" value={row.verdictId} />
            <input type="hidden" name="returnTo" value="tower" />
            <input name="note" placeholder={t('noteLabel')} className={inputCls} />
            <div className="flex flex-wrap gap-2">
              <Button type="submit" size="sm" name="resolution" value="accepted" variant="secondary" className={target}>{t('resolveAccepted')}</Button>
              <Button type="submit" size="sm" name="resolution" value="fixed_upstream" variant="secondary" className={target}>{t('resolveFixedUpstream')}</Button>
              <Button type="submit" size="sm" name="resolution" value="false_positive" variant="secondary" className={target}>{t('resolveFalsePositive')}</Button>
            </div>
          </form>
        </Card>
      ))}

      <Card className="p-5">
        <SectionHeader title={tx('whyTitle')} />
        {/* The honest reason this screen exists, said to the person working it: their decisions are the only route to the
            checks' accuracy figures, which Insights › AI quality shows. */}
        <p className="mt-1 text-sm text-muted-foreground">{tx('whyBody')}</p>
      </Card>
    </div>
  );
}
