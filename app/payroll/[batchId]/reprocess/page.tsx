import Link from 'next/link';
import { cookies } from 'next/headers';
import { notFound } from 'next/navigation';
import { getLocale, getTranslations } from 'next-intl/server';
import { requireAdmin } from '@/lib/authz';
import { batchDetail, getReprocessJob, listBatches, listPayslipLessEligible, reprocessEligibility } from '@/core/payroll';
import { listRecomputeDisclosure } from '@/core/payroll-view';
import { STATUTORY_BASE_KEYS, type StatutoryBaseKey, type StatutoryLineKey } from '@/core/payslip-recompute';
import { isModuleEnabledOrFalse } from '@/core/entitlements';
import { Card, EmployeeCode, ErrorBanner, PageHeader, SectionHeader, pageWideCls } from '@/components/ui';
// 65e2d5de — the Recalculation History card folds. The open/closed choice is a cookie the SERVER reads,
// so the first paint is already correct (no closed-then-restored flash); see the component's own note.
import { CollapsibleCardSection } from '@/components/collapsible-card-section';
import { formatMoney } from '@/lib/money';
// 9066bd6c — Back returns the Payroll Process list EXACTLY as it was left. The list hands each row link
// its own filter query as `?from=…`; without this the Back here went to a bare `/payroll` and the year,
// months, company, cycle and status selection was thrown away. Whitelisted by shape, never echoed raw.
import { payrollListReturnTo } from '@/lib/return-to';
import { ReprocessForm, type ReprocessAddCandidate, type ReprocessCandidate } from './reprocess-form';
// b372e923 — one Payroll Result href per result row, joined to this run's payslips by employment. The
// join lives in its own module so the "opens somebody else's result" failure can be checked row by row
// against a real reprocessed run; see the module header for why that is not a four-line inline map.
import { reprocessResultHrefs } from './result-links';

/**
 * e440991b — REPROCESS SELECTED EMPLOYEES, a screen of its own.
 *
 * WHAT THIS ROUTE IS FOR. Selective reprocessing is not new and is not broken: on production
 * `payroll_reprocess_job` holds 35 completed jobs across 10 runs, the most recent this week, and 25 of
 * them corrected exactly one person. What the reporter rejected was the ROUTE to it — the selection
 * panel sat at the very bottom of the 1,286-line payroll run screen, BELOW the Recalculation History
 * card, and the Payroll Process list offered no way in at all. This page is that route: the run's own
 * identity at the top, the selection, a review of what is about to happen, and — afterwards, on this
 * same screen — an account of what it did.
 *
 * THE ENGINE IS UNTOUCHED. `reprocessSelectedEmployees` remains the only authority: permission,
 * processed-only, closed-period refusal, cross-company intersection, idempotent enqueue and the
 * queued→running claim all live there and all still run on submit. The gates below are a SECOND
 * surface (`reprocessEligibility` re-reads the same three facts), so the operator is told why the door
 * is shut instead of finding out by pressing the button.
 */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * 65e2d5de — the Recalculation History fold, remembered per browser.
 *
 * Note the polarity, which is the opposite of every OTHER panel cookie in this module: the payroll
 * transaction screens read `!== '0'` because their employee panel opens by default. This one is CLOSED by
 * default — that is the whole request — so it opens only on an explicit `'1'`. Getting this backwards
 * would ship a "fold" that is always open, pass every test, and read as nothing having changed.
 */
const HISTORY_OPEN_COOKIE = 'payroll-reprocess-history';

/** 97a9b0ab — statutory line key → its payroll.batch label key. Exhaustive by TYPE (Record over
 *  StatutoryLineKey), so adding a key to STATUTORY_LINE_KEYS without a label fails the build rather
 *  than rendering `lineundefined` at runtime. Moved here with the disclosure it labels. */
/** 017d9c25 — statutory BASE key → its payroll.batch label key. Exhaustive by TYPE over
 *  STATUTORY_BASE_KEYS, for the same reason the line map below is: a new base without a label fails
 *  the build rather than rendering `baseundefined`. */
const STATUTORY_BASE_LABEL: Record<StatutoryBaseKey, string> = {
  epf: 'baseEpf',
  epfAdditional: 'baseEpfAdditional',
  socsoEis: 'baseSocsoEis',
  pcb: 'basePcb',
  hrdf: 'baseHrdf',
};

const STATUTORY_LINE_LABEL: Record<StatutoryLineKey, string> = {
  epfEmployee: 'lineEpfEmployee',
  epfEmployer: 'lineEpfEmployer',
  socsoEmployee: 'lineSocsoEmployee',
  socsoEmployer: 'lineSocsoEmployer',
  socsoSkbbk: 'lineSocsoSkbbk',
  eisEmployee: 'lineEisEmployee',
  eisEmployer: 'lineEisEmployer',
  pcb: 'linePcb',
  cp38: 'lineCp38',
  zakat: 'lineZakat',
  lp: 'lineLp',
  hrdf: 'lineHrdf',
};

export default async function ReprocessPage({
  params,
  searchParams,
}: {
  params: Promise<{ batchId: string }>;
  searchParams: Promise<{ error?: string; job?: string; from?: string }>;
}) {
  const s = await requireAdmin();
  const t = await getTranslations('payroll.batch');
  // The summary strip's column labels are the ones the Payroll Process list already uses for the same
  // six facts, read from the namespace that actually holds them — r134 shipped a screen reading a
  // namespace that never had its keys and every page rendered MISSING_MESSAGE.
  const tl = await getTranslations('payroll.list');
  const locale = await getLocale();
  const { batchId } = await params;
  // Same shape-check as the run screen: `/payroll/<segment>` hands any non-uuid straight to a uuid
  // parameter and Postgres answers with an error, i.e. a 500 where a 404 belongs.
  if (!UUID_RE.test(batchId)) notFound();
  const sp = await searchParams;
  // 9066bd6c — the Payroll Process list's own filter query, whitelisted BY SHAPE (never echoed raw).
  // r253 — resolved ONCE and handed to the form as well as to the header. It used to be resolved inline
  // for the Back link only, so `reprocessSelectedAction` — the ordinary way off this screen — posted
  // nothing, redirected to a bare `/payroll/<id>/reprocess?job=…`, and the selection was gone by the
  // time the operator read the job result. `undefined` when there is nothing to carry, so an unfiltered
  // visit posts no field at all and the address stays exactly as it was.

  const data = await batchDetail(s, batchId);
  if (!data) notFound();
  const { batch, slips } = data;

  // The same module gate the run screen puts on the panel: selective reprocessing produces an in-place
  // recompute of one run, which only makes sense where several runs a month are allowed at all. Off ⇒
  // the route does not exist, matching the absence of the button that leads here.
  if (!isModuleEnabledOrFalse(s, 'multi_cycle_payroll')) notFound();

  const eligibility = await reprocessEligibility(s, { batchId });
  if (!eligibility) notFound();

  // The run's identity, read through the SAME projection the Payroll Process list renders, so the strip
  // you check the run against cannot start disagreeing with the row you clicked. Narrowed to this run's
  // company and period — a company runs at most a handful of times in one month.
  const listed = (await listBatches(s, [batch.companyId], batch.payPeriod)).find((b) => b.id === batchId);
  const currency = listed?.currency ?? null;
  const totals = (batch.totals ?? {}) as Record<string, number>;

  const dateFmt = new Intl.DateTimeFormat(locale, { day: '2-digit', month: 'short', year: 'numeric', timeZone: 'UTC' });
  // A date-only column ('YYYY-MM-DD') is parsed as UTC and formatted as UTC — matched ends, so the day
  // printed is the day stored. Parsing it in local time is the classic off-by-one.
  const paymentDate = batch.batchDate ? dateFmt.format(new Date(`${batch.batchDate}T00:00:00Z`)) : '—';

  const summary: { label: string; value: string }[] = [
    { label: t('summaryPeriod'), value: batch.payPeriod },
    {
      label: t('summaryCycle'),
      // Same derivation as the list and the run screen: the run-type label plus the free-text remarks,
      // so wizard cycles stored under the generic 'off_cycle' bucket still read distinctly.
      value: `${tl(`runType.${batch.runType}`)}${batch.remarks ? ` — ${batch.remarks}` : ''}`,
    },
    { label: tl('colCompany'), value: listed?.company ?? '—' },
    { label: t('summaryPaymentDate'), value: paymentDate },
    { label: tl('colEmployees'), value: String(slips.length) },
    { label: t('totalNet'), value: formatMoney(totals.net, currency) },
  ];

  // 9066bd6c / b372e923 — the list's own filter query, whitelisted by shape ONCE and then used three
  // times: this screen's Back, the hidden field that carries it across the submit, and the Payroll
  // Result link on every result row. `payrollListReturnTo` answers '/payroll' for absent-or-hostile,
  // which is the same as having none — so `listFrom` is undefined there rather than pinning an
  // unfiltered list onto every outgoing URL.
  const listBack = payrollListReturnTo(sp.from);
  const listFrom = listBack === '/payroll' ? undefined : listBack;

  const header = (
    <PageHeader
      back={{ href: listBack, label: t('reprocessBack') }}
      title={t('reprocessTitle')}
      description={`${batch.payPeriod} · ${listed?.company ?? ''}`}
    />
  );

  // ── The three refusals, each with its reason on screen ──────────────────────────────────────────
  // Rendered rather than 404'd: the run exists and the operator can see it on the list, so "not found"
  // would be a lie and a dead end. Each one is re-asserted inside reprocessSelectedEmployees' own
  // transaction on submit, which is where a race with a concurrent close is actually decided.
  const refusal = !eligibility.permitted
    ? t('reprocessAdminOnly')
    : !eligibility.processed
      ? t('reprocessNotProcessed')
      : eligibility.periodClosed
        ? t('reprocessPeriodClosed')
        : null;
  if (refusal) {
    return (
      /* 65e2d5de — both branches carry the module's one width standard, not just the happy path. */
      <div className={pageWideCls}>
        {header}
        <ErrorBanner message={refusal} />
      </div>
    );
  }

  // 49e7e0a2 — the employments the run itself marked stale, ticked on arrival.
  const preselectedIds = Array.isArray(batch.recalcEmploymentIds)
    ? batch.recalcEmploymentIds.filter((x): x is string => typeof x === 'string')
    : [];

  const candidates: ReprocessCandidate[] = slips.map((sl) => ({
    employmentId: sl.employmentId,
    employeeCode: sl.employeeCode,
    name: sl.name,
    gross: sl.gross,
    net: sl.net,
    // version 1 = as first generated, so the number of prior recalculations is version - 1. Already on
    // batchDetail's projection: no extra read, no join, and therefore no Department column here.
    reprocessedTimes: Math.max(0, (sl.version ?? 1) - 1),
  }));

  // fbcf706d — everyone eligible for this month with NO payslip on this run. Until now nothing on any
  // screen said these people existed, and the only way to pay them was Reset, which throws away the
  // month's processing and its record and re-runs the whole company. The read resolves the SAME period
  // window the engine computes and calls the same readiness checks, so what is listed here is what
  // pressing the button will actually do. Plain serialisable data — no closures cross to the client.
  const newCandidates: ReprocessAddCandidate[] = (await listPayslipLessEligible(s, { batchId })).map((r) => ({
    employmentId: r.employmentId,
    employeeCode: r.employeeCode,
    name: r.name,
    hiredOn: r.hiredOn,
    outsideScope: r.outsideScope,
    blockers: r.blockers,
    warnings: r.warnings,
  }));

  // 97a9b0ab — every recomputation this run has had, each diffed against the calculation it replaced
  // with the cause named. It reads `payroll_employee_result_history`, NOT domain events, so the Audit
  // Trail does not carry it: this page is now its ONLY reader, which is why point 4 MOVED it here
  // rather than deleting it (r168b). A never-reprocessed run pays one indexed lookup and shows nothing.
  const disclosure = await listRecomputeDisclosure(s, { batchId });
  // Resolved on the SERVER so the first paint is already right — see HISTORY_OPEN_COOKIE for the polarity.
  const historyOpen = (await cookies()).get(HISTORY_OPEN_COOKIE)?.value === '1';

  // The job just submitted, when the action redirected here carrying its id. Fenced to THIS run: a job
  // id belonging to another batch is ignored rather than rendered under this run's heading.
  const job = sp.job && UUID_RE.test(sp.job) ? await getReprocessJob(s, sp.job) : null;
  const thisJob = job && job.batchId === batchId ? job : null;
  const jobResult = (thisJob?.result ?? null) as {
    reprocessed?: number;
    headcount?: number;
    /** fbcf706d — how many of the above JOINED the run rather than being recalculated on it. */
    added?: number;
    recalculated?: number;
  } | null;
  // The history rows THIS job wrote: its own employments, written at or after it was enqueued. The
  // recompute runs inline between enqueue and completion, so that window holds exactly this job's rows
  // and the card below can show the EARLIER ones as what they are — the record of past reprocessing.
  const jobRows = thisJob
    ? disclosure.filter((r) => thisJob.employmentIds.includes(r.employmentId) && r.at >= thisJob.createdAt)
    : [];
  const jobRowIds = new Set(jobRows.map((r) => r.id));
  const earlier = disclosure.filter((r) => !jobRowIds.has(r.id));
  // b372e923 — the Payroll Result link for each of those rows, at the SAME destination the normal
  // Payroll Process run screen sends its own per-employee links to (one shared builder, so there is no
  // reprocess-only result screen to drift). `slips` is this run's payslips as read at the top of THIS
  // render, i.e. after the reprocess wrote its results, so an employee the job just ADDED is already
  // paid on the run and links exactly like a recalculated one. `listFrom` travels with the link so Back
  // from the result returns the list as the operator left it — the same journey this screen's own
  // header Back makes, and it survives the submit because the form posts it (see ReprocessForm).
  const resultHrefs = reprocessResultHrefs(jobRows, slips, batch, listFrom);

  const money = (n: unknown) => formatMoney(n, currency);
  /** What moved, in the words of the diff: gross first when it moved, then each statutory line. */
  const movedLabels = (r: (typeof disclosure)[number]) => [
    ...(r.diff.grossChanged ? [t('reprocessMovedGross')] : []),
    ...r.diff.moved.map((m) => t(STATUTORY_LINE_LABEL[m.key])),
  ];

  return (
    <div className={pageWideCls}>
      {header}

      <ErrorBanner message={sp.error} />

      <Card className="px-4 py-3">
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
          {summary.map((f) => (
            <div key={f.label}>
              <div className="text-[0.65rem] font-semibold uppercase tracking-wide text-muted-foreground">
                {f.label}
              </div>
              <div className="mt-0.5 text-sm font-medium tabular-nums">{f.value}</div>
            </div>
          ))}
        </div>
      </Card>

      {/* THE RESULT, when there is one. It is rendered ABOVE the selection because after a submit this
          is what the operator came back for; the selection stays below so a second correction does not
          need a second navigation. */}
      {thisJob && thisJob.status === 'failed' && (
        <ErrorBanner message={t('reprocessJobFailed', { error: thisJob.error ?? '' })} />
      )}
      {thisJob && thisJob.status === 'completed' && (
        <Card className="overflow-hidden">
          <div className="border-b border-emerald-200 bg-emerald-50 px-4 py-3 text-sm font-medium text-emerald-900 dark:border-emerald-500/30 dark:bg-emerald-500/10 dark:text-emerald-300">
            ✓{' '}
            {t('reprocessResultTitle', {
              n: jobResult?.reprocessed ?? thisJob.employmentIds.length,
              total: jobResult?.headcount ?? slips.length,
            })}
            {/* fbcf706d — "N of M recalculated" is not what happened when some of the N had never been
                on the run. The split is stated rather than folded into the recalculation count. */}
            {(jobResult?.added ?? 0) > 0 && ` · ${t('reprocessResultAddedCount', { n: jobResult!.added! })}`}{' '}
            · {thisJob.updatedAt.toISOString().slice(0, 16).replace('T', ' ')}
          </div>
          <div className="overflow-x-auto">
            <table className="w-full min-w-[52rem] text-sm">
              <thead className="bg-muted/50 text-left text-xs uppercase tracking-wide text-muted-foreground">
                <tr>
                  <th className="px-3 py-2 font-medium">{t('colEmployee')}</th>
                  <th className="whitespace-nowrap px-3 py-2 text-right font-medium">{t('reprocessColNetBefore')}</th>
                  <th className="whitespace-nowrap px-3 py-2 text-right font-medium">{t('reprocessColNetAfter')}</th>
                  <th className="px-3 py-2 font-medium">{t('reprocessColMoved')}</th>
                  <th className="px-3 py-2 font-medium">{t('reprocessColWhy')}</th>
                  {/* b372e923 — the action column the reprocess result never had. */}
                  <th className="whitespace-nowrap px-3 py-2 font-medium">{t('reprocessColResult')}</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {jobRows.map((r) => {
                  const moved = movedLabels(r);
                  // fbcf706d — an ADD has no previous calculation, so every figure on it "moved" from
                  // zero and the diff would read as a pay rise from nothing. It is rendered as the event
                  // it actually is; `action` is what the engine recorded, not something re-derived here.
                  const isAdd = r.action === 'add';
                  // b372e923 — THIS row's href, looked up by THIS row's id. An addition is not excluded:
                  // it has a payslip, created by this very reprocess. Absent ⇒ no payslip on this run for
                  // that employment, and the cell is plain text rather than a link that leads nowhere.
                  const resultHref = resultHrefs.get(r.id);
                  return (
                    <tr key={r.id}>
                      <td className="px-3 py-2">
                        <span className="inline-flex items-baseline gap-1.5">
                          <EmployeeCode code={r.employeeCode} />
                          <span>{r.employeeName}</span>
                        </span>
                      </td>
                      {/* Net BEFORE and AFTER come off the stored snapshots this run wrote at the time
                          (payroll_employee_result_history.before / .after), never off a fresh
                          calculation — a results screen that re-derived the figures could disagree with
                          the payslip it claims to describe. */}
                      <td className="whitespace-nowrap px-3 py-2 text-right tabular-nums text-muted-foreground">
                        {isAdd ? '—' : money(r.diff.netBefore)}
                      </td>
                      <td
                        className={`whitespace-nowrap px-3 py-2 text-right font-medium tabular-nums ${
                          isAdd || r.diff.netChanged ? 'text-emerald-700 dark:text-emerald-400' : ''
                        }`}
                      >
                        {money(r.diff.netAfter)}
                      </td>
                      <td className="px-3 py-2 text-xs">
                        {isAdd
                          ? t('reprocessResultAdded')
                          : moved.length === 0
                            ? t('reprocessNothingMoved')
                            : r.diff.netChanged
                              ? moved.join(', ')
                              : `${moved.join(', ')} — ${t('reprocessPayUnchanged')}`}
                      </td>
                      <td className="px-3 py-2 text-xs text-muted-foreground">
                        {isAdd
                          ? t('reprocessWhyAdded')
                          : r.priorMonths.length > 0
                          ? t('reprocessWhyPriorMonths', { periods: r.priorMonths.join(', ') })
                          : r.diff.rulesetChanged
                            ? t('reprocessWhyRuleset', {
                                before: r.diff.before.rulesetVersion ?? '?',
                                after: r.diff.after.rulesetVersion ?? '?',
                              })
                            : t('reprocessWhyOwnInputs')}
                        {r.reason ? ` · ${r.reason}` : ''}
                      </td>
                      <td className="whitespace-nowrap px-3 py-2 text-xs">
                        {resultHref ? (
                          <Link href={resultHref} className="font-medium text-primary hover:underline">
                            {t('reprocessResultLink')}
                          </Link>
                        ) : (
                          <span className="text-muted-foreground">—</span>
                        )}
                      </td>
                    </tr>
                  );
                })}
                {jobRows.length === 0 && (
                  <tr>
                    <td colSpan={6} className="px-4 py-6 text-center text-muted-foreground">
                      {t('reprocessNothingMoved')}
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </Card>
      )}

      <Card>
        <SectionHeader title={t('reprocessTitle')} />
        <div className="px-4 pb-4">
          <p className="mb-3 text-xs text-muted-foreground">
            {/* d0d2c9d1 — a selective reprocess passes `reprocessSubset`, and the attach guard is
                `!subset && runType === 'regular'`, so it does NOT collect outstanding transactions.
                Reset-and-regenerate is the path that does, and saying so here is the only place the
                operator can act on it. */}
            {t('reprocessHint')} {t('reprocessDoesNotCollect')}
            {/* fbcf706d — the sentence above is still true of a CORRECTION and stops being true of an
                ADDITION, whose first payslip collects the one-offs already waiting for that person
                exactly as the original processing would have. Saying only the first half would now be
                a false reassurance, so the second half is stated whenever the group is on screen. */}
            {newCandidates.length > 0 && ` ${t('reprocessNewCollects')}`}
          </p>
          {/* b372e923 — `from` rides the SUBMIT, not just the address bar. The action redirects, and a
              redirect builds a brand-new URL: without this the reprocess result lands on a URL carrying
              no filter query, and every Payroll Result link the result table then draws drops the
              operator on an unfiltered list. The Remove form carries it the same way. */}
          <ReprocessForm
            batchId={batchId}
            employees={candidates}
            newCandidates={newCandidates}
            preselectedIds={preselectedIds}
            currency={currency}
            from={listFrom ?? null}
          />
        </div>
      </Card>

      {/* RECALCULATION HISTORY, moved off the run screen (point 4) rather than deleted. Here it reads as
          the record of past reprocessing on this run instead of clutter under a payslip list — one
          January run on production is carrying 37 of these entries. Nothing is deleted.
          65e2d5de — AND IT ARRIVES CLOSED. Moving it off the run screen was only half the complaint: 37
          entries, each with a statutory-line breakdown and a bases table, still buried the work the
          operator came here to do. It folds behind its own summary bar, the count stays visible while
          closed, and the choice is remembered per browser. The freshly-submitted job's result panel above
          is deliberately NOT folded — that one IS what the operator came back for. */}
      {earlier.length > 0 && (
        <Card className="overflow-hidden">
          <CollapsibleCardSection
            title={t('disclosureTitle')}
            count={earlier.length}
            toggleLabel={t('reprocessHistoryToggle')}
            cookieKey={HISTORY_OPEN_COOKIE}
            defaultOpen={historyOpen}
          >
          <p className="px-4 pt-3 pb-2 text-xs text-muted-foreground">{t('reprocessHistoryNote')}</p>
          <ul className="divide-y divide-border">
            {earlier.map((r) => {
              const d = r.diff;
              // fbcf706d — same rule as the results panel above: an entry with no previous calculation
              // is an ADDITION, and "revision ? → 1, gross 0.00 → 4,000.00" describes something that
              // never happened. Older entries all carry action 'reprocess', so they read as before.
              const isAdd = r.action === 'add';
              return (
                <li key={r.id} className="space-y-2 px-4 py-3 text-sm">
                  <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
                    <span className="font-medium">{r.employeeName}</span>
                    {r.employeeCode && <EmployeeCode code={r.employeeCode} />}
                    <span className="text-xs text-muted-foreground">
                      {isAdd
                        ? t('reprocessResultAdded')
                        : t('disclosureRevision', { before: d.versionBefore ?? '?', after: d.versionAfter ?? '?' })}
                    </span>
                    <span className="text-xs text-muted-foreground">
                      {r.at.toISOString().slice(0, 16).replace('T', ' ')}
                    </span>
                    {r.reason && (
                      <span className="text-xs text-muted-foreground">{t('disclosureReason', { reason: r.reason })}</span>
                    )}
                  </div>
                  {/* The NET pair the run screen never showed. netBefore/netAfter have been on
                      RecomputeDiff since 97a9b0ab and were rendered nowhere — the old card reported
                      gross only, so a correction that moved take-home pay by tax alone read as "no
                      change". */}
                  <p className="text-xs text-muted-foreground">
                    {isAdd ? (
                      <>
                        {t('colNet')} <span className="font-medium text-foreground">{money(d.netAfter)}</span>
                      </>
                    ) : (
                      <>
                        {t('reprocessColNetBefore')} {money(d.netBefore)} → {t('reprocessColNetAfter')}{' '}
                        <span className="font-medium text-foreground">{money(d.netAfter)}</span>
                      </>
                    )}
                  </p>

                  {isAdd ? null : d.moved.length === 0 ? (
                    <p className="text-xs text-muted-foreground">{t('disclosureNoMove')}</p>
                  ) : (
                    <>
                      <p className="text-xs text-muted-foreground">
                        {d.grossChanged
                          ? t('disclosureGrossChanged', { before: money(d.grossBefore), after: money(d.grossAfter) })
                          : t('disclosureGrossUnchanged', { gross: money(d.grossAfter) })}
                      </p>
                      <ul className="space-y-0.5">
                        {d.moved.map((m) => (
                          <li key={m.key} className="flex items-baseline justify-between gap-4 text-xs">
                            <span>{t(STATUTORY_LINE_LABEL[m.key])}</span>
                            <span className="tabular-nums">
                              <span className="text-muted-foreground">{money(m.before)}</span>
                              {' → '}
                              <span className="font-medium">{money(m.after)}</span>
                            </span>
                          </li>
                        ))}
                      </ul>
                      {/* 017d9c25 — THE WORKING BETWEEN the pay items and the answers: what each
                          agency was actually charged on. Rendered only when the AFTER computation
                          carries the stamp; a payslip written before r187 has none, and printing
                          zeroes there would state a figure nobody computed. The BEFORE column appears
                          only when it too is known AND differs, so an unchanged base stays quiet. */}
                      {d.basesAfter && (
                        <div className="rounded-md bg-muted/50 px-3 py-2 text-xs">
                          <p className="mb-1 font-medium">{t('disclosureBasesHeading')}</p>
                          <ul className="space-y-0.5">
                            {STATUTORY_BASE_KEYS.map((k) => {
                              const after = d.basesAfter![k];
                              const before = d.basesBefore?.[k] ?? null;
                              if (k === 'epfAdditional' && after === 0 && (before ?? 0) === 0) return null;
                              return (
                                <li key={k} className="flex items-baseline justify-between gap-4">
                                  <span className="text-muted-foreground">{t(STATUTORY_BASE_LABEL[k])}</span>
                                  <span className="tabular-nums">
                                    {before != null && before !== after && (
                                      <>
                                        <span className="text-muted-foreground">{money(before)}</span>
                                        {' → '}
                                      </>
                                    )}
                                    <span className="font-medium">{money(after)}</span>
                                  </span>
                                </li>
                              );
                            })}
                          </ul>
                        </div>
                      )}
                      <div className="rounded-md bg-muted/50 px-3 py-2 text-xs">
                        <p className="mb-1 font-medium">{t('disclosureCauseHeading')}</p>
                        <ul className="space-y-1 text-muted-foreground">
                          {/* Cause (a). Reported as a FACT TO CHECK, never as proof the tax moved: a
                              ruleset bump is not automatically behavioural (2026.4 → 2026.5 changed no
                              PCB band, rate or relief — it only added optional pay-code classification
                              tables that are inert unless a pay item is explicitly classified). The
                              note below carries that caveat, and must not be dropped. */}
                          {d.rulesetChanged && (
                            <li>
                              {t('disclosureCauseRuleset', {
                                before: d.before.rulesetVersion ?? '?',
                                after: d.after.rulesetVersion ?? '?',
                              })}{' '}
                              {t('disclosureCauseRulesetNote')}
                            </li>
                          )}
                          {d.rulesetUnknown && <li>{t('disclosureCauseRulesetUnknown')}</li>}
                          {/* Cause (b) — the cumulative-PCB replay. This one IS a mechanism, not a hint. */}
                          {r.priorMonths.length > 0 && (
                            <li>{t('disclosureCausePriorMonths', { periods: r.priorMonths.join(', ') })}</li>
                          )}
                          {d.causes.length === 0 && !d.rulesetUnknown && <li>{t('disclosureCauseOwnInputs')}</li>}
                        </ul>
                      </div>
                    </>
                  )}
                </li>
              );
            })}
          </ul>
          </CollapsibleCardSection>
        </Card>
      )}
    </div>
  );
}
