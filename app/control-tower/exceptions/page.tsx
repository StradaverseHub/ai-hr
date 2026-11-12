import { ActionButton } from '@/components/ui/action-button';
import Link from 'next/link';
import { getFormatter, getLocale, getTranslations } from 'next-intl/server';
import { requireAdmin } from '@/lib/authz';
import { proposeActions } from '@/core/agent-actions';
import { acknowledgedBlocksForPeriods, type AcknowledgedBlock } from '@/core/loops/grouped-dispositions';
import { allowedCompanies } from '@/core/read';
import { Button, Card, EmployeeCode, ErrorBanner, PageHeader, SectionHeader, btnGhost, btnPrimary, inputCls, pageWideCls } from '@/components/ui';
import { cn } from '@/lib/utils';
import { formatMoney } from '@/lib/money';
import { HR_LOCAL_TZ, formatPayPeriodMonth } from '@/lib/hr-date';
import {
  BUCKETS, bulkEligible, checkCopy, findingDetail, parseGroupKey, parseItemSignature, sameGroup,
  type BulkCandidate, type ExceptionGroup, type GroupIdentity,
} from '@/lib/payroll-exceptions';
import { OperationsTabs } from '../operations-tabs';
import { resolveAnomalyAction } from '@/app/payroll/actions';
import { approveAgentActionAction } from '../actions/actions';
import { resolveAcknowledgedBlockAction } from '../loops/payroll-cycle/actions';
import { markGroupExpectedAction } from './actions';
import { GROUP_PAGE_SIZE, groupedExceptions, pageReadAdmission, payPeriodsOf, type ExceptionItem } from './data';

/**
 * ADR-0074 — THE EXCEPTIONS QUEUE ACROSS EVERY RUN, the one place a payroll exception is resolved (AI Centre restructure,
 * owner decisions 28 and 29), and since the AI-native batch (11 November 2026) GROUPED AND IN PLAIN LANGUAGE.
 *
 * ONE QUEUE, AND NO VERDICT DECIDED TWICE:
 *  - "cause already fixed": exceptions whose cause is no longer true (core/agent-actions.ts proposeActions; only what is
 *    on screen can be approved, and each one is re-checked when pressed);
 *  - "acknowledged": blocking exceptions a standing acknowledgement covers (core/loops/grouped-dispositions.ts), each with
 *    its resolve pre-filled; a person still presses it;
 *  - every open exception, GROUPED by what was found (lib/payroll-exceptions): three buckets (look like real pay errors,
 *    missing details, look like set-up), one card per pattern with its plain-language title, why it matters and what to
 *    do, and a few examples. A pattern opens into a paged list where each exception is decided with the same three
 *    resolutions as before. An exception already offered in one of the two groups above is pointed there, not offered
 *    again.
 *
 * THE COUNTS ARE OVER EVERY OPEN EXCEPTION (app/control-tower/exceptions/data.ts: GROUP BY in the database, the same
 * population Today counts), never over a capped page.
 *
 * NOTHING BLOCKING IS CLEARED IN BULK. Only a non-blocking set-up pattern offers "Mark as expected" for the exceptions
 * on its open page (markGroupExpectedAction → each one through the anomaly owner's own resolve, audited and
 * permission-checked). Missing details link to the person's record, where they are fixed, and to Record readiness, where
 * the missing-data loop's requests are. No figure is computed here, no model is called and no pay changes.
 */
const FIX_ERRORS = ['unknown_type', 'blast_radius', 'nothing_to_do', 'failed'] as const;
const ACK_ERRORS = ['invalid', 'refused', 'changed', 'already', 'failed', 'own'] as const;
const BULK_ERRORS = ['not_administrator', 'invalid', 'blocking', 'too_many', 'nothing', 'failed', 'retry'] as const;
/** Months whose acknowledged blocks are read, newest first, and how many acknowledged blocks are listed. */
const ACK_PERIODS = 6;
const ACK_SHOWN = 50;
/** A payroll figure reads the same for everyone: the shared formatter, with ringgit labelled as people write it. */
const money = (amount: number, currency: string | null) => formatMoney(amount, currency === 'MYR' ? 'RM' : currency);
const target = 'pointer-coarse:min-h-11';
const HOME = '/control-tower/exceptions';

const TAG_TONE = {
  blocks: 'bg-destructive/10 text-destructive',
  blocksClosed: 'bg-muted text-foreground',
  review: 'bg-primary/10 text-primary',
  setup: 'bg-muted text-muted-foreground',
} as const;

type AckRow = AcknowledgedBlock & { payPeriod: string };
type Search = {
  error?: string; toast?: string; fixError?: string; closed?: string; stale?: string; ackError?: string; acknowledged?: string;
  group?: string; page?: string; expected?: string; expectedSkipped?: string; expectedDecided?: string; expectedSuperseded?: string;
  expectedNotYours?: string; bulkError?: string;
};

const focusHref = (key: string, page = 1) => `${HOME}?${new URLSearchParams({ group: key, ...(page > 1 ? { page: String(page) } : {}) })}#exceptions-group`;

/** The page's own reading of an exception for the bulk guard: every finding, with its variant, as the server reads it. */
function candidateOf(item: ExceptionItem): BulkCandidate {
  const findings = parseItemSignature(item.signature);
  return { verdictId: item.verdictId, disposition: item.disposition, resolved: false, superseded: false,
    findings: findings.length ? findings : [{ checkId: item.checkId, severity: item.severity, variant: item.variant }] };
}

export default async function CrossRunExceptionsPage({ searchParams }: { searchParams: Promise<Search> }) {
  const s = await requireAdmin();
  const sp = await searchParams;
  const focusKey = parseGroupKey(sp.group);
  const pageNo = Math.max(1, Math.min(10_000, Number.parseInt(sp.page ?? '1', 10) || 1));
  const [t, tx, ta, tc, te, tg, f, locale] = await Promise.all([getTranslations('anomaly'), getTranslations('payroll.controlTower.exceptions'),
    getTranslations('controlTower.actions'), getTranslations('aiCentre.payrollCycle'), getTranslations('aiCentre.exceptions'),
    getTranslations('aiCentre.exceptions.grouped'), getFormatter(), getLocale()]);
  // Every read shares one passive admission; each keeps its own checks and the viewer's row-level security.
  const { view, proposals, acknowledged, periodOf } = await pageReadAdmission(s, async () => {
    const [view, proposals, companies] = await Promise.all([
      groupedExceptions(s, { focus: focusKey, page: pageNo }),
      proposeActions(s),
      allowedCompanies(s).then(rows => rows.map(row => row.id)).catch(() => [] as string[]),
    ]);
    // The acknowledged blocks of the newest ACK_PERIODS months with an open block, for the companies the viewer may see:
    // every month in one read and one transaction (core/loops/grouped-dispositions.ts acknowledgedBlocksForPeriods), not
    // one transaction per month, and the month of each fixed-cause row.
    const [acknowledged, periodOf] = await Promise.all([
      companies.length
        ? acknowledgedBlocksForPeriods(s, { companyIds: companies, payPeriods: view.blockPeriods.slice(0, ACK_PERIODS) })
        : Promise.resolve([] as readonly AckRow[]),
      payPeriodsOf(s, proposals.flatMap(p => p.subjects.map(sub => sub.verdictId))),
    ]);
    return { view, proposals, acknowledged, periodOf };
  });
  // Offered above: the person closes these there, in one step, rather than deciding them a second time below.
  const offeredAbove = new Set([...proposals.flatMap(p => p.subjects.map(sub => sub.verdictId)), ...acknowledged.map(block => block.verdictId)]);
  const fixError = FIX_ERRORS.find(code => code === sp.fixError);
  const ackError = ACK_ERRORS.find(code => code === sp.ackError);
  const bulkError = BULK_ERRORS.find(code => code === sp.bulkError);
  const closed = Number(sp.closed ?? 0), stale = Number(sp.stale ?? 0);
  const expected = Number.parseInt(sp.expected ?? '', 10);
  const countOf = (value?: string) => Math.max(0, Number.parseInt(value ?? '0', 10) || 0);
  const bulkOutcomes = ([['bulk.skipped', sp.expectedSkipped], ['bulk.alreadyDecided', sp.expectedDecided], ['bulk.superseded', sp.expectedSuperseded],
    ['bulk.notYours', sp.expectedNotYours]] as const).map(([key, value]) => [key, countOf(value)] as const).filter(([, count]) => count > 0);
  const focus = focusKey ? view.groups.find(group => group.key === sp.group) ?? null : null;

  const month = (payPeriod: string) => formatPayPeriodMonth(payPeriod, locale);
  const titleOf = (group: Pick<ExceptionGroup, 'copy'>) => tg(group.copy.title, group.copy.component ? { component: tg(group.copy.component) } : undefined);
  const detailOf = (item: ExceptionItem) => {
    const d = findingDetail(item.checkId, item.facts);
    const values: Record<string, string | number> = { ...d.numbers };
    for (const [name, amount] of Object.entries(d.money)) values[name] = money(amount, item.currency);
    if (d.component) values.component = tg(d.component);
    if (d.direction) values.direction = d.direction;
    const line = tg(d.key, values);
    // A pay change's payroll explanations, when the check recorded them; never the stored cause ids.
    if (d.causes && d.unexplainedPct !== undefined) {
      return `${line} ${tg('detail.netSwingExplained', { causes: d.causes.map(key => tg(key)).join(', '), pct: d.unexplainedPct })}`;
    }
    return line;
  };
  const titleOfFinding = (x: GroupIdentity) => titleOf({ copy: checkCopy(x.checkId, x.variant) });
  // Every other finding of the exception, by its own group: an EIS finding beside an EPF one is "also flagged".
  const alsoFlagged = (item: ExceptionItem) => [...new Set(parseItemSignature(item.signature).filter(x => !sameGroup(x, item)).map(titleOfFinding))];
  // A blocking check whose runs are all closed holds nothing up any more (the queue keeps old runs' exceptions), so its
  // tag says so rather than "Blocks payroll".
  const tagOf = (group: ExceptionGroup) => group.blocking ? (group.closedRunsOnly ? 'blocksClosed' : 'blocks') : group.bucket === 'setup' ? 'setup' : 'review';
  const recordHref = (group: ExceptionGroup, item: ExceptionItem) => group.fixTab ? `/admin/personnel/${item.employmentId}?tab=${group.fixTab}` : null;

  const groupHeader = (group: ExceptionGroup, focused: boolean) => {
    const tag = tagOf(group);
    const more = group.companies - group.companyNames.length;
    return (
      <>
        <div className="flex flex-wrap items-center gap-2.5">
          <span data-group-tag={tag} className={cn('rounded-full px-2 py-0.5 text-[11px] font-semibold whitespace-nowrap', TAG_TONE[tag])}>{tg(`tag.${tag}`)}</span>
          <h2 id={`heading-${group.key}`} className="m-0 min-w-0 flex-1 text-base font-semibold">
            {titleOf(group)} <span className="font-normal text-muted-foreground">· {tg('size.people', { people: group.people })}</span>
          </h2>
          {!focused && groupAction(group)}
        </div>
        <p className="m-0 text-sm">{tg(group.copy.why)}</p>
        <p className="m-0 text-sm text-muted-foreground">{tg(group.copy.todo)}</p>
        <p className="m-0 text-xs text-muted-foreground">
          {tg('size.exceptions', { exceptions: group.exceptions, runs: group.runs })}
          {group.bucket === 'setup' && group.companyNames.length > 0 && <> · {more > 0
            ? tg('size.companiesMore', { names: group.companyNames.join(', '), more })
            : tg('size.companies', { names: group.companyNames.join(', ') })}</>}
        </p>
      </>
    );
  };

  // A blocking pattern is only ever worked one by one; a set-up pattern is reviewed before anything is marked.
  const groupAction = (group: ExceptionGroup) => {
    const href = focusHref(group.key);
    switch (group.action) {
      case 'fix_records': return <Link href={href} className={cn(btnPrimary, target)}>{tg('action.fixRecords')}</Link>;
      case 'one_by_one': return <Link href={href} className={cn(btnGhost, target)}>{tg('action.oneByOne')}</Link>;
      case 'mark_expected': return <Link href={href} className={cn(btnPrimary, target)}>{tg('action.markExpected')}</Link>;
      default: return <Link href={href} className={cn(btnGhost, target)}>{tg('action.review')}</Link>;
    }
  };

  const itemLine = (group: ExceptionGroup, item: ExceptionItem) => (
    <span className="min-w-0 flex-1">
      <span className="font-semibold">{item.name || tg('list.unnamed')}</span>
      {item.employeeCode ? <> <EmployeeCode code={item.employeeCode} /></> : null}
      <span className="text-muted-foreground"> · {month(item.payPeriod)} · </span>
      {detailOf(item)}
    </span>
  );

  const preview = (group: ExceptionGroup) => {
    const items = view.items.get(group.key) ?? [];
    return (
      <>
        {items.map(item => {
          const record = recordHref(group, item);
          return (
            <div key={item.verdictId} data-exception-preview={item.verdictId} className="flex flex-wrap items-center gap-3 border-t border-border py-2.5 text-[13px]">
              {itemLine(group, item)}
              {item.runClosed && item.disposition === 'block' && <span data-run-closed className="text-xs text-muted-foreground">{tg('list.runClosedShort')}</span>}
              {record
                ? <Link href={record} className="font-semibold text-primary hover:underline">{tg(`action.fixTab.${group.fixTab}`)}</Link>
                : <Link href={`/payroll/${item.batchId}/anomalies`} className="font-semibold text-primary hover:underline">{tg('action.openRun')}</Link>}
            </div>
          );
        })}
        {group.exceptions > items.length && (
          <p className="m-0 border-t border-border pt-2.5 text-[13px]">
            <Link href={focusHref(group.key)} className="font-semibold text-primary hover:underline">{tg('action.seeAll', { count: group.exceptions })}</Link>
          </p>
        )}
        {group.bucket === 'missing' && <p className="m-0 text-xs"><Link href="/control-tower/readiness" className="text-primary hover:underline">{tg('action.asked')}</Link></p>}
      </>
    );
  };

  const focusedList = (group: ExceptionGroup) => {
    const items = view.items.get(group.key) ?? [];
    const pages = Math.max(1, Math.ceil(group.exceptions / GROUP_PAGE_SIZE));
    const eligible = group.bulkExpect ? items.filter(item => !offeredAbove.has(item.verdictId) && bulkEligible(group, candidateOf(item))) : [];
    return (
      <>
        {group.bulkExpect && (
          eligible.length > 0 ? (
            <form action={markGroupExpectedAction} data-bulk-expect className="flex flex-col gap-2 rounded-lg border border-border bg-muted/40 p-3">
              <p className="m-0 text-sm font-semibold">{tg('bulk.title')}</p>
              <p className="m-0 text-xs text-muted-foreground">{tg('bulk.help', { count: eligible.length })}</p>
              <input type="hidden" name="group" value={group.key} />
              {/* ONLY WHAT IS ON SCREEN. Posting a filter instead of ids would let a row that appeared between render and
                  click ride along on a decision nobody made; the server re-checks each one. */}
              {eligible.map(item => <input key={item.verdictId} type="hidden" name="verdictId" value={item.verdictId} />)}
              <label className="flex flex-col gap-1 text-xs"><span className="text-muted-foreground">{tg('bulk.noteLabel')}</span>
                <input name="note" required maxLength={400} placeholder={tg('bulk.notePlaceholder')} className={cn(inputCls, target)} /></label>
              <div><ActionButton type="submit" className={cn(btnPrimary, target)}>{tg('bulk.submit', { count: eligible.length })}</ActionButton></div>
            </form>
          ) : items.length > 0 ? <p data-bulk-none className="m-0 text-xs text-muted-foreground">{tg('bulk.none')}</p> : null
        )}
        {group.bucket === 'missing' && (
          <p className="m-0 text-xs text-muted-foreground">{tg('list.fixNote')} <Link href="/control-tower/readiness" className="text-primary hover:underline">{tg('action.asked')}</Link></p>
        )}
        {items.length === 0 && <p role="status" className="m-0 text-sm text-muted-foreground">{tg('list.emptyGroup')}</p>}
        <ul className="m-0 flex list-none flex-col p-0">
          {items.map(item => {
            const record = recordHref(group, item);
            const others = alsoFlagged(item);
            const above = offeredAbove.has(item.verdictId);
            return (
              <li key={item.verdictId} data-exception-row={item.verdictId} className="flex flex-col gap-2 border-t border-border py-3 text-[13px]">
                <div className="flex flex-wrap items-start gap-3">
                  {itemLine(group, item)}
                  <Link href={`/payroll/${item.batchId}/anomalies`} className="text-xs font-medium text-primary hover:underline">{tg('action.openRun')}</Link>
                  {record && <Link href={record} className="text-xs font-semibold text-primary hover:underline">{tg(`action.fixTab.${group.fixTab}`)}</Link>}
                </div>
                <p className="m-0 text-[11px] text-muted-foreground">
                  {tg('list.waitingSince', { date: f.dateTime(item.computedAt, { dateStyle: 'medium', timeZone: HR_LOCAL_TZ }) })}
                  {others.length > 0 && <> · {tg('list.alsoFlagged', { checks: others.join(', ') })}</>}
                </p>
                {/* The prose, when an operator already asked for it on the run's own screen. Never generated from here. */}
                {item.runClosed && item.disposition === 'block' && <p data-run-closed className="m-0 text-xs text-muted-foreground">{tg('list.runClosed')}</p>}
                {item.checkId === 'hypothesis' && item.narrative && <p className="m-0 text-[12px] leading-snug">{item.narrative}</p>}
                {group.bulkExpect && !above && !bulkEligible(group, candidateOf(item)) && <p className="m-0 text-xs text-muted-foreground">{tg('list.notBulk')}</p>}
                {above ? <p data-offered-above className="m-0 text-xs text-muted-foreground">{tg('list.listedAbove')}</p> : (
                  // THE SAME ACTION THE RUN'S QUEUE POSTS TO. `returnTo` only decides where you land.
                  <form action={resolveAnomalyAction} className="space-y-2">
                    <input type="hidden" name="batchId" value={item.batchId} />
                    <input type="hidden" name="verdictId" value={item.verdictId} />
                    <input type="hidden" name="returnTo" value="tower" />
                    <input name="note" placeholder={t('noteLabel')} aria-label={`${t('noteLabel')} · ${item.name || tg('list.unnamed')}`} className={inputCls} />
                    <div className="flex flex-wrap gap-2">
                      <Button type="submit" size="sm" name="resolution" value="accepted" variant="secondary" className={target}>{t('resolveAccepted')}</Button>
                      <Button type="submit" size="sm" name="resolution" value="fixed_upstream" variant="secondary" className={target}>{t('resolveFixedUpstream')}</Button>
                      <Button type="submit" size="sm" name="resolution" value="false_positive" variant="secondary" className={target}>{t('resolveFalsePositive')}</Button>
                    </div>
                  </form>
                )}
              </li>
            );
          })}
        </ul>
        {pages > 1 && (
          <nav aria-label={tg('list.pageOf', { page: pageNo, pages })} className="flex items-center gap-4 border-t border-border pt-3 text-sm">
            {pageNo > 1 ? <Link href={focusHref(group.key, pageNo - 1)} className="text-primary hover:underline">{tg('list.previous')}</Link>
              : <span className="text-muted-foreground/50">{tg('list.previous')}</span>}
            <span className="tabular-nums text-muted-foreground">{tg('list.pageOf', { page: pageNo, pages })}</span>
            {pageNo < pages ? <Link href={focusHref(group.key, pageNo + 1)} className="text-primary hover:underline">{tg('list.next')}</Link>
              : <span className="text-muted-foreground/50">{tg('list.next')}</span>}
          </nav>
        )}
      </>
    );
  };

  return (
    <div className={pageWideCls}>
      <OperationsTabs session={s} active="exceptions" />
      <PageHeader title={tx('title')} description={tx('description')} />

      <ErrorBanner message={sp.error} />
      {sp.toast ? (
        <div className="rounded-md border border-border bg-muted/50 p-3 text-sm">{sp.toast}</div>
      ) : null}

      {view.total > 0 && (
        <section aria-label={tx('outstanding')} className="flex flex-col gap-3">
          <p className="m-0 text-[15px]" data-exceptions-total={view.total} data-exceptions-blocking={view.blocking}>
            <span className="font-semibold">{tg('headline', { total: view.total })}</span>
            <span className="text-muted-foreground"> · {tg('headlineBlocking', { blocking: view.blocking })} · {tg('headlineGroups', { groups: view.groups.length })}</span>
          </p>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
            {BUCKETS.map(bucket => (
              <Card key={bucket} data-exceptions-bucket={bucket} className={cn('px-3.5 py-3', bucket === 'check' && view.buckets.check > 0 && 'border-destructive/40')}>
                <p className={cn('m-0 text-xl font-semibold tabular-nums', bucket === 'check' && view.buckets.check > 0 && 'text-destructive')}>{view.buckets[bucket]}</p>
                <p className="m-0 mt-0.5 text-[13px] text-muted-foreground">{tg(`bucket.${bucket}`)}</p>
              </Card>
            ))}
          </div>
          {view.bucketsPartial && <p className="m-0 text-xs text-muted-foreground">{tg('bucketsPartial')}</p>}
        </section>
      )}

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
                    <p className="font-medium">{sub.name}{periodOf.get(sub.verdictId) && <span className="ml-2 text-xs font-normal text-muted-foreground">{month(periodOf.get(sub.verdictId)!)}</span>}</p>
                    <p className="mt-0.5 text-xs text-muted-foreground">{tg(checkCopy(sub.detectorId, null).title)} · {ta(`cause.${sub.cause}`)}</p>
                  </li>
                ))}
              </ul>
              {p.overCap && <p className="mt-2 text-xs text-muted-foreground">{ta('overCap', { cap: p.type.blastRadiusCap, total: p.count })}</p>}
              <form action={approveAgentActionAction} className="mt-4">
                <input type="hidden" name="typeId" value={p.type.id} />
                {/* ONLY WHAT IS ON SCREEN CAN BE APPROVED. */}
                {p.subjects.slice(0, p.type.blastRadiusCap).map(sub => <input key={sub.verdictId} type="hidden" name="verdictId" value={sub.verdictId} />)}
                <ActionButton type="submit" className={cn(btnPrimary, target)}>{ta('approve', { n: Math.min(p.subjects.length, p.type.blastRadiusCap) })}</ActionButton>
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
            {acknowledged.slice(0, ACK_SHOWN).map(block => (
              <li key={block.verdictId} data-acknowledged-block={block.verdictId} className="flex flex-col gap-2 px-4 py-3 text-sm">
                <p className="m-0 font-medium">{block.personName ?? tc('flags.unnamed')}
                  <span className="ml-2 text-xs font-normal text-muted-foreground">{block.detectors.map(id => tg(checkCopy(id, null).title)).join(', ')}</span></p>
                <form action={resolveAcknowledgedBlockAction} className="flex flex-wrap items-end gap-2">
                  <input type="hidden" name="back" value="exceptions" /><input type="hidden" name="period" value={block.payPeriod} />
                  <input type="hidden" name="target" value={block.companyId} /><input type="hidden" name="verdict" value={block.verdictId} />
                  <label className="flex min-w-48 flex-1 flex-col gap-1 text-xs"><span className="text-muted-foreground">{tc('acknowledgedBlocks.prefilled')}</span>
                    <input readOnly value={block.reason} className={cn(inputCls, target)} /></label>
                  <ActionButton type="submit" className={cn(btnPrimary, target)} aria-label={`${tc('acknowledgedBlocks.resolve')} · ${block.personName ?? tc('flags.unnamed')}`}>{tc('acknowledgedBlocks.resolve')}</ActionButton>
                </form>
              </li>
            ))}
          </ul>
          {acknowledged.length > ACK_SHOWN && <p className="px-4 pb-3 text-xs text-muted-foreground">{tg('list.ackCapped', { shown: ACK_SHOWN, total: acknowledged.length })}</p>}
        </Card>}
      </section>

      {/* ── Every open exception, grouped. ── */}
      <ErrorBanner message={bulkError ? tg(`bulk.error.${bulkError}`) : undefined} />
      {Number.isFinite(expected) && (
        <Card className="p-4" role="status" data-bulk-result>
          <p className="m-0 text-sm">{tg('bulk.done', { count: expected })}</p>
          {bulkOutcomes.map(([key, count]) => <p key={key} className="m-0 mt-1 text-xs text-muted-foreground">{tg(key, { count })}</p>)}
        </Card>
      )}

      {view.total === 0 ? (
        <Card className="p-8 text-center">
          <p className="font-medium">{tx('emptyTitle')}</p>
          <p className="mt-1 text-sm text-muted-foreground">{tx('emptyBody')}</p>
        </Card>
      ) : focusKey ? (
        <section id="exceptions-group" aria-labelledby={focus ? `heading-${focus.key}` : undefined} data-exceptions-focus={sp.group}
          className={cn('scroll-mt-4 flex flex-col gap-2.5 rounded-xl border bg-card px-5 py-4', focus?.blocking ? 'border-destructive/40' : 'border-border')}>
          <p className="m-0 text-sm"><Link href={HOME} className="text-primary hover:underline">{tg('action.back')}</Link></p>
          {focus ? <>{groupHeader(focus, true)}{focusedList(focus)}</> : <p role="status" className="m-0 text-sm text-muted-foreground">{tg('list.emptyGroup')}</p>}
        </section>
      ) : (
        <>
          {view.groups.map(group => (
            <section key={group.key} aria-labelledby={`heading-${group.key}`} data-exceptions-pattern={group.key} data-exceptions-bucket-of={group.bucket}
              className={cn('flex flex-col gap-2.5 rounded-xl border px-5 py-4', group.blocking ? 'border-destructive/40 bg-card' : group.bucket === 'setup' ? 'border-border bg-muted/30' : 'border-border bg-card')}>
              {groupHeader(group, false)}
              {preview(group)}
            </section>
          ))}
          {view.groupsCapped && <p className="text-xs text-muted-foreground">{tg('groupsCapped')}</p>}
        </>
      )}

      {view.total > 0 && <p className="m-0 text-xs text-muted-foreground">{tg('footer')}</p>}

      <Card className="p-5">
        <SectionHeader title={tx('whyTitle')} />
        {/* The honest reason this screen exists: their decisions are the only route to the checks' accuracy figures. */}
        <p className="mt-1 text-sm text-muted-foreground">{tx('whyBody')}</p>
      </Card>
    </div>
  );
}

